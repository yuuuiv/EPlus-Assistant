import { describe, expect, it } from "vitest";
import type { Account, LotteryRecord } from "../../shared/types.js";
import {
  buildAccountCountCurve,
  buildAdvancedStats,
  buildConfidenceRanking,
  buildHeatDifficulty,
  buildInvestmentReturn,
  buildMonthlyTrend,
  buildStackCountCurve,
  wilsonLowerBound
} from "./analyticsService.js";
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

describe("buildMonthlyTrend", () => {
  it("buckets by event_datetime's month and computes a won/lost win rate", () => {
    const records: LotteryRecord[] = [
      record({ id: "1", accountId: "a1", orderId: "o1", tourName: "A", status: "当選", eventDatetime: "2026-02-05T00:00:00.000Z" }),
      record({ id: "2", accountId: "a1", orderId: "o2", tourName: "A", status: "落選", eventDatetime: "2026-02-20T00:00:00.000Z" }),
      record({ id: "3", accountId: "a1", orderId: "o3", tourName: "A", status: "抽選前", eventDatetime: "2026-02-25T00:00:00.000Z" }),
      record({ id: "4", accountId: "a1", orderId: "o4", tourName: "A", status: "当選", eventDatetime: "2026-03-01T00:00:00.000Z" })
    ];
    const trend = buildMonthlyTrend(records);
    expect(trend).toEqual([
      { month: "2026-02", applications: 3, won: 1, lost: 1, winRate: 0.5 },
      { month: "2026-03", applications: 1, won: 1, lost: 0, winRate: 1 }
    ]);
  });

  it("parses eplus.jp's real free-text event_datetime format (date + weekday + doors/start times)", () => {
    const records: LotteryRecord[] = [
      record({ id: "1", accountId: "a1", orderId: "o1", tourName: "A", status: "当選", eventDatetime: "2027/01/28(木) 17:45開場 18:30開演" })
    ];
    expect(buildMonthlyTrend(records)).toEqual([{ month: "2027-01", applications: 1, won: 1, lost: 0, winRate: 1 }]);
  });

  it("skips records with no parseable event_datetime", () => {
    const records: LotteryRecord[] = [record({ id: "1", accountId: "a1", orderId: "o1", tourName: "A", status: "当選" })];
    expect(buildMonthlyTrend(records)).toEqual([]);
  });
});

describe("buildAccountCountCurve", () => {
  it("buckets performances by distinct participating accounts and whether any won", () => {
    const records: LotteryRecord[] = [
      // Performance X: 1 account, won.
      record({ id: "1", accountId: "a1", orderId: "o1", tourName: "X", eventDatetime: "Day1", status: "当選" }),
      // Performance Y: 2 accounts, one wins.
      record({ id: "2", accountId: "a1", orderId: "o2", tourName: "Y", eventDatetime: "Day1", status: "落選" }),
      record({ id: "3", accountId: "a2", orderId: "o3", tourName: "Y", eventDatetime: "Day1", status: "当選" })
    ];
    const curve = buildAccountCountCurve(records);
    expect(curve).toEqual([
      { bucketLabel: "1个", sampleSize: 1, successRate: 1 },
      { bucketLabel: "2个", sampleSize: 1, successRate: 1 }
    ]);
  });

  it("collapses account counts at or above 6 into a trailing catch-all bucket", () => {
    const records: LotteryRecord[] = Array.from({ length: 7 }, (_, index) =>
      record({ id: `r${index}`, accountId: `a${index}`, orderId: `o${index}`, tourName: "Z", eventDatetime: "Day1", status: "落選" }));
    const curve = buildAccountCountCurve(records);
    expect(curve).toEqual([{ bucketLabel: "6+个", sampleSize: 1, successRate: 0 }]);
  });
});

describe("buildStackCountCurve", () => {
  it("buckets by how many times one account applied to the same performance", () => {
    const records: LotteryRecord[] = [
      // a1 applies once to X, wins.
      record({ id: "1", accountId: "a1", orderId: "o1", tourName: "X", eventDatetime: "Day1", status: "当選" }),
      // a1 applies twice to Y, never wins.
      record({ id: "2", accountId: "a1", orderId: "o2", tourName: "Y", eventDatetime: "Day1", status: "落選" }),
      record({ id: "3", accountId: "a1", orderId: "o3", tourName: "Y", eventDatetime: "Day1", status: "落選" })
    ];
    const curve = buildStackCountCurve(records);
    expect(curve).toEqual([
      { bucketLabel: "1张", sampleSize: 1, successRate: 1 },
      { bucketLabel: "2张", sampleSize: 1, successRate: 0 }
    ]);
  });

  it("collapses stack counts at or above 5 into a trailing catch-all bucket", () => {
    const records: LotteryRecord[] = Array.from({ length: 6 }, (_, index) =>
      record({ id: `r${index}`, accountId: "a1", orderId: `o${index}`, tourName: "Z", eventDatetime: "Day1", status: "落選" }));
    const curve = buildStackCountCurve(records);
    expect(curve).toEqual([{ bucketLabel: "5+张", sampleSize: 1, successRate: 0 }]);
  });
});

