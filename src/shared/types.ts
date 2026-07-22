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
  | "AwaitingCompletionEmail"
  | "AwaitingManualAction"
  | "FillingForm"
  | "AwaitingSubmitConfirmation"
  | "Submitting"
  | "Submitted"
  | "AlreadyApplied"
  | "UnknownSubmissionState"
  | "Failed"
  | "Cancelled";

export type PaymentRunState =
  | "Idle"
  | "PaymentDiscoveryPending"
  | "PaymentSelectionPending"
  | "PaymentSelectionApplied"
  | "Submitting"
  | "UnknownSubmissionState";

export type DeviceProfileKey = "desktop-chrome" | "desktop-edge" | "iphone-13" | "iphone-15" | "iphone-se" | "pixel-7" | "pixel-8" | "galaxy-s24" | "ipad-gen7";

export interface SelectorEvidence {
  scope: "document";
  tag: "select" | "input" | "button";
  groupOrdinal: number;
  optionOrdinal: number;
  allowedAttributes: {
    id?: string;
    name?: string;
    type?: string;
    role?: string;
    dataPaymentGroup?: string;
  };
  contextGeneration: string;
}

export interface RuntimePaymentOption {
  candidateId: string;
  groupKey: string;
  groupOrder: number;
  optionOrder: number;
  controlType: "select" | "input" | "button";
  domValue: string;
  label: string;
  enabled: boolean;
  supported: boolean;
  ambiguous: boolean;
  selectorEvidence: SelectorEvidence;
}

export interface PaymentOptionGroup {
  groupKey: string;
  groupOrder: number;
  controlType: "select" | "input" | "button";
  selectorEvidence: SelectorEvidence;
  options: RuntimePaymentOption[];
}

export interface PaymentPreference {
  groupKey: string;
  value: string;
}

export interface PaymentDiscoveryCheckpoint {
  taskId: string;
  runId: string;
  checkpointId: string;
  checkpointRevision: number;
  pageFingerprint: string;
  controlFingerprint: string;
  contextGeneration: string;
  groups: PaymentOptionGroup[];
  candidateIds: string[];
  groupKeys: Record<string, string[]>;
  discoveredAt: string;
  deviceProfileKey: DeviceProfileKey;
}

export interface PaymentSelectionInput {
  taskId: string;
  runId: string;
  checkpointId: string;
  checkpointRevision: number;
  candidateIds: string[];
  expectedControlFingerprint: string;
}

export interface SubmissionDispatchInput {
  taskId: string;
  runId: string;
  authorizationRevision: number;
  nonce: string;
}

export interface PaymentSelection {
  groupKey: string;
  candidateId: string;
  domValue: string;
}

export interface DispatchLease {
  leaseId: string;
  issuedAt: string;
  heartbeatAt: string;
  workerPid: number;
  workerProcessStartTime: string;
  contextOwnerToken: string;
  recoveryRevision: number;
  recoveryFenceToken: string;
  revokedAt?: string;
}

export interface RecoveryFence {
  runId: string;
  submissionRecoveryRevision: number;
  recoveryFenceToken: string;
  fencedAt: string;
}

export class PaymentValidationError extends Error {
  constructor(readonly code: "InvalidDeviceProfile" | "SensitivePaymentField" | "StalePaymentCheckpoint" | "InvalidPaymentSelection" | "DispatchGuardRejected" | "RecoveryFenceRejected", message: string) {
    super(message);
    this.name = "PaymentValidationError";
  }
}

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
  runtimeGroup?: PaymentOptionGroup;
}

export interface EplusApplicationLink {
  id: string;
  label: string;
  href?: string;
  status?: string;
  sessionName?: string;
  selectorHint?: string;
}

/** A selectable application day/entry, labeled with the site's own text (e.g. "<DAY1>シリアル先行") rather than a generic translation. */
export interface AvailableDayOption {
  day: "day1" | "day2";
  label: string;
}

export interface SerialCodeRequirement {
  required: boolean;
  label: string;
  placeholder?: string;
  errorSelectors: string[];
  knownErrorMessages: Array<{ code: "InvalidCode" | "UsedCode"; text: string }>;
  availableDays?: AvailableDayOption[];
  daySelectionRequired?: boolean;
}

