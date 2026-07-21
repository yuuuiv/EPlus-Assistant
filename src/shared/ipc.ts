import type {
  Account,
  AccountInput,
  AccountProfile,
  AccountRun,
  ApplicationRecord,
  AuditLog,
  Companion,
  CreateTaskInput,
  DashboardState,
  EplusRawFormSchema,
  EventOption,
  EventSnapshot,
  ImportReport,
  LotteryResultRecord,
  LotteryPreference,
  ManualActionInput,
  PasswordRevealResponse,
  SubmissionAuthorization,
  ValidationResult,
  VerificationMailboxSettings,
  VerificationMailboxUpdate,
  NetworkSettings,
  NetworkSettingsUpdate,
  VerificationCodeReadInput,
  VerificationCodeReadResult
} from "./types.js";

export interface AddAccountInput extends AccountInput {
  id?: string;
}

export interface EventSnapshotInput {
  sourceUrl: string;
  canonicalUrl?: string;
  title: string;
  venue?: string;
  scheduleText?: string;
  applicationDeadline?: string;
  pageFingerprint?: string;
  rawFormSchemaJson?: string;
}

export interface DiscoverEventInput {
  sourceUrl: string;
}

export interface ImportAccountsInput {
  kind: "csv" | "json";
  text: string;
}

export interface CreateTaskInputV2 extends CreateTaskInput {
  preference: LotteryPreference & {
    daySelectionByAccountId?: Record<string, Array<"day1" | "day2">>;
  };
}

export interface ElectronApi {
  getState(): Promise<DashboardState>;
  addAccount(input: AddAccountInput): Promise<Account>;
  importAccounts(input: ImportAccountsInput): Promise<ImportReport>;
  deleteAccount(id: string): Promise<void>;
  discoverEvent(input: DiscoverEventInput): Promise<EventSnapshotInput>;
  saveEventSnapshot(input: EventSnapshotInput): Promise<EventSnapshot>;
  createTask(input: CreateTaskInput): Promise<{ taskId: string }>;
  createTaskV2(input: CreateTaskInputV2): Promise<{ taskId: string }>;
  updateTaskStatus(taskId: string, status: string): Promise<void>;
  updateRunStatus(runId: string, status: string, note?: string): Promise<void>;
  revealPassword(accountId: string): Promise<PasswordRevealResponse>;
  performManualAction(input: ManualActionInput): Promise<void>;
  getAuthorization(input: { taskId: string; runId: string }): Promise<SubmissionAuthorization | null>;
  listProfiles(accountId: string): Promise<AccountProfile | undefined>;
  listCompanions(accountId: string): Promise<Companion[]>;
  listApplicationRecords(accountId: string, filter?: Record<string, unknown>): Promise<ApplicationRecord[]>;
  listLotteryResults(accountId: string, filter?: Record<string, unknown>): Promise<LotteryResultRecord[]>;
  saveVerificationMailbox(input: VerificationMailboxUpdate): Promise<VerificationMailboxSettings>;
  testVerificationMailbox(): Promise<ValidationResult>;
  readVerificationCode(input?: VerificationCodeReadInput): Promise<VerificationCodeReadResult>;
  getNetworkSettings(): Promise<NetworkSettings>;
  saveNetworkSettings(input: NetworkSettingsUpdate): Promise<NetworkSettings>;
  addLog(message: string, level?: "info" | "warn" | "error", metadata?: Record<string, unknown>): Promise<void>;
  openDataFolder(): Promise<void>;
}

declare global {
  interface Window {
    eplusApi: ElectronApi;
  }
}

export type {
  Account,
  AccountProfile,
  AccountRun,
  ApplicationRecord,
  AuditLog,
  Companion,
  DashboardState,
  EplusRawFormSchema,
  EventOption,
  EventSnapshot,
  ImportReport,
  LotteryResultRecord,
  LotteryPreference,
  ManualActionInput,
  PasswordRevealResponse,
  SubmissionAuthorization,
  ValidationResult,
  VerificationCodeReadInput,
  VerificationCodeReadResult,
  VerificationMailboxSettings,
  VerificationMailboxUpdate,
  NetworkSettings,
  NetworkSettingsUpdate
};
