import { randomUUID } from "node:crypto";
import type { AccountProfile, ApplicationRecord, Companion } from "../../shared/types.js";
import { EplusBrowserAdapter } from "../adapters/eplusAdapter.js";
import { BrowserEngineFailure, type BrowserSessionEngine } from "../engines/browserSessionEngine.js";
import type { AppDatabase } from "../storage/database.js";

export type HarvestResult = "Ok" | "Partial" | "Failed" | "AwaitingManualAction";

export interface HarvestRunResult {
  readonly runId: string;
  readonly status: HarvestResult;
  readonly profile?: Partial<AccountProfile>;
  readonly companions?: readonly Companion[];
  readonly applicationRecords?: readonly ApplicationRecord[];
  readonly harvestedFields: readonly string[];
  readonly failedFields: readonly string[];
  readonly errorDetail?: string;
}

export class ProfileHarvester {
  constructor(
    private readonly engine: BrowserSessionEngine,
    private readonly adapter: EplusBrowserAdapter,
    private readonly db: AppDatabase
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
      let profile = mergeProfile({ accountId: input.accountId, existing, storedAccount, basic });
      this.db.upsertProfile(profile);
      const companionData = await this.readCompanions(failedFields);
      if (companionData) {
        harvestedFields.push("companions", "pastCompanions");
        profile = { ...profile, companions: [...companionData.companions], pastCompanions: [...companionData.pastCompanions] };
        this.db.upsertProfile(profile);
      }
      const applicationRecords = await this.readApplications(input.accountId, failedFields);
      if (applicationRecords) harvestedFields.push("applicationRecords");

      const status = failedFields.length === 0 ? "Ok" : "Partial";
      profile = { ...profile, harvestedAt: new Date().toISOString(), harvestStatus: status };
      this.db.upsertProfile(profile);
      applicationRecords?.forEach((record) => this.db.addApplicationRecord(record));
      this.db.updateProfileHarvestRun({
        id: runId,
        status: "Completed",
        harvestedFields,
        completedAt: new Date().toISOString()
      });
      return { runId, status, profile, companions: profile.companions, applicationRecords, harvestedFields, failedFields };
    } catch (error) {
      if (isManualTakeover(error)) {
        const errorDetail = "Manual action is required before profile harvesting can continue.";
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
    const state = await this.adapter.detectChallenge();
    if (state === "Login" || state === "EmailCode") {
      throw new BrowserEngineFailure("ManualTakeoverRequired", "An interactive login is required.");
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
    companions: [...(input.existing?.companions ?? [])],
    pastCompanions: [...(input.existing?.pastCompanions ?? [])],
    harvestedAt: new Date().toISOString(),
    harvestStatus: "Partial"
  };
}

function isManualTakeover(error: unknown): boolean {
  return error instanceof BrowserEngineFailure && error.code === "ManualTakeoverRequired";
}
