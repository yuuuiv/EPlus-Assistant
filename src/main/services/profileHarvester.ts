import { randomUUID } from "node:crypto";
import type { AccountProfile, ApplicationRecord, Companion, LotteryResultRecord } from "../../shared/types.js";
import { EplusBrowserAdapter } from "../adapters/eplusAdapter.js";
import { BrowserEngineFailure, type BrowserSessionEngine } from "../engines/browserSessionEngine.js";
import type { AppDatabase } from "../storage/database.js";

export type HarvestResult = "Ok" | "Partial" | "Failed" | "AwaitingManualAction";

export interface ProfileMailAttribution {
  readCode?(input: { accountId: string; startedAt: string }): Promise<{ code?: string; manualActionRequired: boolean }>;
}

export interface HarvestRunResult {
  readonly runId: string;
  readonly status: HarvestResult;
  readonly profile?: Partial<AccountProfile>;
  readonly companions?: readonly Companion[];
  readonly applicationRecords?: readonly ApplicationRecord[];
  readonly lotteryResults?: readonly LotteryResultRecord[];
  readonly harvestedFields: readonly string[];
  readonly failedFields: readonly string[];
  readonly errorDetail?: string;
}

export class ProfileHarvester {
  constructor(
    private readonly engine: BrowserSessionEngine,
    private readonly adapter: EplusBrowserAdapter,
    private readonly db: AppDatabase,
    private readonly decryptSecret?: (cipherText: string) => string,
    private readonly mailAttribution?: ProfileMailAttribution
  ) {}

  async harvest(input: { readonly accountId: string; readonly existingSession?: boolean }): Promise<HarvestRunResult> {
    const runId = randomUUID();
    const startedAt = new Date().toISOString();
    const harvestedFields: string[] = [];
    const failedFields: string[] = [];
    this.db.createProfileHarvestRun({ id: runId, accountId: input.accountId, status: "Pending", harvestedFields, startedAt });

    try {
      await this.prepareSession(input, runId);
      this.db.updateProfileHarvestRun({ id: runId, status: "Extracting" });

      const existing = this.db.getProfile(input.accountId);
      const storedAccount = this.db.getStoredAccount(input.accountId);
      if (!storedAccount) throw new Error("Account not found.");

      const basic = await this.readBasicProfile(failedFields);
      harvestedFields.push(...presentProfileFields(basic));
      const phone = await this.readPhone(failedFields);
      if (phone) harvestedFields.push("phone");
      const address = await this.readAddress(failedFields);
      if (address) harvestedFields.push("address");
      const creditCards = await this.readCreditCards(failedFields);
      if (creditCards) harvestedFields.push("creditCards");
      let profile = mergeProfile({ accountId: input.accountId, existing, storedAccount, basic: { ...basic, phone: phone ?? basic.phone, address: address ?? basic.address, creditCards: creditCards ?? basic.creditCards } });
      this.db.upsertProfile(profile);
      const companionData = await this.readCompanions(failedFields);
      if (companionData) {
        harvestedFields.push("companions", "pastCompanions");
        profile = { ...profile, companions: [...companionData.companions], pastCompanions: [...companionData.pastCompanions] };
        this.db.upsertProfile(profile);
      }
      const applicationRecords = await this.readApplications(input.accountId, failedFields);
      if (applicationRecords) harvestedFields.push("applicationRecords");
      const lotteryResults = await this.readLotteryResults(input.accountId);
      if (lotteryResults) harvestedFields.push("lotteryResults");

      const status = failedFields.length === 0 ? "Ok" : "Partial";
      profile = { ...profile, harvestedAt: new Date().toISOString(), harvestStatus: status };
      this.db.upsertProfile(profile);
      applicationRecords?.forEach((record) => this.db.addApplicationRecord(record));
      lotteryResults?.forEach((record) => this.db.addLotteryResult(record));
      this.db.updateProfileHarvestRun({
        id: runId,
        status: "Completed",
        harvestedFields,
        completedAt: new Date().toISOString()
      });
      return { runId, status, profile, companions: profile.companions, applicationRecords, lotteryResults, harvestedFields, failedFields };
    } catch (error) {
      if (isManualTakeover(error)) {
        // Keep the underlying reason (e.g. a network lease failure vs. a login/CAPTCHA
        // challenge) instead of one generic sentence for every manual-takeover cause.
        const errorDetail = error instanceof Error && error.message ? error.message : "Manual action is required before profile harvesting can continue.";
        this.db.updateProfileHarvestRun({ id: runId, status: "AwaitingManualAction", harvestedFields, errorDetail });
        return { runId, status: "AwaitingManualAction", harvestedFields, failedFields, errorDetail };
      }
      const errorDetail = error instanceof Error ? error.message : "Profile harvest failed.";
      this.db.updateProfileHarvestRun({ id: runId, status: "Failed", harvestedFields, errorDetail, completedAt: new Date().toISOString() });
      return { runId, status: "Failed", harvestedFields, failedFields, errorDetail };
    }
  }

  async refreshProfile(accountId: string): Promise<HarvestRunResult> {
    return this.harvest({ accountId, existingSession: false });
  }