export interface EplusRawFormSchema {
  sourceKind: "standard-detail" | "serial-code" | "unknown";
  options: EventOption[];
  applicationLinks: EplusApplicationLink[];
  quantityRange?: { min: number; max: number };
  serialCode: SerialCodeRequirement;
  selectorHints: Record<string, string>;
  requiresManualInspection: boolean;
  notes: string[];
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
  rawFormSchema: EplusRawFormSchema;
  pageFingerprint: string;
}

export interface LotteryPreferenceEntry {
  rank: number;
  ticketTypeId: string;
  quantity: number;
  optionalDateOrShowId?: string;
}

/** Per-code choices. A single serial code is one application run, while its
 * selected days and entry can differ from another code on the same account. */
export interface SerialCodePlan {
  code: string;
  daySelection?: Array<"day1" | "day2">;
  applicationLinkId?: string;
  entries?: LotteryPreferenceEntry[];
}

export interface LotteryPreference {
  entries: LotteryPreferenceEntry[];
  paymentMethodId?: string;
  paymentPreference?: PaymentPreference;
  deliveryMethodId?: string;
  serialCode?: string;
  serialCodesByAccountId?: Record<string, string>;
  /** Explicit one-to-many allocation used to create one run per serial code. */
  serialCodeAllocations?: Record<string, SerialCodePlan[]>;
  daySelectionByAccountId?: Record<string, Array<"day1" | "day2">>;
  applicationLinkId?: string;
  consentFlags: Record<string, boolean>;
}

export interface AutomationRiskAcknowledgement {
  version: number;
  acknowledgedAt: string;
  disclosureDigest: string;
}

export interface SubmissionAuthorization {
  taskId: string;
  runId: string;
  accountId: string;
  effectivePreferenceDigest: string;
  reviewDigest: string;
  idempotencyKey: string;
  policy: "required" | "disabled";
  acknowledgementVersion: number;
  checkpointVersion: number;
  createdAt: string;
  expiresAt: string;
  consumed: boolean;
  authorizationRevision?: number;
  nonce?: string;
  revokedAt?: string;
  consumedAt?: string;
  checkpointRevision?: number;
  deviceProfileKey?: DeviceProfileKey;
  deviceRegistryDigest?: string;
  pageFingerprint?: string;
  controlFingerprint?: string;
  selectedOptions?: PaymentSelection[];
  submissionRecoveryRevision?: number;
  recoveryFenceToken?: string;
}

export type SubmissionIntentStatus = "Prepared" | "Dispatching" | "Acknowledged" | "Unknown" | "Failed";

