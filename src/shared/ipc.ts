import type {
  Account,
  AccountProfile,
  AccountsOverview,
  DashboardState,
  HarvestImportPayload,
  ImportHarvestResult,
  LotteryRecord,
  PasswordRevealResponse
} from "./types.js";

export interface ImportHarvestInput {
  payload: HarvestImportPayload;
}

export interface SetAccountPasswordInput {
  accountId: string;
  password: string;
}

export interface ElectronApi {
  getState(): Promise<DashboardState>;
  importHarvest(input: ImportHarvestInput): Promise<ImportHarvestResult>;
  deleteAccount(id: string): Promise<void>;
  setAccountPassword(input: SetAccountPasswordInput): Promise<void>;
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
  AdvancedStats,
  AuditLog,
  BucketRatePoint,
  Companion,
  ConfidenceRankedEntry,
  CreditCardSummary,
  DashboardState,
  HarvestImportPayload,
  ImportHarvestResult,
  ImportReport,
  InvestmentReturnEntry,
  LotteryOutcome,
  LotteryRecord,
  MonthlyTrendPoint,
  PasswordRevealResponse,
  PerformanceHeatPoint,
  PerformanceHistory,
  TopPerformanceEntry
} from "./types.js";
