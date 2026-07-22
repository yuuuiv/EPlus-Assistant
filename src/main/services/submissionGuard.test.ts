import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { LotteryPreference, PaymentDiscoveryCheckpoint } from "../../shared/types.js";
import { AppDatabase } from "../storage/database.js";
import { SubmissionGuard, validateDeviceProfileKey } from "./submissionGuard.js";

const directories: string[] = [];

afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });

describe("SubmissionGuard", () => {
  it("rejects CAS mismatches without entering Submitting", async () => {
    const fixture = await createFixture();
    fixture.guard.saveDiscovery(fixture.checkpoint);
    const authorization = fixture.guard.select(selectionInput(fixture.checkpoint), 1);
    const bound = bindReview(fixture, authorization);
    fixture.db.updateRun({ id: fixture.runId, status: "AwaitingSubmitConfirmation", paymentState: "PaymentSelectionApplied" });

    expect(() => fixture.guard.dispatch({ taskId: "task", runId: fixture.runId, authorizationRevision: bound.authorizationRevision ?? 0, nonce: "wrong", contextOwnerToken: "owner", workerPid: 1, workerProcessStartTime: "start" })).toThrow("bindings");
    expect(fixture.db.listRuns()[0]?.status).toBe("AwaitingSubmitConfirmation");
  });

  it("fences recovery, revokes the dispatch lease, and blocks stale dispatch", async () => {
    const fixture = await createFixture();
    fixture.guard.saveDiscovery(fixture.checkpoint);
    const authorization = fixture.guard.select(selectionInput(fixture.checkpoint), 1);
    const bound = bindReview(fixture, authorization);
    fixture.db.updateRun({ id: fixture.runId, status: "AwaitingSubmitConfirmation", paymentState: "PaymentSelectionApplied" });
    const lease = fixture.guard.dispatch({ taskId: "task", runId: fixture.runId, authorizationRevision: bound.authorizationRevision ?? 0, nonce: bound.nonce ?? "", contextOwnerToken: "owner", workerPid: 1, workerProcessStartTime: "start" });

    const fence = fixture.guard.recover(fixture.runId);
    expect(fence.submissionRecoveryRevision).toBe(1);
    expect(fixture.db.getDispatchLease(fixture.runId)?.leaseId).toBe(lease.leaseId);
    expect(fixture.db.getDispatchLease(fixture.runId)?.revokedAt).toBeDefined();
    expect(fixture.db.listRuns()[0]?.status).toBe("UnknownSubmissionState");
  });

  it("rejects invalid device profile keys", () => {
    expect(() => validateDeviceProfileKey("arbitrary-ua")).toThrow("not approved");
    expect(validateDeviceProfileKey(undefined)).toBe("desktop-chrome");
  });

  it("rejects duplicate dispatch while the first lease remains active", async () => {
    const fixture = await createFixture();
    fixture.guard.saveDiscovery(fixture.checkpoint);
    const authorization = fixture.guard.select(selectionInput(fixture.checkpoint), 1);
    const bound = bindReview(fixture, authorization);
    fixture.db.updateRun({ id: fixture.runId, status: "AwaitingSubmitConfirmation", paymentState: "PaymentSelectionApplied" });
    fixture.guard.dispatch(dispatchInput(bound, fixture.runId));

    expect(() => fixture.guard.dispatch(dispatchInput(bound, fixture.runId))).toThrow("bindings");
    expect(fixture.db.listRuns()[0]?.status).toBe("Submitting");
    expect(fixture.db.getDispatchLease(fixture.runId)?.revokedAt).toBeUndefined();
  });

  it("rejects semantic and legacy values that conflict with the discovered candidate", async () => {
    const semantic = await createFixture({ entries: [], paymentPreference: { groupKey: "payment", value: "card" }, consentFlags: {} });
    semantic.guard.saveDiscovery(semantic.checkpoint);
    expect(() => semantic.guard.select(selectionInput(semantic.checkpoint), 1)).toThrow("Semantic payment preference conflicts");

    const legacy = await createFixture({ entries: [], paymentMethodId: "card", consentFlags: {} });
    legacy.guard.saveDiscovery(legacy.checkpoint);
    expect(() => legacy.guard.select(selectionInput(legacy.checkpoint), 1)).toThrow("Legacy payment value conflicts");
  });

  it("preserves a compatible legacy and semantic preference through selection", async () => {
    const fixture = await createFixture({ entries: [], paymentMethodId: "store", paymentPreference: { groupKey: "payment", value: "store" }, consentFlags: {} });
    fixture.guard.saveDiscovery(fixture.checkpoint);

    const authorization = fixture.guard.select(selectionInput(fixture.checkpoint), 1);
    expect(authorization.selectedOptions).toEqual([{ groupKey: "payment", candidateId: "candidate", domValue: "store" }]);
  });

  it("rejects review digest tampering before dispatch", async () => {
    const fixture = await createFixture();
    fixture.guard.saveDiscovery(fixture.checkpoint);
    const authorization = fixture.guard.select(selectionInput(fixture.checkpoint), 1);
    const bound = bindReview(fixture, authorization);
    fixture.db.saveSubmissionAuthorization({ ...bound, reviewDigest: "changed" });
    fixture.db.updateRun({ id: fixture.runId, status: "AwaitingSubmitConfirmation", paymentState: "PaymentSelectionApplied" });

    expect(() => fixture.guard.dispatch(dispatchInput(bound, fixture.runId))).toThrow("bindings");
    expect(fixture.db.listRuns()[0]?.status).toBe("AwaitingSubmitConfirmation");
  });

  it("rejects a checkpoint from another context or device profile", async () => {
    const fixture = await createFixture();
    expect(() => fixture.guard.saveDiscovery({ ...fixture.checkpoint, contextGeneration: "" })).toThrow("context");
    expect(() => fixture.guard.saveDiscovery({ ...fixture.checkpoint, deviceProfileKey: "iphone-13" })).toThrow("context");
    expect(fixture.db.getPaymentCheckpoint(fixture.runId)).toBeUndefined();
  });
});

