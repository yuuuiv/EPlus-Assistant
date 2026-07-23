import { randomUUID } from "node:crypto";
import type { Account, AccountProfile, AccountsOverview, HarvestImportPayload, ImportHarvestResult, LotteryRecord, PasswordRevealResponse } from "../../shared/types.js";
import { SecretStore } from "../storage/secretStore.js";
import type { AppDatabase } from "../storage/database.js";
import { normalizeHarvestImport } from "./importService.js";
import { buildAccountsOverview } from "./statsService.js";

export class AccountService {
  constructor(
    private readonly db: AppDatabase,
    private readonly secretStore: SecretStore
  ) {}

  listAccounts(): Account[] {
    const profileByAccount = new Map(this.db.listAllProfiles().map((profile) => [profile.accountId, profile]));
    return this.db.listAccounts().map((account) => ({ ...account, profileUpdatedAt: profileByAccount.get(account.id)?.harvestedAt, phone: profileByAccount.get(account.id)?.phone }));
  }

  deleteAccount(id: string): void {
    this.db.deleteAccount(id);
  }

  /** Harvest-created accounts start with an empty password (the browser userscript can't read
   *  it) - this lets the user record the real login password by hand afterward, so reveal/copy
   *  is actually useful when they need to log in manually. */
  setPassword(id: string, password: string): void {
    const account = this.db.getStoredAccount(id);
    if (!account) throw new Error("Account not found.");
    this.db.updateAccountPassword(id, this.secretStore.encryptString(password));
  }

  revealPassword(id: string, senderWindowId: string): PasswordRevealResponse {
    const account = this.db.getStoredAccount(id);
    if (!account) throw new Error("Account not found.");
    const session = this.secretStore.createRevealSession(id, account.encryptedEplusPassword, senderWindowId);
    const result = this.secretStore.consumeRevealSession(session.requestId, senderWindowId);
    if (!result) throw new Error("Failed to establish password reveal session.");
    return { plaintext: result.plaintext, expiresAt: session.expiresAt };
  }

  listProfile(accountId: string): AccountProfile | undefined {
    return this.db.getProfile(accountId);
  }

  listLotteryRecords(accountId: string): LotteryRecord[] {
    return this.db.listLotteryRecords(accountId);
  }

  getAccountsOverview(): AccountsOverview {
    return buildAccountsOverview(this.listAccounts(), this.db.listAllProfiles(), this.db.listAllLotteryRecords());
  }

  /** Imports the JSON exported by userscript/eplus-collector.user.js. Matches an existing account
   *  by eplusEmail; if none exists, creates a view-only account (no known login password - the
   *  user logged in manually in their browser, so there's nothing real to store) purely to hold
   *  the harvested profile/companions/cards/lottery records. */
  importHarvest(payload: HarvestImportPayload): ImportHarvestResult {
    const harvest = normalizeHarvestImport(payload);
    const existing = this.db.findAccountByEmail(harvest.eplusEmail);
    const accountId = existing?.id ?? this.db.upsertAccount({
      eplusEmail: harvest.eplusEmail,
      password: "",
      encryptedPassword: this.secretStore.encryptString(""),
      encryptedMailConfig: this.secretStore.encryptJson({})
    }).id;
    const account = this.db.getStoredAccount(accountId);
    if (!account) throw new Error("Account not found after import.");

    const previousProfile = this.db.getProfile(account.id);
    this.db.upsertProfile({
      accountId: account.id,
      eplusEmail: harvest.eplusEmail,
      encryptedPassword: previousProfile?.encryptedPassword ?? account.encryptedEplusPassword,
      revealSupported: false,
      phone: harvest.profile.phone,
      name: harvest.profile.name,
      nameKana: harvest.profile.nameKana,
      gender: harvest.profile.gender,
      birthYear: harvest.profile.birthYear,
      address: harvest.profile.address,
      // A collection run doesn't necessarily re-visit every page (see upsertLotteryRecords'
      // comment) - an empty list here means "this run didn't touch this section," not "the
      // account genuinely has none," so it must not clobber what a previous run already found.
      creditCards: harvest.creditCards.length > 0 ? harvest.creditCards : (previousProfile?.creditCards ?? []),
      companions: harvest.companions.length > 0 ? harvest.companions : (previousProfile?.companions ?? []),
      pastCompanions: previousProfile?.pastCompanions ?? [],
      harvestedAt: harvest.collectedAt,
      harvestStatus: "Ok"
    });

    const records: LotteryRecord[] = harvest.lotteryRecords.map((record) => ({
      id: randomUUID(),
      accountId: account.id,
      orderId: record.orderId,
      tourName: record.tourName,
      eventDatetime: record.eventDatetime,
      venueName: record.venueName,
      receptionName: record.receptionName,
      orderDatetime: record.orderDatetime,
      status: record.status,
      statusDetail: record.statusDetail,
      detailUrl: record.detailUrl,
      harvestedAt: harvest.collectedAt
    }));
    this.db.upsertLotteryRecords(account.id, records);

    return {
      accountId: account.id,
      accountCreated: !existing,
      report: { inserted: records.length, updated: 0, skipped: 0, errors: [] }
    };
  }
}
