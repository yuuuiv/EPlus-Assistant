import type {
  AccountOverviewEntry,
  AdvancedStats,
  BucketRatePoint,
  ConfidenceRankedEntry,
  InvestmentReturnEntry,
  LotteryRecord,
  MonthlyTrendPoint,
  PerformanceHeatPoint
} from "../../shared/types.js";
import { classifyOutcome, performanceKey } from "./statsService.js";

/** Series/performance groups with fewer entries than this are noise, not signal - dropped from
 *  the investment-return rankings rather than shown with a misleadingly extreme ratio. */
const MIN_INVESTMENT_SAMPLE = 3;
/** Matches the existing win-rate ranking's top-15 cutoff (see AccountOverview.tsx). */
const RANKING_LIMIT = 15;
/** 95% confidence Wilson score z-value. */
const WILSON_Z = 1.96;

/** event_datetime comes straight off the eplus.jp page as free text like
 *  "2027/01/28(木) 17:45開場 18:30開演" - not something `new Date()` can be trusted to parse
 *  consistently. The leading "YYYY/MM/DD" is the one structured part every observed format
 *  carries, so pull the month from that directly instead of parsing the whole string. */
function monthKey(value: string): string | undefined {
  const structured = /^(\d{4})\/(\d{2})/.exec(value);
  if (structured) return `${structured[1]}-${structured[2]}`;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return undefined;
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

/** Monthly application volume and win rate, bucketed by event_datetime (when the show itself
 *  happens) - order_datetime would be the more natural "when did I act" signal, but the
 *  collector doesn't reliably capture it, so event month is what's actually available. Records
 *  without a parseable event_datetime are skipped - there's no meaningful month to bucket them
 *  into. */
export function buildMonthlyTrend(records: readonly LotteryRecord[]): MonthlyTrendPoint[] {
  const buckets = new Map<string, { applications: number; won: number; lost: number }>();
  for (const record of records) {
    if (!record.eventDatetime) continue;
    const key = monthKey(record.eventDatetime);
    if (!key) continue;
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { applications: 0, won: 0, lost: 0 };
      buckets.set(key, bucket);
    }
    bucket.applications += 1;
    const outcome = classifyOutcome(record.status);
    if (outcome === "won") bucket.won += 1;
    else if (outcome === "lost") bucket.lost += 1;
  }
  return Array.from(buckets.entries())
    .map(([month, bucket]): MonthlyTrendPoint => ({
      month,
      applications: bucket.applications,
      won: bucket.won,
      lost: bucket.lost,
      winRate: bucket.won + bucket.lost === 0 ? null : bucket.won / (bucket.won + bucket.lost)
    }))
    .sort((a, b) => a.month.localeCompare(b.month));
}

interface CrossAccountPerformanceGroup {
  readonly performanceKey: string;
  readonly tourName: string;
  readonly eventDatetime?: string;
  readonly totalDraws: number;
  readonly accountIds: ReadonlySet<string>;
  readonly wonAccountIds: ReadonlySet<string>;
}

/** Groups records the same way buildTopPerformances does (by performanceKey, across every
 *  account), but also tracks which accounts actually won - the shared basis for both the
 *  account-count curve and the heat/difficulty scatter. */
function groupPerformancesAcrossAccounts(records: readonly LotteryRecord[]): CrossAccountPerformanceGroup[] {
  const groups = new Map<string, { tourName: string; eventDatetime?: string; totalDraws: number; accountIds: Set<string>; wonAccountIds: Set<string> }>();
  for (const record of records) {
    const key = performanceKey(record);
    let group = groups.get(key);
    if (!group) {
      group = { tourName: record.tourName, eventDatetime: record.eventDatetime, totalDraws: 0, accountIds: new Set(), wonAccountIds: new Set() };
      groups.set(key, group);
    }
    group.totalDraws += 1;
    group.accountIds.add(record.accountId);
    if (classifyOutcome(record.status) === "won") group.wonAccountIds.add(record.accountId);
  }
  return Array.from(groups.entries()).map(([key, group]) => ({ performanceKey: key, ...group }));
}

/** Buckets (count, success) pairs into an ordered dose-response curve. Counts at or above
 *  catchAllFrom collapse into one trailing "N+" bucket so a handful of outliers don't produce a
 *  long tail of single-sample buckets. */
function buildBucketRateCurve(
  items: readonly { readonly count: number; readonly success: boolean }[],
  catchAllFrom: number,
  formatLabel: (bucketValue: number, isCatchAll: boolean) => string
): BucketRatePoint[] {
  const buckets = new Map<number, { total: number; won: number }>();
  for (const item of items) {
    const bucketKey = Math.min(item.count, catchAllFrom);
    let bucket = buckets.get(bucketKey);
    if (!bucket) {
      bucket = { total: 0, won: 0 };
      buckets.set(bucketKey, bucket);
    }
    bucket.total += 1;
    if (item.success) bucket.won += 1;
  }
  return Array.from(buckets.entries())
    .sort(([a], [b]) => a - b)
    .map(([bucketKey, bucket]): BucketRatePoint => ({
      bucketLabel: formatLabel(bucketKey, bucketKey >= catchAllFrom),
      sampleSize: bucket.total,
      successRate: bucket.total === 0 ? null : bucket.won / bucket.total
    }));
}

/** For each performance, how many distinct accounts drew for it, versus whether any of them
 *  won - an empirical (observational, not controlled) view of the payoff from running more
 *  accounts at once against the same performance. */
export function buildAccountCountCurve(records: readonly LotteryRecord[]): BucketRatePoint[] {
  const items = groupPerformancesAcrossAccounts(records).map((group) => ({
    count: group.accountIds.size,
    success: group.wonAccountIds.size > 0
  }));
  return buildBucketRateCurve(items, 6, (value, isCatchAll) => (isCatchAll ? `${value}+个` : `${value}个`));
}

