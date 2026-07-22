import { createHash, randomUUID } from "node:crypto";
import { makeIdempotencyKey, makePaymentAuthorizationDigest } from "../../core/digest.js";
import type { ReviewPageData } from "../adapters/eplusAdapter.js";
import { assertPaymentStateForRun } from "../../core/stateMachine.js";
import type { DeviceProfileKey, DispatchLease, PaymentDiscoveryCheckpoint, PaymentSelection, PaymentSelectionInput, RecoveryFence, SubmissionAuthorization } from "../../shared/types.js";
import { PaymentValidationError } from "../../shared/types.js";
import type { AppDatabase } from "../storage/database.js";
import { DEVICE_PROFILE_KEYS } from "../engines/deviceProfiles.js";

export { DEVICE_PROFILE_KEYS } from "../engines/deviceProfiles.js";

export function validateDeviceProfileKey(value: string | undefined): DeviceProfileKey {
  if (value === undefined) return "desktop-chrome";
  if (DEVICE_PROFILE_KEYS.includes(value as DeviceProfileKey)) return value as DeviceProfileKey;
  throw new PaymentValidationError("InvalidDeviceProfile", "Device profile is not approved.");
}

export function validatePaymentCheckpointForTransition(checkpoint: PaymentDiscoveryCheckpoint, input: PaymentSelectionInput): PaymentSelection[] {
  if (checkpoint.taskId !== input.taskId || checkpoint.runId !== input.runId || checkpoint.checkpointId !== input.checkpointId || checkpoint.checkpointRevision !== input.checkpointRevision || checkpoint.controlFingerprint !== input.expectedControlFingerprint) {
    throw new PaymentValidationError("StalePaymentCheckpoint", "Payment discovery checkpoint no longer matches this run.");
  }
  const candidateIds = new Set(input.candidateIds);
  if (candidateIds.size !== input.candidateIds.length || candidateIds.size === 0) throw new PaymentValidationError("InvalidPaymentSelection", "Payment selection candidates must be unique and non-empty.");
  const options = checkpoint.groups.flatMap((group) => group.options);
  const selected = options.filter((option) => candidateIds.has(option.candidateId));
  if (selected.length !== candidateIds.size || selected.some((option) => !option.enabled || !option.supported || option.ambiguous)) throw new PaymentValidationError("InvalidPaymentSelection", "Payment selection contains an unavailable candidate.");
  const groups = new Set(selected.map((option) => option.groupKey));
  if (groups.size !== selected.length) throw new PaymentValidationError("InvalidPaymentSelection", "Only one candidate may be selected for each payment group.");
  return selected.map((option) => ({ groupKey: option.groupKey, candidateId: option.candidateId, domValue: option.domValue }));
}

export class SubmissionGuard {
  constructor(private readonly db: AppDatabase, private readonly deviceRegistryDigest: string) {}

  saveDiscovery(checkpoint: PaymentDiscoveryCheckpoint): void {
    this.db.withImmediateTransaction(() => {
      const run = this.requireRun(checkpoint.runId, checkpoint.taskId);
      const task = this.requireTask(checkpoint.taskId);
      assertPaymentStateForRun(run.status, "PaymentDiscoveryPending");
      if (checkpoint.contextGeneration.trim() === "" || checkpoint.deviceProfileKey !== (task.deviceProfileKey ?? "desktop-chrome")) throw new PaymentValidationError("StalePaymentCheckpoint", "Payment discovery checkpoint is not bound to this task context.");
      this.db.savePaymentCheckpoint(checkpoint);
      this.db.updateRun({ id: run.id, status: "FillingForm", paymentState: "PaymentSelectionPending" });
    });
  }

