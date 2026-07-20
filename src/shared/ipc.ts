import type {
  Account,
  AccountInput,
  AccountRun,
  AuditLog,
  CreateTaskInput,
  DashboardState,
  EplusRawFormSchema,
  EventOption,
  EventSnapshot,
  ImportReport,
  LotteryPreference,
  ValidationResult,
  VerificationMailboxSettings,
  VerificationMailboxUpdate,
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

export interface ElectronApi {
  getState(): Promise<DashboardState>;
  addAccount(input: AddAccountInput): Promise<Account>;
  importAccounts(input: ImportAccountsInput): Promise<ImportReport>;
  deleteAccount(id: string): Promise<void>;
  discoverEvent(input: DiscoverEventInput): Promise<EventSnapshotInput>;
  saveEventSnapshot(input: EventSnapshotInput): Promise<EventSnapshot>;
  createTask(input: CreateTaskInput): Promise<{ taskId: string }>;
  updateTaskStatus(taskId: string, status: string): Promise<void>;
  updateRunStatus(runId: string, status: string, note?: string): Promise<void>;
  saveVerificationMailbox(input: VerificationMailboxUpdate): Promise<VerificationMailboxSettings>;
  testVerificationMailbox(): Promise<ValidationResult>;
  readVerificationCode(input?: VerificationCodeReadInput): Promise<VerificationCodeReadResult>;
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
  AccountRun,
  AuditLog,
  DashboardState,
  EplusRawFormSchema,
  EventOption,
  EventSnapshot,
  ImportReport,
  LotteryPreference,
  ValidationResult,
  VerificationCodeReadInput,
  VerificationCodeReadResult,
  VerificationMailboxSettings,
  VerificationMailboxUpdate
};
