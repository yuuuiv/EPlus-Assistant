import { randomUUID } from "node:crypto";
import type { Account, AccountInput, AccountProfile, HarvestImportPayload, ImportHarvestResult, ImportReport, LotteryRecord, PasswordRevealResponse } from "../../shared/types.js";
import { SecretStore } from "../storage/secretStore.js";
import type { AppDatabase } from "../storage/database.js";
import { normalizeHarvestImport, parseAccountImport } from "./importService.js";

export class AccountService {
  constructor(
    private readonly db: AppDatabase,
    private readonly secretStore: SecretStore
  ) {}

  listAccounts(): Account[] {
    return this.db.listAccounts();
  }

  addAccount(input: AccountInput & { id?: string }): Account {
    return this.db.upsertAccount({
      ...input,
      encryptedPassword: this.secretStore.encryptString(input.password),
      encryptedMailConfig: this.secretStore.encryptJson(input.mailConfig ?? {})
    });
  }

  importAccounts(kind: "csv" | "json", text: string): ImportReport {
    const rows = parseAccountImport(kind, text);
    const report: ImportReport = { inserted: 0, updated: 0, skipped: 0, errors: [] };
    rows.forEach((row, index) => {
      try {
        const existing = this.db.findAccountByEmail(row.eplusEmail);
        this.db.upsertAccount({
          id: existing?.id ?? randomUUID(),
          ...row,
          encryptedPassword: this.secretStore.encryptString(row.password),
          encryptedMailConfig: this.secretStore.encryptJson(row.mailConfig ?? {})
        });
        if (existing) {
          report.updated += 1;
        } else {
          report.inserted += 1;
        }
      } catch (error) {
        report.errors.push({
          row: index + 1,
          message: error instanceof Error ? error.message : "Unknown import error"
        });
      }
    });
    return report;
  }

  deleteAccount(id: string): void {
    this.db.deleteAccount(id);
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
      creditCards: harvest.creditCards,
      companions: harvest.companions,
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