  select(input: PaymentSelectionInput, acknowledgementVersion: number): SubmissionAuthorization {
    return this.db.withImmediateTransaction(() => {
      const run = this.requireRun(input.runId, input.taskId);
      const task = this.requireTask(input.taskId);
      if ((run.status !== "FillingForm" && run.status !== "AwaitingManualAction") || run.paymentState !== "PaymentSelectionPending") throw new PaymentValidationError("InvalidPaymentSelection", "Payment selection is not pending for this run.");
      const checkpoint = this.db.getPaymentCheckpoint(run.id);
      if (!checkpoint) throw new PaymentValidationError("StalePaymentCheckpoint", "Payment discovery checkpoint is missing.");
      if (checkpoint.deviceProfileKey !== (task.deviceProfileKey ?? "desktop-chrome") || checkpoint.contextGeneration.trim() === "") throw new PaymentValidationError("StalePaymentCheckpoint", "Payment discovery checkpoint is not bound to this task context.");
      const selectedOptions = validatePaymentCheckpointForTransition(checkpoint, input);
      const semantic = task.preference.paymentPreference;
      if (semantic !== undefined && !selectedOptions.some((option) => option.groupKey === semantic.groupKey && option.domValue === semantic.value)) throw new PaymentValidationError("InvalidPaymentSelection", "Semantic payment preference conflicts with discovered payment selection.");
      const legacy = task.preference.paymentMethodId;
      if (legacy !== undefined && !selectedOptions.some((option) => option.groupKey === "payment" && option.domValue === legacy)) throw new PaymentValidationError("InvalidPaymentSelection", "Legacy payment value conflicts with discovered payment selection.");
      const old = this.db.getSubmissionAuthorization(run.id);
      const revision = (old?.authorizationRevision ?? 0) + 1;
      const nonce = randomUUID();
      const now = new Date().toISOString();
      const authorization: SubmissionAuthorization = {
        taskId: task.id, runId: run.id, accountId: run.accountId,
        effectivePreferenceDigest: makePaymentAuthorizationDigest({ taskId: task.id, runId: run.id, preference: task.preference, selectedOptions, deviceProfileKey: checkpoint.deviceProfileKey, deviceRegistryDigest: this.deviceRegistryDigest, pageFingerprint: checkpoint.pageFingerprint, controlFingerprint: checkpoint.controlFingerprint, reviewDigest: "", acknowledgementVersion, authorizationRevision: revision, nonce }),
        reviewDigest: "", idempotencyKey: makeIdempotencyKey({ accountId: run.accountId, canonicalUrl: task.id, preference: task.preference }), policy: "required", acknowledgementVersion, checkpointVersion: checkpoint.checkpointRevision, createdAt: now, expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(), consumed: false,
        authorizationRevision: revision, nonce, checkpointRevision: checkpoint.checkpointRevision, deviceProfileKey: checkpoint.deviceProfileKey, deviceRegistryDigest: this.deviceRegistryDigest, pageFingerprint: checkpoint.pageFingerprint, controlFingerprint: checkpoint.controlFingerprint, selectedOptions, submissionRecoveryRevision: this.db.getRecoveryFence(run.id)?.submissionRecoveryRevision ?? 0, recoveryFenceToken: this.db.getRecoveryFence(run.id)?.recoveryFenceToken ?? ""
      };
      if (old) this.db.saveSubmissionAuthorization({ ...old, revokedAt: now });
      this.db.savePaymentSelections(run.id, selectedOptions);
      this.db.saveSubmissionAuthorization(authorization);
      this.db.updateRun({ id: run.id, status: "FillingForm", paymentState: "PaymentSelectionApplied" });
      return authorization;
    });
  }

  bindReview(runId: string, taskId: string, review: ReviewPageData): SubmissionAuthorization | undefined {
    return this.db.withImmediateTransaction(() => {
      const run = this.requireRun(runId, taskId);
      const task = this.requireTask(taskId);
      const checkpoint = this.db.getPaymentCheckpoint(run.id);
      const authorization = this.db.getSubmissionAuthorization(run.id);
      const selectedOptions = this.db.getPaymentSelections(run.id);
      if (!checkpoint || !authorization || !selectedOptions || selectedOptions.length === 0) throw new PaymentValidationError("StalePaymentCheckpoint", "Review cannot be bound without a selected payment checkpoint.");
      const reviewDigest = createHash("sha256").update(JSON.stringify({ state: review.state, url: review.url, text: review.text })).digest("hex");
      if (authorization.reviewDigest && authorization.reviewDigest !== reviewDigest) {
        const revokedAt = new Date().toISOString();
        this.db.saveSubmissionAuthorization({ ...authorization, revokedAt });
        this.db.updateRun({ id: run.id, status: "AwaitingManualAction", paymentState: "PaymentSelectionApplied", errorDetailRedacted: "Review page changed; payment selection must be reviewed again." });
        return undefined;
      }
      const revision = (authorization.authorizationRevision ?? 0) + 1;
      const nonce = randomUUID();
      const bound: SubmissionAuthorization = {
        ...authorization,
        effectivePreferenceDigest: makePaymentAuthorizationDigest({ taskId: task.id, runId: run.id, preference: task.preference, selectedOptions, deviceProfileKey: checkpoint.deviceProfileKey, deviceRegistryDigest: this.deviceRegistryDigest, pageFingerprint: checkpoint.pageFingerprint, controlFingerprint: checkpoint.controlFingerprint, reviewDigest, acknowledgementVersion: authorization.acknowledgementVersion, authorizationRevision: revision, nonce }),
        reviewDigest,
        authorizationRevision: revision,
        nonce,
        revokedAt: undefined,
        createdAt: new Date().toISOString()
      };
      this.db.saveSubmissionAuthorization(bound);
      return bound;
    });
  }

