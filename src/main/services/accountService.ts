import { randomUUID } from "node:crypto";
import type { Account, AccountInput, ImportReport } from "../../shared/types.js";
import { SecretStore } from "../storage/secretStore.js";
import type { AppDatabase } from "../storage/database.js";
import { parseAccountImport } from "./importService.js";

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
}

