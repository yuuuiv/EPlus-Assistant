import type {
  Account,
  AccountLotteryStats,
  AccountOverviewEntry,
  AccountProfile,
  AccountsOverview,
  LotteryOutcome,
  LotteryRecord,
  PerformanceHistory,
  TopPerformanceAccountEntry,
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

/** eplus.jp's free-text event_datetime ("2027/01/28(木) 17:45開場 18:30開演") isn't something
 *  `Date.parse` can be trusted with directly, but the leading "YYYY/MM/DD" plus its first HH:MM
 *  (doors-open time) is structured in every observed format - same trick as analyticsService.ts's
 *  monthKey, just keeping time-of-day too since this feeds a finer-grained sort, not a month
 *  bucket. */
const EVENT_DATETIME_PATTERN = /^(\d{4})\/(\d{2})\/(\d{2}).*?(\d{1,2}):(\d{2})/;
function parseEventDatetime(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const match = EVENT_DATETIME_PATTERN.exec(value);
  if (match) {
    const [, year, month, day, hour, minute] = match;
    const time = new Date(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute)).getTime();
    return Number.isNaN(time) ? undefined : time;
  }
  const fallback = Date.parse(value);
  return Number.isNaN(fallback) ? undefined : fallback;
}

/** More recent first: order_datetime is the site's own application timestamp, so it's the best
 *  signal for which of several draws against the same performance is the "current" one - but the
 *  collector doesn't reliably capture it (every record observed so far has it blank), which used
 *  to make this comparator treat every pair as tied and fall through to whatever arbitrary order
 *  the underlying query/merge happened to produce (visible as a shuffled "recent activity" feed).
 *  Falls back to event_datetime, a real (if imperfect - it's when the show happens, not when the
 *  entry was submitted) chronological signal that's actually populated. */
function byRecency(a: LotteryRecord, b: LotteryRecord): number {
  const aTime = Date.parse(a.orderDatetime ?? "");
  const bTime = Date.parse(b.orderDatetime ?? "");
  if (!Number.isNaN(aTime) && !Number.isNaN(bTime)) return bTime - aTime;
  if (!Number.isNaN(aTime)) return -1;
  if (!Number.isNaN(bTime)) return 1;
  const aEvent = parseEventDatetime(a.eventDatetime);
  const bEvent = parseEventDatetime(b.eventDatetime);
  if (aEvent !== undefined && bEvent !== undefined) return bEvent - aEvent;
  if (aEvent !== undefined) return -1;
  if (bEvent !== undefined) return 1;
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
    .map(([key, group]): TopPerformanceEntry => {
      const recordsByAccount = new Map<string, LotteryRecord[]>();
      for (const record of group.records) {
        const bucket = recordsByAccount.get(record.accountId);
        if (bucket) bucket.push(record);
        else recordsByAccount.set(record.accountId, [record]);
      }
      const accounts: TopPerformanceAccountEntry[] = Array.from(recordsByAccount.entries())
        .map(([accountId, accountRecords]): TopPerformanceAccountEntry => {
          const outcomes = accountRecords.map((record) => classifyOutcome(record.status));
          const outcome: LotteryOutcome = outcomes.includes("won") ? "won" : outcomes.includes("lost") ? "lost" : "pending";
          return { accountId, totalDraws: accountRecords.length, outcome };
        })
        .sort((a, b) => b.totalDraws - a.totalDraws);
      return {
        performanceKey: key,
        tourName: group.tourName,
        eventDatetime: group.eventDatetime,
        totalDraws: group.records.length,
        accountCount: group.accountIds.size,
        accounts
      };
    })
    // Most accounts drawing for it first (the "hottest by reach" ranking), draw-count as a
    // tiebreaker for performances tied on account count.
    .sort((a, b) => b.accountCount - a.accountCount || b.totalDraws - a.totalDraws);
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