  assertPersistedSelection(runId: string, taskId: string): void {
    const checkpoint = this.db.getPaymentCheckpoint(runId);
    const selections = this.db.getPaymentSelections(runId);
    if (!checkpoint || !selections || selections.length === 0) throw new PaymentValidationError("StalePaymentCheckpoint", "Verified payment selection is missing.");
    validatePaymentCheckpointForTransition(checkpoint, { taskId, runId, checkpointId: checkpoint.checkpointId, checkpointRevision: checkpoint.checkpointRevision, candidateIds: selections.map((selection) => selection.candidateId), expectedControlFingerprint: checkpoint.controlFingerprint });
  }

  dispatch(input: { taskId: string; runId: string; authorizationRevision: number; nonce: string; contextOwnerToken: string; workerPid: number; workerProcessStartTime: string }): DispatchLease {
    return this.db.withImmediateTransaction(() => {
      const run = this.requireRun(input.runId, input.taskId);
      const task = this.requireTask(input.taskId);
      const authorization = this.db.getSubmissionAuthorization(run.id);
      const checkpoint = this.db.getPaymentCheckpoint(run.id);
      const fence = this.db.getRecoveryFence(run.id);
      const existing = this.db.getDispatchLease(run.id);
      const selectedOptions = this.db.getPaymentSelections(run.id);
      const authorizationDigest = authorization && selectedOptions && checkpoint ? makePaymentAuthorizationDigest({ taskId: task.id, runId: run.id, preference: task.preference, selectedOptions, deviceProfileKey: checkpoint.deviceProfileKey, deviceRegistryDigest: this.deviceRegistryDigest, pageFingerprint: checkpoint.pageFingerprint, controlFingerprint: checkpoint.controlFingerprint, reviewDigest: authorization.reviewDigest, acknowledgementVersion: authorization.acknowledgementVersion, authorizationRevision: authorization.authorizationRevision ?? 0, nonce: authorization.nonce ?? "" }) : undefined;
      if (!authorization || !checkpoint || !authorization.reviewDigest || authorizationDigest !== authorization.effectivePreferenceDigest || run.status !== "AwaitingSubmitConfirmation" || run.paymentState !== "PaymentSelectionApplied" || authorization.authorizationRevision !== input.authorizationRevision || authorization.nonce !== input.nonce || authorization.revokedAt || authorization.consumedAt || authorization.consumed || Date.parse(authorization.expiresAt) <= Date.now() || (existing !== undefined && existing.revokedAt === undefined) || authorization.checkpointRevision !== checkpoint.checkpointRevision || authorization.controlFingerprint !== checkpoint.controlFingerprint || authorization.recoveryFenceToken !== (fence?.recoveryFenceToken ?? "")) {
        throw new PaymentValidationError("DispatchGuardRejected", "Submission dispatch bindings do not match.");
      }
      const issuedAt = new Date().toISOString();
      const lease: DispatchLease = { leaseId: randomUUID(), issuedAt, heartbeatAt: issuedAt, workerPid: input.workerPid, workerProcessStartTime: input.workerProcessStartTime, contextOwnerToken: input.contextOwnerToken, recoveryRevision: fence?.submissionRecoveryRevision ?? 0, recoveryFenceToken: fence?.recoveryFenceToken ?? "" };
      this.db.saveSubmissionAuthorization({ ...authorization, consumed: true, consumedAt: issuedAt });
      this.db.saveDispatchLease(run.id, lease);
      this.db.updateRun({ id: run.id, status: "Submitting", paymentState: "Submitting" });
      return lease;
    });
  }