/** For each (account, performance) pair, how many times that account applied versus whether it
 *  ever won - the dose-response curve for "does stacking more entries on one performance help". */
export function buildStackCountCurve(records: readonly LotteryRecord[]): BucketRatePoint[] {
  const groups = new Map<string, { count: number; won: boolean }>();
  for (const record of records) {
    const key = `${record.accountId}||${performanceKey(record)}`;
    let group = groups.get(key);
    if (!group) {
      group = { count: 0, won: false };
      groups.set(key, group);
    }
    group.count += 1;
    if (classifyOutcome(record.status) === "won") group.won = true;
  }
  const items = Array.from(groups.values()).map((group) => ({ count: group.count, success: group.won }));
  return buildBucketRateCurve(items, 5, (value, isCatchAll) => (isCatchAll ? `${value}+张` : `${value}张`));
}

/** Wilson score interval lower bound: shrinks a raw ratio toward the uncertain middle in
 *  proportion to how few trials it's based on, so a 1-for-1 account doesn't outrank a genuinely
 *  strong 20-for-30 one. Standard formula, 95% confidence by default. */
export function wilsonLowerBound(successes: number, trials: number, z: number = WILSON_Z): number {
  if (trials === 0) return 0;
  const p = successes / trials;
  const z2 = z * z;
  const center = p + z2 / (2 * trials);
  const margin = z * Math.sqrt((p * (1 - p)) / trials + z2 / (4 * trials * trials));
  const denominator = 1 + z2 / trials;
  return (center - margin) / denominator;
}

/** Re-ranks the accounts already scored in AccountOverviewEntry by Wilson lower bound instead
 *  of raw win rate - same underlying win/draw counts, sturdier ranking. */
export function buildConfidenceRanking(entries: readonly AccountOverviewEntry[]): ConfidenceRankedEntry[] {
  return entries
    .filter((entry) => entry.stats.distinctPerformanceCount > 0)
    .map((entry): ConfidenceRankedEntry => ({
      accountId: entry.account.id,
      label: entry.account.label || entry.account.eplusEmail,
      trials: entry.stats.distinctPerformanceCount,
      rawWinRate: entry.stats.winRate,
      adjustedScore: wilsonLowerBound(entry.stats.wonPerformanceCount, entry.stats.distinctPerformanceCount)
    }))
    .sort((a, b) => (b.adjustedScore ?? 0) - (a.adjustedScore ?? 0))
    .slice(0, RANKING_LIMIT);
}

/** Total entries invested versus wins, grouped either by tour series (every date of a tour
 *  pooled together) or by a single performance. Thin groups (see MIN_INVESTMENT_SAMPLE) are
 *  dropped as too noisy to rank meaningfully. */
export function buildInvestmentReturn(records: readonly LotteryRecord[], groupBy: "tour" | "performance"): InvestmentReturnEntry[] {
  interface Group {
    label: string;
    eventDatetime?: string;
    totalDraws: number;
    wonCount: number;
    accountIds: Set<string>;
  }
  const groups = new Map<string, Group>();
  for (const record of records) {
    const key = groupBy === "tour" ? record.tourName : performanceKey(record);
    let group = groups.get(key);
    if (!group) {
      group = { label: record.tourName, eventDatetime: groupBy === "performance" ? record.eventDatetime : undefined, totalDraws: 0, wonCount: 0, accountIds: new Set() };
      groups.set(key, group);
    }
    group.totalDraws += 1;
    group.accountIds.add(record.accountId);
    if (classifyOutcome(record.status) === "won") group.wonCount += 1;
  }
  return Array.from(groups.entries())
    .map(([key, group]): InvestmentReturnEntry => ({
      key,
      label: group.label,
      eventDatetime: group.eventDatetime,
      totalDraws: group.totalDraws,
      wonCount: group.wonCount,
      accountCount: group.accountIds.size,
      efficiency: group.totalDraws === 0 ? null : group.wonCount / group.totalDraws
    }))
    .filter((entry) => entry.totalDraws >= MIN_INVESTMENT_SAMPLE)
    .sort((a, b) => (b.efficiency ?? 0) - (a.efficiency ?? 0))
    .slice(0, RANKING_LIMIT);
}

/** Each performance's demand (total draws across every account) against how favorable the odds
 *  actually were for the accounts that participated - lets "hyped" performances and "genuinely
 *  hard" ones be told apart instead of assumed to be the same thing. */
export function buildHeatDifficulty(records: readonly LotteryRecord[]): PerformanceHeatPoint[] {
  return groupPerformancesAcrossAccounts(records)
    .filter((group) => group.accountIds.size > 0)
    .map((group): PerformanceHeatPoint => ({
      performanceKey: group.performanceKey,
      tourName: group.tourName,
      eventDatetime: group.eventDatetime,
      totalDraws: group.totalDraws,
      accountCount: group.accountIds.size,
      participantWinRate: group.wonAccountIds.size / group.accountIds.size
    }))
    .sort((a, b) => b.totalDraws - a.totalDraws);
}

export function buildAdvancedStats(entries: readonly AccountOverviewEntry[], records: readonly LotteryRecord[]): AdvancedStats {
  return {
    monthlyTrend: buildMonthlyTrend(records),
    accountCountCurve: buildAccountCountCurve(records),
    stackCountCurve: buildStackCountCurve(records),
    confidenceRanking: buildConfidenceRanking(entries),
    tourInvestmentReturn: buildInvestmentReturn(records, "tour"),
    performanceInvestmentReturn: buildInvestmentReturn(records, "performance"),
    heatDifficulty: buildHeatDifficulty(records)
  };
}
