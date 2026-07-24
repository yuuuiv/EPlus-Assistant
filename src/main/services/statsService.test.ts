import { describe, expect, it } from "vitest";
import type { Account, AccountProfile, LotteryRecord } from "../../shared/types.js";
import { buildAccountsOverview } from "./statsService.js";

function account(id: string, overrides: Partial<Account> = {}): Account {
  return {
    id,
    label: id,
    eplusEmail: `${id}@example.test`,
    mailProviderId: "manual",
    tags: [],
    enabled: true,
    lastLoginStatus: "Unknown",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides
  };
}

function record(overrides: Partial<LotteryRecord> & Pick<LotteryRecord, "id" | "accountId" | "orderId" | "tourName" | "status">): LotteryRecord {
  return { eventDatetime: undefined, harvestedAt: "2026-01-01T00:00:00.000Z", ...overrides };
}

describe("buildAccountsOverview", () => {
  it("counts a two-day tour as two performances, and repeat draws for one day as one performance", () => {
    const records: LotteryRecord[] = [
      record({ id: "1", accountId: "a1", orderId: "o1", tourName: "Tour", eventDatetime: "Day 1", status: "落選" }),
      record({ id: "2", accountId: "a1", orderId: "o2", tourName: "Tour", eventDatetime: "Day 1", status: "当選", orderDatetime: "2026-02-02T00:00:00.000Z" }),
      record({ id: "3", accountId: "a1", orderId: "o3", tourName: "Tour", eventDatetime: "Day 2", status: "落選" })
    ];
    const overview = buildAccountsOverview([account("a1")], [], records);
    const stats = overview.accounts[0]!.stats;
    expect(stats.distinctPerformanceCount).toBe(2);
    expect(stats.wonPerformanceCount).toBe(1);
    expect(stats.winCount).toBe(1);
    expect(stats.winRate).toBeCloseTo(0.5);
    expect(stats.performances.find((p) => p.eventDatetime === "Day 1")?.records).toHaveLength(2);
  });

  it("computes gender breakdown and an aggregate win rate across accounts", () => {
    const accounts = [account("a1"), account("a2")];
    const profiles: AccountProfile[] = [
      { accountId: "a1", eplusEmail: "a1@example.test", encryptedPassword: "", revealSupported: false, gender: "女性", companions: [], pastCompanions: [], harvestedAt: "", harvestStatus: "Ok" }
    ];
    const records: LotteryRecord[] = [
      record({ id: "1", accountId: "a1", orderId: "o1", tourName: "A", status: "当選" }),
      record({ id: "2", accountId: "a2", orderId: "o2", tourName: "B", status: "落選" })
    ];
    const overview = buildAccountsOverview(accounts, profiles, records);
    expect(overview.totalAccounts).toBe(2);
    expect(overview.genderBreakdown).toEqual({ "女性": 1, "未知": 1 });
    expect(overview.totalDistinctPerformances).toBe(2);
    expect(overview.totalWonPerformances).toBe(1);
    expect(overview.overallWinRate).toBeCloseTo(0.5);
  });

  it("returns a null win rate for an account that has never drawn", () => {
    const overview = buildAccountsOverview([account("a1")], [], []);
    expect(overview.accounts[0]!.stats.winRate).toBeNull();
    expect(overview.overallWinRate).toBeNull();
  });

  it("computes the record outcome breakdown and top-drawn performances across accounts", () => {
    const accounts = [account("a1"), account("a2")];
    const records: LotteryRecord[] = [
      record({ id: "1", accountId: "a1", orderId: "o1", tourName: "Popular Tour", eventDatetime: "Day 1", status: "当選", orderDatetime: "2026-03-01T00:00:00.000Z" }),
      record({ id: "2", accountId: "a2", orderId: "o2", tourName: "Popular Tour", eventDatetime: "Day 1", status: "落選", orderDatetime: "2026-03-02T00:00:00.000Z" }),
      record({ id: "3", accountId: "a1", orderId: "o3", tourName: "Niche Tour", eventDatetime: "Day 1", status: "抽選前", orderDatetime: "2026-01-01T00:00:00.000Z" })
    ];
    const overview = buildAccountsOverview(accounts, [], records);
    expect(overview.recordOutcomeBreakdown).toEqual({ won: 1, lost: 1, pending: 1 });
    expect(overview.topPerformances[0]).toMatchObject({ tourName: "Popular Tour", totalDraws: 2, accountCount: 2 });
    expect(overview.recentActivity[0]?.id).toBe("2");
  });

  it("falls back to event_datetime for recency when order_datetime is blank (the collector's common case)", () => {
    const records: LotteryRecord[] = [
      record({ id: "1", accountId: "a1", orderId: "o1", tourName: "A", status: "落選", eventDatetime: "2024/01/10(水) 17:00開場 18:00開演" }),
      record({ id: "2", accountId: "a1", orderId: "o2", tourName: "B", status: "当選", eventDatetime: "2026/05/20(水) 17:00開場 18:00開演" }),
      record({ id: "3", accountId: "a1", orderId: "o3", tourName: "C", status: "落選", eventDatetime: "2025/03/03(月) 17:00開場 18:00開演" })
    ];
    // All three share the same (blank) order_datetime and the same harvested_at/created_at, i.e.
    // no signal that isn't event_datetime distinguishes them - this used to leave them in
    // whatever arbitrary order the query happened to return (see statsService.ts's byRecency).
    const overview = buildAccountsOverview([account("a1")], [], records);
    expect(overview.recentActivity.map((r) => r.id)).toEqual(["2", "3", "1"]);
  });

  it("ranks top performances by distinct account count rather than raw draw count, with a per-account breakdown", () => {
    const records: LotteryRecord[] = [
      // "Wide Reach": 3 different accounts drawing once each.
      record({ id: "1", accountId: "a1", orderId: "o1", tourName: "Wide Reach", eventDatetime: "Day1", status: "落選" }),
      record({ id: "2", accountId: "a2", orderId: "o2", tourName: "Wide Reach", eventDatetime: "Day1", status: "当選" }),
      record({ id: "3", accountId: "a3", orderId: "o3", tourName: "Wide Reach", eventDatetime: "Day1", status: "落選" }),
      // "Stacked": a single account applying 4 times - more total draws, but only 1 account.
      record({ id: "4", accountId: "a1", orderId: "o4", tourName: "Stacked", eventDatetime: "Day1", status: "落選" }),
      record({ id: "5", accountId: "a1", orderId: "o5", tourName: "Stacked", eventDatetime: "Day1", status: "落選" }),
      record({ id: "6", accountId: "a1", orderId: "o6", tourName: "Stacked", eventDatetime: "Day1", status: "落選" }),
      record({ id: "7", accountId: "a1", orderId: "o7", tourName: "Stacked", eventDatetime: "Day1", status: "当選" })
    ];
    const overview = buildAccountsOverview([account("a1"), account("a2"), account("a3")], [], records);
    // "Stacked" has more total draws (4 vs 3), but "Wide Reach" reaches more accounts (3 vs 1) and
    // should rank first now that the panel ranks by account count, not draw count.
    expect(overview.topPerformances.map((p) => p.tourName)).toEqual(["Wide Reach", "Stacked"]);

    const wideReach = overview.topPerformances[0]!;
    expect(wideReach.accountCount).toBe(3);
    expect(wideReach.accounts).toEqual([
      { accountId: "a1", totalDraws: 1, outcome: "lost" },
      { accountId: "a2", totalDraws: 1, outcome: "won" },
      { accountId: "a3", totalDraws: 1, outcome: "lost" }
    ]);

    const stacked = overview.topPerformances[1]!;
    expect(stacked.totalDraws).toBe(4);
    expect(stacked.accounts).toEqual([{ accountId: "a1", totalDraws: 4, outcome: "won" }]);
  });
});