  private async prepareSession(input: { readonly accountId: string; readonly existingSession?: boolean }, runId: string): Promise<void> {
    this.db.updateProfileHarvestRun({ id: runId, status: "LoggingIn" });
    if (input.existingSession && this.engine.isSessionActive() && (await this.engine.reuseSession())) return;
    if (this.engine.isSessionActive()) await this.engine.close();
    await this.engine.startSession(input.accountId);
    // Landing on a member.eplus.jp page cold, with no prior visit to the main
    // eplus.jp domain, is what triggers eplus's Akamai-fronted login gateway to
    // reject the request outright instead of showing a normal login prompt.
    await this.adapter.openHome();
    await this.adapter.openMemberProfile();
    let state = await this.adapter.detectChallenge();
    if (state === "Login") {
      const account = this.db.getStoredAccount(input.accountId);
      if (!account || !this.decryptSecret) throw new BrowserEngineFailure("ManualTakeoverRequired", "Stored account credentials are unavailable for automatic profile login.");
      await this.adapter.login(account.eplusEmail, this.decryptSecret(account.encryptedEplusPassword));
      state = await this.adapter.detectChallenge();
    }
    if (state === "EmailCode") {
      const result = await this.mailAttribution?.readCode?.({ accountId: input.accountId, startedAt: new Date().toISOString() });
      if (!result?.code || result.manualActionRequired) throw new BrowserEngineFailure("ManualTakeoverRequired", "The verification email could not be safely attributed.");
      await this.adapter.enterEmailCode(result.code);
      state = await this.adapter.detectChallenge();
    }
    if (state === "Login" || state === "EmailCode" || state === "CaptchaSliderDevice" || state === "CheckboxGate" || state === "Unknown") {
      throw new BrowserEngineFailure("ManualTakeoverRequired", "Profile login requires manual browser verification.");
    }
  }

  private async readBasicProfile(failedFields: string[]): Promise<Awaited<ReturnType<EplusBrowserAdapter["readMemberProfile"]>>> {
    try {
      await this.adapter.openMemberProfile();
      const profile = await this.adapter.readMemberProfile();
      for (const field of ["name", "email", "phone", "gender", "birthday", "address"] as const) {
        if (!profile[field]) failedFields.push(field);
      }
      return profile;
    } catch (error) {
      if (isManualTakeover(error)) throw error;
      failedFields.push("profile");
      return {};
    }
  }

  private async readCompanions(failedFields: string[]): Promise<Awaited<ReturnType<EplusBrowserAdapter["readCompanions"]>> | undefined> {
    try {
      await this.adapter.openCompanionManagement();
      return await this.adapter.readCompanions();
    } catch (error) {
      if (isManualTakeover(error)) throw error;
      failedFields.push("companions");
      return undefined;
    }
  }

  private async readPhone(failedFields: string[]): Promise<string | undefined> {
    try {
      await this.adapter.openPhoneNumber();
      return await this.adapter.readPhoneNumber();
    } catch (error) {
      if (isManualTakeover(error)) throw error;
      return undefined;
    }
  }

  private async readAddress(failedFields: string[]): Promise<string | undefined> {
    try {
      await this.adapter.openShippingAddress();
      return await this.adapter.readShippingAddress();
    } catch (error) {
      if (isManualTakeover(error)) throw error;
      return undefined;
    }
  }

  private async readCreditCards(failedFields: string[]): Promise<Awaited<ReturnType<EplusBrowserAdapter["readCreditCards"]>> | undefined> {
    if (typeof this.adapter.openCreditCard !== "function" || typeof this.adapter.readCreditCards !== "function") return undefined;
    try {
      await this.adapter.openCreditCard();
      return await this.adapter.readCreditCards();
    } catch (error) {
      if (isManualTakeover(error)) throw error;
      return undefined;
    }
  }

  private async readApplications(accountId: string, failedFields: string[]): Promise<ApplicationRecord[] | undefined> {
    try {
      await this.adapter.openApplicationHistory();
      const harvestedAt = new Date().toISOString();
      return (await this.adapter.readApplicationHistory()).map((record) => ({ id: randomUUID(), accountId, harvestedAt, ...record }));
    } catch (error) {
      if (isManualTakeover(error)) throw error;
      failedFields.push("applicationRecords");
      return undefined;
    }
  }

  private async readLotteryResults(accountId: string): Promise<LotteryResultRecord[] | undefined> {
    try {
      await this.adapter.openLotteryResults();
      const harvestedAt = new Date().toISOString();
      return (await this.adapter.readLotteryResults()).map((record) => ({ id: randomUUID(), accountId, harvestedAt, ...record }));
    } catch (error) {
      if (isManualTakeover(error)) throw error;
      return undefined;
    }
  }
}

function presentProfileFields(profile: Awaited<ReturnType<EplusBrowserAdapter["readMemberProfile"]>>): string[] {
  return (["name", "email", "phone", "gender", "birthday", "address"] as const).filter((field) => Boolean(profile[field]));
}

function mergeProfile(input: {
  readonly accountId: string;
  readonly existing: AccountProfile | undefined;
  readonly storedAccount: { readonly eplusEmail: string; readonly encryptedEplusPassword: string };
  readonly basic: Awaited<ReturnType<EplusBrowserAdapter["readMemberProfile"]>>;
}): AccountProfile {
  return {
    accountId: input.accountId,
    eplusEmail: input.basic.email ?? input.existing?.eplusEmail ?? input.storedAccount.eplusEmail,
    encryptedPassword: input.existing?.encryptedPassword ?? input.storedAccount.encryptedEplusPassword,
    revealSupported: input.existing?.revealSupported ?? false,
    phone: input.basic.phone ?? input.existing?.phone,
    name: input.basic.name ?? input.existing?.name,
    gender: input.basic.gender ?? input.existing?.gender,
    birthday: input.basic.birthday ?? input.existing?.birthday,
    address: input.basic.address ?? input.existing?.address,
    creditCards: [...(input.basic.creditCards ?? input.existing?.creditCards ?? [])],
    companions: [...(input.existing?.companions ?? [])],
    pastCompanions: [...(input.existing?.pastCompanions ?? [])],
    harvestedAt: new Date().toISOString(),
    harvestStatus: "Partial"
  };
}

function isManualTakeover(error: unknown): boolean {
  return error instanceof BrowserEngineFailure && error.code === "ManualTakeoverRequired";
}
