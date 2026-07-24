import type {
  Account,
  AccountLotteryStats,
  AccountOverviewEntry,
  AccountProfile,
  AccountsOverview,
  LotteryOutcome,
  LotteryRecord,
  PerformanceHistory,
  TopPerformanceEntry
} from "../../shared/types.js";
import { buildAdvancedStats } from "./analyticsService.js";

const RECENT_ACTIVITY_LIMIT = 8;

const UNKNOWN_GENDER = "未知";

export function classifyOutcome(status: string): LotteryOutcome {
  if (status.includes("当選")) return "won";
  if (status.includes("落選")) return "lost";
  return "pending";
}

/** Groups by tour + event date/time so a two-day tour's two days count as two performances,
 *  while repeat/extra lottery applications for the same day merge into one performance. Falls
 *  back to reception/venue name when a record has no event date/time to key on. Exported so
 *  analyticsService.ts groups performances the same way instead of re-deriving the definition. */
export function performanceKey(record: LotteryRecord): string {
  return `${record.tourName}||${record.eventDatetime || record.receptionName || record.venueName || ""}`;
}

/** More recent first: order_datetime is the site's own application timestamp, so it's the best
 *  signal for which of several draws against the same performance is the "current" one. Falls
 *  back to string comparison when it isn't a parseable date (format isn't guaranteed). */
function byRecency(a: LotteryRecord, b: LotteryRecord): number {
  const aTime = Date.parse(a.orderDatetime ?? "");
  const bTime = Date.parse(b.orderDatetime ?? "");
  if (!Number.isNaN(aTime) && !Number.isNaN(bTime)) return bTime - aTime;
  return (b.orderDatetime ?? "").localeCompare(a.orderDatetime ?? "");
}

function buildPerformances(records: readonly LotteryRecord[]): PerformanceHistory[] {
  const groups = new Map<string, LotteryRecord[]>();
  for (const record of records) {
    const key = performanceKey(record);
    const bucket = groups.get(key);
    if (bucket) bucket.push(record);
    else groups.set(key, [record]);
  }
  return Array.from(groups.entries())
    .map(([key, group]): PerformanceHistory => {
      const sorted = [...group].sort(byRecency);
      const lastRecord = sorted[0]!;
      return {
        performanceKey: key,
        tourName: lastRecord.tourName,
        eventDatetime: lastRecord.eventDatetime,
        venueName: lastRecord.venueName,
        receptionName: lastRecord.receptionName,
        records: sorted,
        lastRecord,
        lastOutcome: classifyOutcome(lastRecord.status),
        wonAtLeastOnce: group.some((record) => classifyOutcome(record.status) === "won")
      };
    })
    .sort(byRecencyOfGroup);
}

function byRecencyOfGroup(a: PerformanceHistory, b: PerformanceHistory): number {
  return byRecency(a.lastRecord, b.lastRecord);
}

function buildAccountStats(records: readonly LotteryRecord[]): AccountLotteryStats {
  const performances = buildPerformances(records);
  const winCount = records.filter((record) => classifyOutcome(record.status) === "won").length;
  const wonPerformanceCount = performances.filter((performance) => performance.wonAtLeastOnce).length;
  return {
    winCount,
    distinctPerformanceCount: performances.length,
    wonPerformanceCount,
    winRate: performances.length === 0 ? null : wonPerformanceCount / performances.length,
    performances
  };
}

function buildTopPerformances(records: readonly LotteryRecord[]): TopPerformanceEntry[] {
  const groups = new Map<string, { tourName: string; eventDatetime?: string; records: LotteryRecord[]; accountIds: Set<string> }>();
  for (const record of records) {
    const key = performanceKey(record);
    let group = groups.get(key);
    if (!group) {
      group = { tourName: record.tourName, eventDatetime: record.eventDatetime, records: [], accountIds: new Set() };
      groups.set(key, group);
    }
    group.records.push(record);
    group.accountIds.add(record.accountId);
  }
  return Array.from(groups.entries())
    .map(([key, group]): TopPerformanceEntry => ({
      performanceKey: key,
      tourName: group.tourName,
      eventDatetime: group.eventDatetime,
      totalDraws: group.records.length,
      accountCount: group.accountIds.size
    }))
    .sort((a, b) => b.totalDraws - a.totalDraws);
}

export function buildAccountsOverview(
  accounts: readonly Account[],
  profiles: readonly AccountProfile[],
  records: readonly LotteryRecord[]
): AccountsOverview {
  const profileByAccount = new Map(profiles.map((profile) => [profile.accountId, profile]));
  const recordsByAccount = new Map<string, LotteryRecord[]>();
  for (const record of records) {
    const bucket = recordsByAccount.get(record.accountId);
    if (bucket) bucket.push(record);
    else recordsByAccount.set(record.accountId, [record]);
  }

  const genderBreakdown: Record<string, number> = {};
  const entries: AccountOverviewEntry[] = accounts.map((account) => {
    const gender = profileByAccount.get(account.id)?.gender || undefined;
    genderBreakdown[gender || UNKNOWN_GENDER] = (genderBreakdown[gender || UNKNOWN_GENDER] ?? 0) + 1;
    return { account, gender, stats: buildAccountStats(recordsByAccount.get(account.id) ?? []) };
  });

  const totalWinCount = entries.reduce((sum, entry) => sum + entry.stats.winCount, 0);
  const totalDistinctPerformances = entries.reduce((sum, entry) => sum + entry.stats.distinctPerformanceCount, 0);
  const totalWonPerformances = entries.reduce((sum, entry) => sum + entry.stats.wonPerformanceCount, 0);

  const recordOutcomeBreakdown: Record<LotteryOutcome, number> = { won: 0, lost: 0, pending: 0 };
  for (const record of records) recordOutcomeBreakdown[classifyOutcome(record.status)] += 1;

  const recentActivity = [...records].sort(byRecency).slice(0, RECENT_ACTIVITY_LIMIT);

  return {
    totalAccounts: accounts.length,
    genderBreakdown,
    totalWinCount,
    totalDistinctPerformances,
    totalWonPerformances,
    overallWinRate: totalDistinctPerformances === 0 ? null : totalWonPerformances / totalDistinctPerformances,
    recordOutcomeBreakdown,
    recentActivity,
    topPerformances: buildTopPerformances(records),
    accounts: entries,
    advanced: buildAdvancedStats(entries, records)
  };
}
