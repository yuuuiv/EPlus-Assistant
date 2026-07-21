import { randomUUID } from "node:crypto";
import type { ApplicationRecord, LotteryResultRecord } from "../../shared/types.js";
import { EplusBrowserAdapter } from "../adapters/eplusAdapter.js";
import { BrowserEngineFailure, type BrowserSessionEngine } from "../engines/browserSessionEngine.js";
import type { AppDatabase } from "../storage/database.js";

export class RecordRefreshService {
  constructor(
    private readonly engine: BrowserSessionEngine,
    private readonly adapter: EplusBrowserAdapter,
    private readonly db: AppDatabase
  ) {}

  async refreshApplicationRecords(accountId: string): Promise<ApplicationRecord[]> {
    await this.prepareSession(accountId);
    await this.adapter.openApplicationHistory();
    const harvestedAt = new Date().toISOString();
    const records = (await this.adapter.readApplicationHistory()).map((record) => ({ id: randomUUID(), accountId, harvestedAt, ...record }));
    records.forEach((record) => this.db.addApplicationRecord(record));
    return records;
  }

  async refreshLotteryResults(accountId: string): Promise<LotteryResultRecord[]> {
    await this.prepareSession(accountId);
    await this.adapter.openLotteryResults();
    const harvestedAt = new Date().toISOString();
    const records = (await this.adapter.readLotteryResults()).map((record) => ({ id: randomUUID(), accountId, harvestedAt, ...record }));
    records.forEach((record) => this.db.addLotteryResult(record));
    return records;
  }

  private async prepareSession(accountId: string): Promise<void> {
    if (this.engine.isSessionActive() && (await this.engine.reuseSession())) return;
    if (this.engine.isSessionActive()) await this.engine.close();
    await this.engine.startSession(accountId);
    const state = await this.adapter.detectChallenge();
    if (state === "Login" || state === "EmailCode") {
      throw new BrowserEngineFailure("ManualTakeoverRequired", "An interactive login is required.");
    }
  }
}
