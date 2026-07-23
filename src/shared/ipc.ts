import type {
  Account,
  AccountInput,
  AccountProfile,
  AccountsOverview,
  DashboardState,
  HarvestImportPayload,
  ImportHarvestResult,
  ImportReport,
  LotteryRecord,
  PasswordRevealResponse
} from "./types.js";

export interface AddAccountInput extends AccountInput {
  id?: string;
}

export interface ImportAccountsInput {
  kind: "csv" | "json";
  text: string;
}

export interface ImportHarvestInput {
  payload: HarvestImportPayload;
}

export interface ElectronApi {
  getState(): Promise<DashboardState>;
  addAccount(input: AddAccountInput): Promise<Account>;
  importAccounts(input: ImportAccountsInput): Promise<ImportReport>;
  importHarvest(input: ImportHarvestInput): Promise<ImportHarvestResult>;
  deleteAccount(id: string): Promise<void>;
  revealPassword(accountId: string): Promise<PasswordRevealResponse>;
  listProfiles(accountId: string): Promise<AccountProfile | undefined>;
  listLotteryRecords(accountId: string): Promise<LotteryRecord[]>;
  getAccountsOverview(): Promise<AccountsOverview>;
  openDataFolder(): Promise<void>;
}

declare global {
  interface Window {
    eplusApi: ElectronApi;
  }
}

export type {
  Account,
  AccountLotteryStats,
  AccountOverviewEntry,
  AccountProfile,
  AccountsOverview,
  AuditLog,
  Companion,
  CreditCardSummary,
  DashboardState,
  HarvestImportPayload,
  ImportHarvestResult,
  ImportReport,
  LotteryOutcome,
  LotteryRecord,
  PasswordRevealResponse,
  PerformanceHistory,
  TopPerformanceEntry
} from "./types.js";