  assertLiveLease(input: { runId: string; lease: DispatchLease }): void {
    this.db.withImmediateTransaction(() => {
      const run = this.requireRun(input.runId);
      const persisted = this.db.getDispatchLease(run.id);
      const fence = this.db.getRecoveryFence(run.id);
      const heartbeatAgeMs = persisted === undefined ? Number.POSITIVE_INFINITY : Date.now() - Date.parse(persisted.heartbeatAt);
      if (run.status !== "Submitting" || persisted === undefined || persisted.revokedAt !== undefined || persisted.leaseId !== input.lease.leaseId || persisted.issuedAt !== input.lease.issuedAt || persisted.contextOwnerToken !== input.lease.contextOwnerToken || persisted.recoveryRevision !== input.lease.recoveryRevision || persisted.recoveryFenceToken !== input.lease.recoveryFenceToken || persisted.recoveryFenceToken !== (fence?.recoveryFenceToken ?? "") || heartbeatAgeMs > 15_000) {
        throw new PaymentValidationError("DispatchGuardRejected", "Submission lease is stale or fenced.");
      }
      this.db.saveDispatchLease(run.id, { ...persisted, heartbeatAt: new Date().toISOString() });
    });
  }

  assertActionAllowed(input: { taskId: string; runId: string; deviceProfileKey: DeviceProfileKey }): void {
    this.db.withImmediateTransaction(() => {
      const run = this.requireRun(input.runId, input.taskId);
      const task = this.requireTask(input.taskId);
      const checkpoint = this.db.getPaymentCheckpoint(run.id);
      const fence = this.db.getRecoveryFence(run.id);
      const lease = this.db.getDispatchLease(run.id);
      if ((task.deviceProfileKey !== undefined && task.deviceProfileKey !== input.deviceProfileKey) || run.status === "UnknownSubmissionState" || run.status === "Submitting" || (lease !== undefined && lease.revokedAt === undefined) || fence !== undefined) {
        throw new PaymentValidationError("RecoveryFenceRejected", "Browser action is not allowed for this fenced run.");
      }
      if (checkpoint !== undefined && (checkpoint.taskId !== task.id || checkpoint.runId !== run.id || checkpoint.deviceProfileKey !== input.deviceProfileKey)) {
        throw new PaymentValidationError("StalePaymentCheckpoint", "Browser action checkpoint does not match this run.");
      }
    });
  }

  recover(runId: string): RecoveryFence {
    return this.db.withImmediateTransaction(() => {
      const run = this.requireRun(runId);
      if (run.status !== "Submitting") throw new PaymentValidationError("RecoveryFenceRejected", "Only a submitting run may be fenced for recovery.");
      const prior = this.db.getRecoveryFence(run.id);
      const fence: RecoveryFence = { runId: run.id, submissionRecoveryRevision: (prior?.submissionRecoveryRevision ?? 0) + 1, recoveryFenceToken: randomUUID(), fencedAt: new Date().toISOString() };
      const lease = this.db.getDispatchLease(run.id);
      if (lease) this.db.saveDispatchLease(run.id, { ...lease, revokedAt: fence.fencedAt });
      this.db.saveRecoveryFence(fence);
      this.db.updateRun({ id: run.id, status: "UnknownSubmissionState", paymentState: "UnknownSubmissionState" });
      return fence;
    });
  }

  private requireRun(runId: string, taskId?: string) { const run = this.db.listRuns().find((candidate) => candidate.id === runId && (taskId === undefined || candidate.taskId === taskId)); if (!run) throw new PaymentValidationError("StalePaymentCheckpoint", "Account run was not found."); return run; }
  private requireTask(taskId: string) { const task = this.db.listTasks().find((candidate) => candidate.id === taskId); if (!task) throw new PaymentValidationError("StalePaymentCheckpoint", "Lottery task was not found."); return task; }
}
