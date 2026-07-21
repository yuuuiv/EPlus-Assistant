import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EplusBrowserAdapter } from "../adapters/eplusAdapter.js";
import { BrowserEngineFailure, BrowserSessionEngine } from "../engines/browserSessionEngine.js";
import { AppDatabase } from "../storage/database.js";
import { RecordRefreshService } from "./recordRefresh.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("RecordRefreshService", () => {
  it("refreshes application records and persists the updated records", async () => {
    const { database, accountId } = await fixture();
    const { engine, adapter } = browserFixture();
    vi.spyOn(adapter, "readApplicationHistory").mockResolvedValue([{ eventTitle: "Concert", appliedAt: "2026-07-21T00:00:00.000Z", ticketType: "General", quantity: 2, applicationId: "application-1", status: "Applied" }]);

    const records = await new RecordRefreshService(engine, adapter, database).refreshApplicationRecords(accountId);

    expect(records).toMatchObject([{ eventTitle: "Concert", status: "Applied" }]);
    expect(database.listApplicationRecords(accountId)).toMatchObject([{ applicationId: "application-1" }]);
  });

  it("refreshes lottery results and persists the updated results", async () => {
    const { database, accountId } = await fixture();
    const { engine, adapter } = browserFixture();
    vi.spyOn(adapter, "readLotteryResults").mockResolvedValue([{ eventTitle: "Concert", resultKind: "中選", applicationId: "application-1", decidedAt: "2026-07-21T00:00:00.000Z" }]);

    const records = await new RecordRefreshService(engine, adapter, database).refreshLotteryResults(accountId);

    expect(records).toMatchObject([{ eventTitle: "Concert", resultKind: "中選" }]);
    expect(database.listLotteryResults(accountId)).toMatchObject([{ applicationId: "application-1" }]);
  });

  it("upserts application records by account, title, and application ID", async () => {
    const { database, accountId } = await fixture();
    const { engine, adapter } = browserFixture();
    const read = vi.spyOn(adapter, "readApplicationHistory");
    read.mockResolvedValueOnce([{ eventTitle: "Concert", appliedAt: "2026-07-21T00:00:00.000Z", ticketType: "General", quantity: 1, applicationId: "application-1", status: "Applied" }]);
    read.mockResolvedValueOnce([{ eventTitle: "Concert", appliedAt: "2026-07-22T00:00:00.000Z", ticketType: "General", quantity: 2, applicationId: "application-1", status: "Won" }]);
    const service = new RecordRefreshService(engine, adapter, database);

    await service.refreshApplicationRecords(accountId);
    await service.refreshApplicationRecords(accountId);

    expect(database.listApplicationRecords(accountId)).toMatchObject([{ quantity: 2, status: "Won" }]);
    expect(database.listApplicationRecords(accountId)).toHaveLength(1);
  });

  it("upserts lottery results by account, title, and application ID", async () => {
    const { database, accountId } = await fixture();
    const { engine, adapter } = browserFixture();
    const read = vi.spyOn(adapter, "readLotteryResults");
    read.mockResolvedValueOnce([{ eventTitle: "Concert", resultKind: "待通知", applicationId: "application-1" }]);
    read.mockResolvedValueOnce([{ eventTitle: "Concert", resultKind: "中選", applicationId: "application-1", paymentDeadline: "2026-07-30" }]);
    const service = new RecordRefreshService(engine, adapter, database);

    await service.refreshLotteryResults(accountId);
    await service.refreshLotteryResults(accountId);

    expect(database.listLotteryResults(accountId)).toMatchObject([{ resultKind: "中選", paymentDeadline: "2026-07-30" }]);
    expect(database.listLotteryResults(accountId)).toHaveLength(1);
  });

  it("requires manual action when CAPTCHA interrupts a refresh", async () => {
    const { database, accountId } = await fixture();
    const { engine, adapter } = browserFixture();
    vi.spyOn(adapter, "openLotteryResults").mockRejectedValue(new BrowserEngineFailure("ManualTakeoverRequired", "CAPTCHA"));

    await expect(new RecordRefreshService(engine, adapter, database).refreshLotteryResults(accountId)).rejects.toMatchObject({ code: "ManualTakeoverRequired" });
  });

  it("requires manual action when the refresh session lands on an unknown page", async () => {
    const { database, accountId } = await fixture();
    const { engine, adapter } = browserFixture();
    vi.spyOn(engine, "reuseSession").mockResolvedValue(false);
    vi.spyOn(engine, "close").mockResolvedValue();
    vi.spyOn(engine, "startSession").mockResolvedValue();
    vi.spyOn(adapter, "detectChallenge").mockResolvedValue("Login");

    await expect(new RecordRefreshService(engine, adapter, database).refreshApplicationRecords(accountId)).rejects.toMatchObject({ code: "ManualTakeoverRequired" });
  });
});

async function fixture(): Promise<{ database: AppDatabase; accountId: string }> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "eplus-record-refresh-"));
  directories.push(directory);
  const database = new AppDatabase(directory);
  await database.open();
  const account = database.upsertAccount({ eplusEmail: "member@example.test", password: "unused", encryptedPassword: "encrypted", encryptedMailConfig: "mail" });
  return { database, accountId: account.id };
}

function browserFixture(): { engine: BrowserSessionEngine; adapter: EplusBrowserAdapter } {
  const engine = Object.create(BrowserSessionEngine.prototype) as BrowserSessionEngine;
  vi.spyOn(engine, "isSessionActive").mockReturnValue(true);
  vi.spyOn(engine, "reuseSession").mockResolvedValue(true);
  const adapter = Object.create(EplusBrowserAdapter.prototype) as EplusBrowserAdapter;
  vi.spyOn(adapter, "openApplicationHistory").mockResolvedValue();
  vi.spyOn(adapter, "openLotteryResults").mockResolvedValue();
  return { engine, adapter };
}
