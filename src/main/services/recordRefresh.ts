import { randomUUID } from "node:crypto";
import type { ApplicationRecord, LotteryResultRecord } from "../../shared/types.js";
import { EplusBrowserAdapter } from "../adapters/eplusAdapter.js";
import { BrowserEngineFailure, type BrowserSessionEngine } from "../engines/browserSessionEngine.js";
import type { AppDatabase } from "../storage/database.js";

export class RecordRefreshService {
  constructor(
    private readonly engine: BrowserSessionEngine,
    private readonly adapter: EplusBrowserAdapter,
    private readonly db: AppDatabase,
    private readonly decryptSecret?: (cipherText: string) => string,
    private readonly mailAttribution?: { readCode?(input: { accountId: string; startedAt: string }): Promise<{ code?: string; manualActionRequired: boolean }> }
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
    let state = await this.adapter.detectChallenge();
    if (state === "Unknown") {
      await this.adapter.openMemberProfile();
      state = await this.adapter.detectChallenge();
    }
    if (state === "Login") {
      const account = this.db.getStoredAccount(accountId);
      if (!account || !this.decryptSecret) throw new BrowserEngineFailure("ManualTakeoverRequired", "Stored account credentials are unavailable for automatic login.");
      await this.adapter.login(account.eplusEmail, this.decryptSecret(account.encryptedEplusPassword));
      state = await this.adapter.detectChallenge();
    }
    if (state === "EmailCode") {
      const result = await this.mailAttribution?.readCode?.({ accountId, startedAt: new Date().toISOString() });
      if (!result?.code || result.manualActionRequired) throw new BrowserEngineFailure("ManualTakeoverRequired", "The verification email could not be safely attributed.");
      await this.adapter.enterEmailCode(result.code);
      state = await this.adapter.detectChallenge();
    }
    if (state === "Login" || state === "EmailCode" || state === "CaptchaSliderDevice" || state === "CheckboxGate" || state === "Unknown") throw new BrowserEngineFailure("ManualTakeoverRequired", "Automatic account login did not reach the member page.");
  }
}