describe("wilsonLowerBound", () => {
  it("returns 0 for zero trials", () => {
    expect(wilsonLowerBound(0, 0)).toBe(0);
  });

  it("shrinks a small perfect sample below a larger, slightly-imperfect one", () => {
    const luckyOneShot = wilsonLowerBound(1, 1);
    const strongTrackRecord = wilsonLowerBound(8, 10);
    expect(luckyOneShot).toBeLessThan(strongTrackRecord);
  });
});

describe("buildConfidenceRanking", () => {
  it("ranks a large strong track record above a single lucky draw despite the lower raw rate", () => {
    const accounts = [account("lucky"), account("consistent")];
    const records: LotteryRecord[] = [
      record({ id: "1", accountId: "lucky", orderId: "o1", tourName: "T", eventDatetime: "Day1", status: "当選" }),
      ...Array.from({ length: 10 }, (_, index) =>
        record({
          id: `c${index}`,
          accountId: "consistent",
          orderId: `co${index}`,
          tourName: "T",
          eventDatetime: `Day${index}`,
          status: index < 8 ? "当選" : "落選"
        }))
    ];
    const overview = buildAccountsOverview(accounts, [], records);
    const ranking = buildConfidenceRanking(overview.accounts);
    expect(ranking.map((entry) => entry.accountId)).toEqual(["consistent", "lucky"]);
    expect(ranking.find((entry) => entry.accountId === "lucky")?.rawWinRate).toBe(1);
  });

  it("excludes accounts that have never drawn", () => {
    const overview = buildAccountsOverview([account("a1")], [], []);
    expect(buildConfidenceRanking(overview.accounts)).toEqual([]);
  });
});

describe("buildInvestmentReturn", () => {
  const records: LotteryRecord[] = [
    // Tour "Big" spans two dates, 4 draws total, 1 win - passes the minimum sample size.
    record({ id: "1", accountId: "a1", orderId: "o1", tourName: "Big", eventDatetime: "Day1", status: "当選" }),
    record({ id: "2", accountId: "a2", orderId: "o2", tourName: "Big", eventDatetime: "Day1", status: "落選" }),
    record({ id: "3", accountId: "a1", orderId: "o3", tourName: "Big", eventDatetime: "Day2", status: "落選" }),
    record({ id: "4", accountId: "a2", orderId: "o4", tourName: "Big", eventDatetime: "Day2", status: "落選" }),
    // Tour "Tiny" only has 2 draws total - below the minimum sample size, should be filtered out.
    record({ id: "5", accountId: "a1", orderId: "o5", tourName: "Tiny", eventDatetime: "Day1", status: "当選" }),
    record({ id: "6", accountId: "a2", orderId: "o6", tourName: "Tiny", eventDatetime: "Day1", status: "落選" })
  ];

  it("aggregates by tour series across all its dates", () => {
    const result = buildInvestmentReturn(records, "tour");
    expect(result).toEqual([{ key: "Big", label: "Big", eventDatetime: undefined, totalDraws: 4, wonCount: 1, accountCount: 2, efficiency: 0.25 }]);
  });

  it("aggregates by single performance instead of pooling every date of a tour", () => {
    const result = buildInvestmentReturn(records, "performance");
    expect(result).toEqual([]); // each individual performance here only has 2 draws, below the minimum sample size
  });
});

describe("buildHeatDifficulty", () => {
  it("pairs each performance's total demand with the participating accounts' win rate", () => {
    const records: LotteryRecord[] = [
      record({ id: "1", accountId: "a1", orderId: "o1", tourName: "X", eventDatetime: "Day1", status: "当選" }),
      record({ id: "2", accountId: "a2", orderId: "o2", tourName: "X", eventDatetime: "Day1", status: "落選" }),
      record({ id: "3", accountId: "a3", orderId: "o3", tourName: "X", eventDatetime: "Day1", status: "落選" })
    ];
    const points = buildHeatDifficulty(records);
    expect(points).toEqual([{ performanceKey: "X||Day1", tourName: "X", eventDatetime: "Day1", totalDraws: 3, accountCount: 3, participantWinRate: 1 / 3 }]);
  });
});

describe("buildAdvancedStats", () => {
  it("assembles all six analyses without throwing on an empty dataset", () => {
    const advanced = buildAdvancedStats([], []);
    expect(advanced).toEqual({
      monthlyTrend: [],
      accountCountCurve: [],
      stackCountCurve: [],
      confidenceRanking: [],
      tourInvestmentReturn: [],
      performanceInvestmentReturn: [],
      heatDifficulty: []
    });
  });
});