async function createFixture(preference: LotteryPreference = { entries: [], paymentPreference: { groupKey: "payment", value: "store" }, consentFlags: {} }): Promise<{ db: AppDatabase; guard: SubmissionGuard; checkpoint: PaymentDiscoveryCheckpoint; runId: string }> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "eplus-submission-guard-"));
  directories.push(directory);
  const db = new AppDatabase(directory);
  await db.open();
  const account = db.upsertAccount({ id: "account", eplusEmail: "person@example.test", password: "unused", encryptedPassword: "encrypted", encryptedMailConfig: "mail" });
  db.createTask({ id: "task", eventSnapshotId: "event", preference, accountIds: [account.id], status: "AwaitingConfirmation", confirmationDigest: "digest", deviceProfileKey: "desktop-chrome", createdAt: "2026-07-21T00:00:00.000Z", updatedAt: "2026-07-21T00:00:00.000Z" });
  const run = db.listRunsForTask("task")[0];
  if (!run) throw new Error("Expected run.");
  db.updateRun({ id: run.id, status: "FillingForm", paymentState: "PaymentDiscoveryPending" });
  const checkpoint: PaymentDiscoveryCheckpoint = {
    taskId: "task", runId: run.id, checkpointId: "checkpoint", checkpointRevision: 1, pageFingerprint: "a".repeat(64), controlFingerprint: "b".repeat(64), contextGeneration: "context", deviceProfileKey: "desktop-chrome", discoveredAt: "2026-07-21T00:00:00.000Z", candidateIds: ["candidate"], groupKeys: { payment: ["candidate"] },
    groups: [{ groupKey: "payment", groupOrder: 0, controlType: "input", selectorEvidence: evidence(), options: [{ candidateId: "candidate", groupKey: "payment", groupOrder: 0, optionOrder: 0, controlType: "input", domValue: "store", label: "Store", enabled: true, supported: true, ambiguous: false, selectorEvidence: evidence() }] }]
  };
  return { db, guard: new SubmissionGuard(db, "registry"), checkpoint, runId: run.id };
}

function selectionInput(checkpoint: PaymentDiscoveryCheckpoint) { return { taskId: checkpoint.taskId, runId: checkpoint.runId, checkpointId: checkpoint.checkpointId, checkpointRevision: checkpoint.checkpointRevision, candidateIds: ["candidate"], expectedControlFingerprint: checkpoint.controlFingerprint }; }
function evidence() { return { scope: "document" as const, tag: "input" as const, groupOrdinal: 0, optionOrdinal: 0, allowedAttributes: { name: "payment", type: "radio", dataPaymentGroup: "payment" }, contextGeneration: "context" }; }
function dispatchInput(authorization: { authorizationRevision?: number; nonce?: string }, runId: string) { return { taskId: "task", runId, authorizationRevision: authorization.authorizationRevision ?? 0, nonce: authorization.nonce ?? "", contextOwnerToken: "owner", workerPid: 1, workerProcessStartTime: "start" }; }
function bindReview(fixture: Awaited<ReturnType<typeof createFixture>>, authorization: { authorizationRevision?: number }) { const bound = fixture.guard.bindReview(fixture.runId, "task", { state: "LotteryForm", url: "https://eplus.jp/review", text: "Review" }); if (!bound || bound.authorizationRevision === authorization.authorizationRevision) throw new Error("Expected review-bound authorization."); return bound; }
