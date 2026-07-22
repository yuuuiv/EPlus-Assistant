import type {
  Account,
  AccountInput,
  AccountProfile,
  AccountRun,
  ApplicationRecord,
  AuditLog,
  Companion,
  CreateTaskInput,
  CreateTaskInputV2,
  DashboardState,
  EplusRawFormSchema,
  EventOption,
  EventSnapshot,
  ImportReport,
  LotteryResultRecord,
  LotteryPreference,
  ManualActionInput,
  PaymentSelectionInput,
  SubmissionDispatchInput,
  PasswordRevealResponse,
  SubmissionAuthorization,
  ValidationResult,
  VerificationMailboxSettings,
  VerificationMailboxUpdate,
  NetworkSettings,
  NetworkSettingsUpdate,
  NetworkImportResult,
  NetworkNode,
  CreditCardSummary,
  VerificationCodeReadInput,
  VerificationCodeReadResult
} from "./types.js";
import type { HarvestRunResult } from "../main/services/profileHarvester.js";
import type { QueueState } from "../main/services/queueService.js";

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

export interface IpIdentity {
  ip: string;
  region: string;
  country: string;
  city?: string;
}

export interface NetworkImportInput {
  controller: "clash" | "sing-box";
  text: string;
}

export interface ElectronApi {
  getState(): Promise<DashboardState>;
  addAccount(input: AddAccountInput): Promise<Account>;
  importAccounts(input: ImportAccountsInput): Promise<ImportReport>;
  deleteAccount(id: string): Promise<void>;
  discoverEvent(input: DiscoverEventInput): Promise<EventSnapshotInput>;
  saveEventSnapshot(input: EventSnapshotInput): Promise<EventSnapshot>;
  deleteEventSnapshot(id: string): Promise<void>;
  createTask(input: CreateTaskInput): Promise<{ taskId: string }>;
  createTaskV2(input: CreateTaskInputV2): Promise<{ taskId: string }>;
  deleteTask(taskId: string): Promise<void>;
  enqueueTask(taskId: string): Promise<void>;
  pauseQueue(): Promise<void>;
  resumeQueue(): Promise<void>;
  cancelRun(runId: string): Promise<void>;
  cancelTask(taskId: string): Promise<void>;
  getQueueState(): Promise<QueueState>;
  revealPassword(accountId: string): Promise<PasswordRevealResponse>;
  performManualAction(input: ManualActionInput): Promise<void>;
  retryEmailCode(runId: string): Promise<void>;
  selectPaymentOptions(input: PaymentSelectionInput): Promise<SubmissionAuthorization>;
  dispatchSubmission(input: SubmissionDispatchInput): Promise<void>;
  awaitCompletionEmail(runId: string): Promise<AccountRun>;
  recoverSubmission(input: { taskId: string; runId: string }): Promise<void>;
  getAuthorization(input: { taskId: string; runId: string }): Promise<SubmissionAuthorization | null>;
  harvestProfile(input: { accountId: string; existingSession?: boolean }): Promise<HarvestRunResult>;
  refreshProfile(accountId: string): Promise<HarvestRunResult>;
  refreshApplicationRecords(accountId: string): Promise<ApplicationRecord[]>;
  refreshLotteryResults(accountId: string): Promise<LotteryResultRecord[]>;
  reconcileSubmission(input: { taskId: string; runId: string }): Promise<"Submitted" | "AlreadyApplied" | "Failed">;
  listProfiles(accountId: string): Promise<AccountProfile | undefined>;
  listCompanions(accountId: string): Promise<Companion[]>;
  listApplicationRecords(accountId: string): Promise<ApplicationRecord[]>;
  listLotteryResults(accountId: string): Promise<LotteryResultRecord[]>;
  saveVerificationMailbox(input: VerificationMailboxUpdate): Promise<VerificationMailboxSettings>;
  testVerificationMailbox(): Promise<ValidationResult>;
  readVerificationCode(input?: VerificationCodeReadInput): Promise<VerificationCodeReadResult>;
  getNetworkSettings(): Promise<NetworkSettings>;
  saveNetworkSettings(input: NetworkSettingsUpdate): Promise<NetworkSettings>;
  importNetworkConfig(input: NetworkImportInput): Promise<NetworkImportResult>;
  detectIp(): Promise<IpIdentity>;
  rotateIp(): Promise<void>;
  listNetworkNodes(proxyGroup?: string): Promise<NetworkNode[]>;
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
  PaymentSelectionInput,
  SubmissionDispatchInput,
  PasswordRevealResponse,
  SubmissionAuthorization,
  ValidationResult,
  VerificationCodeReadInput,
  VerificationCodeReadResult,
  VerificationMailboxSettings,
  VerificationMailboxUpdate,
  NetworkSettings,
  NetworkSettingsUpdate,
  NetworkImportResult,
  NetworkNode,
  CreditCardSummary,
  CreateTaskInputV2
};