export interface SubmissionIntent {
  taskId: string;
  runId: string;
  status: SubmissionIntentStatus;
  idempotencyKey: string;
  preferenceDigest: string;
  receiptApplicationId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface NetworkLease {
  accountId: string;
  runId: string;
  contextId: string;
  networkFingerprint: string;
  generation: number;
  country: string;
  policy: string;
  createdAt: string;
  expiresAt: string;
}

export interface NetworkSettings {
  controller: "clash" | "sing-box" | "direct";
  host: string;
  port: number;
  proxyGroup: string;
  requiredCountry: string;
  policy: string;
  secretConfigured: boolean;
  proxyGroups?: string[];
  /** Hand-picked node subset per proxy group, keyed by group name; empty/absent for a group means use every member. Lets the user save several groups and switch between them without re-picking nodes each time. */
  nodeSelectionsByGroup?: Record<string, string[]>;
  updatedAt?: string;
}

export interface NetworkSettingsUpdate {
  controller: "clash" | "sing-box" | "direct";
  host: string;
  port: number;
  secret?: string;
  proxyGroup: string;
  requiredCountry: string;
  policy: string;
  proxyGroups?: string[];
  nodeSelectionsByGroup?: Record<string, string[]>;
}

export interface NetworkImportResult extends NetworkSettingsUpdate {
  /** Every individual proxy server name found in the imported config, for the user to pick a rotation subset from. */
  availableNodes: string[];
}

export interface NetworkNode {
  name: string;
  type: string;
  alive: boolean;
  delay?: number;
}

export interface PasswordRevealRequest {
  accountId: string;
  senderWindowId: string;
  requestId: string;
}

export type PasswordRevealHandle = PasswordRevealRequest;

export interface PasswordRevealResponse {
  plaintext: string;
  expiresAt: string;
}

export interface Companion {
  name: string;
  relationship?: string;
  memberId?: string;
  boundAt?: string;
  unboundAt?: string;
}

export interface AccountProfile {
  accountId: string;
  eplusEmail: string;
  encryptedPassword: string;
  revealSupported: boolean;
  phone?: string;
  name?: string;
  gender?: string;
  birthday?: string;
  address?: string;
  /** Only non-sensitive card metadata is stored; PAN/CVV/expiry are never persisted. */
  creditCards?: CreditCardSummary[];
  companions: Companion[];
  pastCompanions: Companion[];
  harvestedAt: string;
  harvestStatus: "Pending" | "Ok" | "Partial" | "Failed";
}

export interface CreditCardSummary {
  brand?: string;
  last4: string;
  updatedAt?: string;
}

export interface ApplicationRecord {
  id: string;
  accountId: string;
  eventTitle: string;
  appliedAt: string;
  sessionOrDay?: string;
  ticketType: string;
  quantity: number;
  applicationId?: string;
  status: string;
  harvestedAt: string;
}

export interface LotteryResultRecord {
  id: string;
  accountId: string;
  eventTitle: string;
  resultKind: "中選" | "落選" | "待通知" | "取消";
  decidedAt?: string;
  paymentDeadline?: string;
  applicationId?: string;
  harvestedAt: string;
}

export type ProfileHarvestRunStatus =
  | "Pending"
  | "LoggingIn"
  | "AwaitingEmailCode"
  | "AwaitingManualAction"
  | "Extracting"
  | "Completed"
  | "Failed";

export interface ProfileHarvestRun {
  id: string;
  accountId: string;
  status: ProfileHarvestRunStatus;
  harvestedFields: string[];
  errorDetail?: string;
  startedAt: string;
  completedAt?: string;
}

export interface ArtifactManifest {
  id: string;
  runId: string;
  stepId: string;
  kind: "screenshot" | "html-snapshot" | "flow-snapshot";
  filePath: string;
  maskedSelectors: string[];
  createdAt: string;
}

export interface LotteryTask {
  id: string;
  eventSnapshotId: string;
  preference: LotteryPreference;
  accountIds: string[];
  status: TaskStatus;
  confirmationDigest: string;
  deviceProfileKey?: DeviceProfileKey;
  createdAt: string;
  updatedAt: string;
}

export interface AccountRun {
  id: string;
  taskId: string;
  accountId: string;
  /** The serial code consumed by this individual application attempt, if any. */
  serialCode?: string;
  serialPlan?: SerialCodePlan;
  status: AccountRunStatus;
  paymentState: PaymentRunState;
  paymentCheckpoint?: PaymentDiscoveryCheckpoint;
  selectedPaymentOptions?: PaymentSelection[];
  submissionRecoveryRevision?: number;
  recoveryFenceToken?: string;
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

export type VerificationMailboxMode = "manual" | "imap" | "http-api" | "temp-mail-forwarder" | "auth-mailbox" | "cerise-bouquet";

export interface VerificationMailboxSettings {
  providerId: string;
  mailboxAddress: string;
  mode: VerificationMailboxMode;
  endpoint?: string;
  username?: string;
  senderAllowlist: string[];
  subjectMatchers: string[];
  pollingIntervalMs: number;
  timeoutMs: number;
  secretConfigured: boolean;
  updatedAt?: string;
}

export interface VerificationMailboxUpdate {
  providerId: string;
  mailboxAddress: string;
  mode: VerificationMailboxMode;
  endpoint?: string;
  username?: string;
  password?: string;
  apiToken?: string;
  senderAllowlist: string[];
  subjectMatchers: string[];
  pollingIntervalMs: number;
  timeoutMs: number;
}

export interface ValidationResult {
  ok: boolean;
  message: string;
}

export interface VerificationCodeReadInput {
  recipient?: string;
  startedAt?: string;
  timeoutMs?: number;
}

export interface VerificationCodeReadResult {
  code?: string;
  manualActionRequired: boolean;
  reason: string;
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
  verificationMailbox: VerificationMailboxSettings;
  network: NetworkSettings;
  dataDir: string;
}

export interface CreateTaskInput {
  eventSnapshotId: string;
  preference: LotteryPreference;
  accountIds: string[];
  deviceProfileKey?: DeviceProfileKey;
}

export interface CreateTaskInputV2 extends CreateTaskInput {
  confirmationPolicy: "required" | "disabled";
  automationRiskAcknowledgement?: AutomationRiskAcknowledgement;
}

export interface ManualActionInput {
  runId: string;
  action: "continue" | "cancel-account" | "cancel-task" | "reconcile-unknown";
  verificationCode?: string;
}
