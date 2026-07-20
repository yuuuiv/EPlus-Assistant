export type AccountStatus = "Unknown" | "Ok" | "PasswordError" | "Locked" | "MailError";

export type TaskStatus =
  | "Draft"
  | "AwaitingConfirmation"
  | "Queued"
  | "Running"
  | "Paused"
  | "Completed"
  | "Failed"
  | "Cancelled";

export type AccountRunStatus =
  | "Pending"
  | "LoggingIn"
  | "AwaitingEmailCode"
  | "AwaitingManualAction"
  | "FillingForm"
  | "AwaitingSubmitConfirmation"
  | "Submitting"
  | "Submitted"
  | "AlreadyApplied"
  | "UnknownSubmissionState"
  | "Failed"
  | "Cancelled";

export interface Account {
  id: string;
  label: string;
  eplusEmail: string;
  mailProviderId: string;
  tags: string[];
  enabled: boolean;
  lastLoginAt?: string;
  lastLoginStatus: AccountStatus;
  createdAt: string;
  updatedAt: string;
}

export interface AccountInput {
  label?: string;
  eplusEmail: string;
  password: string;
  mailProviderId?: string;
  mailConfig?: Record<string, unknown>;
  tags?: string[];
  enabled?: boolean;
}

export interface EventOption {
  id: string;
  label: string;
  kind: "ticket" | "quantity" | "rank" | "payment" | "delivery" | "consent" | "unknown";
  values: Array<{ id: string; label: string; disabled?: boolean }>;
  required: boolean;
}

export interface EventSnapshot {
  id: string;
  sourceUrl: string;
  canonicalUrl: string;
  title: string;
  venue?: string;
  scheduleText?: string;
  applicationDeadline?: string;
  fetchedAt: string;
  rawFormSchema: {
    options: EventOption[];
    requiresManualInspection: boolean;
    notes: string[];
  };
  pageFingerprint: string;
}

export interface LotteryPreferenceEntry {
  rank: number;
  ticketTypeId: string;
  quantity: number;
  optionalDateOrShowId?: string;
}

export interface LotteryPreference {
  entries: LotteryPreferenceEntry[];
  paymentMethodId: string;
  deliveryMethodId?: string;
  consentFlags: Record<string, boolean>;
}

export interface LotteryTask {
  id: string;
  eventSnapshotId: string;
  preference: LotteryPreference;
  accountIds: string[];
  status: TaskStatus;
  confirmationDigest: string;
  createdAt: string;
  updatedAt: string;
}

export interface AccountRun {
  id: string;
  taskId: string;
  accountId: string;
  status: AccountRunStatus;
  externalApplicationId?: string;
  resumeCheckpoint: Record<string, unknown>;
  errorCode?: string;
  errorDetailRedacted?: string;
  createdAt: string;
  updatedAt: string;
}

export interface AuditLog {
  id: string;
  taskId?: string;
  accountRunId?: string;
  level: "info" | "warn" | "error";
  message: string;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface ImportReport {
  inserted: number;
  updated: number;
  skipped: number;
  errors: Array<{ row: number; message: string }>;
}

export interface DashboardState {
  accounts: Account[];
  events: EventSnapshot[];
  tasks: LotteryTask[];
  runs: AccountRun[];
  logs: AuditLog[];
  dataDir: string;
}

export interface CreateTaskInput {
  eventSnapshotId: string;
  preference: LotteryPreference;
  accountIds: string[];
}

export interface ManualActionInput {
  runId: string;
  action: "continue" | "cancel-account" | "cancel-task";
  verificationCode?: string;
}

