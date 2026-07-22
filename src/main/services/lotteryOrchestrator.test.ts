import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { stableJson } from "../../core/digest.js";
import type { AccountRun, EventOption, EventSnapshot, LotteryTask } from "../../shared/types.js";
import { AppDatabase } from "../storage/database.js";
import { LotteryOrchestrator, recoverSubmittingRuns } from "./lotteryOrchestrator.js";
import { NetworkService } from "./networkService.js";
import { SubmissionGuard } from "./submissionGuard.js";
import type { PageState } from "../engines/pageStateClassifier.js";
import type { ReviewPageData } from "../adapters/eplusAdapter.js";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });

describe("LotteryOrchestrator", () => {
  it("uses the guarded production dispatch path after review verification", async () => {
    const fixture = await createFixture();
    const review: ReviewPageData = { state: "LotteryForm", url: "https://eplus.jp/review", text: "Review" };
    const adapter = adapterFixture(review);
    const orchestrator = createOrchestrator(fixture.db, adapter);
    const authorization = prepareAuthorization(fixture.db, fixture.run.id, digest(review));

    const prepared = await orchestrator.runSingleAccount({ ...fixture, authorization });
    const bound = fixture.db.getSubmissionAuthorization(fixture.run.id);
    if (!bound) throw new Error("Expected bound authorization.");
    const result = await orchestrator.dispatchFinal({ taskId: fixture.task.id, runId: fixture.run.id, authorizationRevision: bound.authorizationRevision ?? 0, nonce: bound.nonce ?? "" });

    expect(prepared.status).toBe("AwaitingSubmitConfirmation");
    expect(result.status).toBe("Submitted");
    expect(result.externalApplicationId).toBe("EP12345678");
    expect(adapter.submitApplication).toHaveBeenCalledOnce();
    expect(fixture.db.getSubmissionIntent(fixture.run.id)?.status).toBe("Acknowledged");
  });

  it("persists runtime payment discovery before candidate-only selection authorizes the run", async () => {
    const fixture = await createFixture();
    const adapter = adapterFixture({ state: "LotteryForm", url: "https://eplus.jp/review", text: "Review" });
    adapter.readAvailableOptions.mockResolvedValue([{ id: "payment", label: "Payment", kind: "payment", required: true, values: [{ id: "payment:store", label: "Store" }], runtimeGroup: { groupKey: "payment", groupOrder: 0, controlType: "input", selectorEvidence: evidence(), options: [{ candidateId: "payment:store", groupKey: "payment", groupOrder: 0, optionOrder: 0, controlType: "input", domValue: "store", label: "Store", enabled: true, supported: true, ambiguous: false, selectorEvidence: evidence() }] } }]);
    const orchestrator = createOrchestrator(fixture.db, adapter);

    const discovered = await orchestrator.runSingleAccount({ ...fixture });
    const checkpoint = fixture.db.getPaymentCheckpoint(fixture.run.id);
    if (!checkpoint) throw new Error("Expected persisted payment checkpoint.");
    const authorization = new SubmissionGuard(fixture.db, "registry").select({ taskId: fixture.task.id, runId: fixture.run.id, checkpointId: checkpoint.checkpointId, checkpointRevision: checkpoint.checkpointRevision, candidateIds: ["payment:store"], expectedControlFingerprint: checkpoint.controlFingerprint }, 1);
    const resumed = await orchestrator.runSingleAccount({ ...fixture, run: fixture.db.listRuns()[0]!, authorization });

    expect(adapter.discoverPaymentOptions).toHaveBeenCalledOnce();
    expect(adapter.readAvailableOptions).not.toHaveBeenCalled();
    expect(discovered.status).toBe("AwaitingManualAction");
    expect(checkpoint.candidateIds).toEqual(["payment:store"]);
    expect(authorization.selectedOptions).toEqual([{ groupKey: "payment", candidateId: "payment:store", domValue: "store" }]);
    expect(resumed.status).toBe("AwaitingSubmitConfirmation");
    expect(adapter.applyPreference).toHaveBeenCalledOnce();
  });

  it("returns to manual action when a bound review changes before confirmation", async () => {
    const fixture = await createFixture();
    const adapter = adapterFixture({ state: "LotteryForm", url: "https://eplus.jp/review", text: "Review" });
    const orchestrator = createOrchestrator(fixture.db, adapter);
    const authorization = prepareAuthorization(fixture.db, fixture.run.id, "review");
    await orchestrator.runSingleAccount({ ...fixture, authorization });
    adapter.readReviewPage.mockResolvedValue({ state: "LotteryForm", url: "https://eplus.jp/review", text: "Changed" });

    const result = await orchestrator.runSingleAccount({ ...fixture, run: fixture.db.listRuns()[0]!, authorization: fixture.db.getSubmissionAuthorization(fixture.run.id)! });

    expect(result.status).toBe("AwaitingManualAction");
    expect(fixture.db.getSubmissionAuthorization(fixture.run.id)?.revokedAt).toBeDefined();
    expect(adapter.submitApplication).not.toHaveBeenCalled();
  });

  it("fences an ambiguous guarded dispatch and reconciliation never resubmits", async () => {
    const fixture = await createFixture();
    const review: ReviewPageData = { state: "LotteryForm", url: "https://eplus.jp/review", text: "Review" };
    const adapter = adapterFixture(review);
    adapter.submitApplication.mockRejectedValue(new Error("timeout"));
    const orchestrator = createOrchestrator(fixture.db, adapter);
    const authorization = prepareAuthorization(fixture.db, fixture.run.id, digest(review));

    await orchestrator.runSingleAccount({ ...fixture, authorization });
    const bound = fixture.db.getSubmissionAuthorization(fixture.run.id);
    if (!bound) throw new Error("Expected bound authorization.");
    await expect(orchestrator.dispatchFinal({ taskId: fixture.task.id, runId: fixture.run.id, authorizationRevision: bound.authorizationRevision ?? 0, nonce: bound.nonce ?? "" })).rejects.toThrow("timeout");
    expect(fixture.db.listRuns()[0]?.status).toBe("UnknownSubmissionState");
    expect(fixture.db.getDispatchLease(fixture.run.id)?.revokedAt).toBeDefined();
    expect(await orchestrator.reconcile({ run: fixture.db.listRuns()[0]!, task: fixture.task })).toBe("Failed");
    expect(adapter.submitApplication).toHaveBeenCalledOnce();
  });

  it("startup recovery fences every persisted submitting run before reconciliation", async () => {
    const fixture = await createFixture();
    const authorization = prepareAuthorization(fixture.db, fixture.run.id, "review");
    fixture.db.updateRun({ id: fixture.run.id, status: "AwaitingSubmitConfirmation", paymentState: "PaymentSelectionApplied" });
    const guard = new SubmissionGuard(fixture.db, "registry");
    const bound = guard.bindReview(fixture.run.id, fixture.task.id, { state: "LotteryForm", url: "https://eplus.jp/review", text: "Review" });
    if (!bound) throw new Error("Expected review-bound authorization.");
    const lease = guard.dispatch({ taskId: fixture.task.id, runId: fixture.run.id, authorizationRevision: bound.authorizationRevision ?? 0, nonce: bound.nonce ?? "", contextOwnerToken: "owner", workerPid: 1, workerProcessStartTime: "start" });

    expect(recoverSubmittingRuns(fixture.db, guard)).toBe(1);
    expect(fixture.db.listRuns()[0]?.status).toBe("UnknownSubmissionState");
    expect(fixture.db.getDispatchLease(fixture.run.id)?.leaseId).toBe(lease.leaseId);
    expect(fixture.db.getDispatchLease(fixture.run.id)?.revokedAt).toBeDefined();
    expect(fixture.db.getRecoveryFence(fixture.run.id)?.submissionRecoveryRevision).toBe(1);
  });

  it("blocks pre-submit navigation when a recovery fence invalidates the worker", async () => {
    const fixture = await createFixture();
    const adapter = adapterFixture({ state: "LotteryForm", url: "https://eplus.jp/review", text: "Review" });
    const orchestrator = createOrchestrator(fixture.db, adapter);
    const authorization = prepareAuthorization(fixture.db, fixture.run.id, "review");
    fixture.db.updateRun({ id: fixture.run.id, status: "AwaitingSubmitConfirmation", paymentState: "PaymentSelectionApplied" });
    const guard = new SubmissionGuard(fixture.db, "registry");
    const bound = guard.bindReview(fixture.run.id, fixture.task.id, { state: "LotteryForm", url: "https://eplus.jp/review", text: "Review" });
    if (!bound) throw new Error("Expected review-bound authorization.");
    guard.dispatch({ taskId: fixture.task.id, runId: fixture.run.id, authorizationRevision: bound.authorizationRevision ?? 0, nonce: bound.nonce ?? "", contextOwnerToken: "owner", workerPid: 1, workerProcessStartTime: "start" });
    guard.recover(fixture.run.id);

    await expect(orchestrator.runSingleAccount({ ...fixture, authorization })).rejects.toThrow("authorization was not issued");
    expect(adapter.openEvent).not.toHaveBeenCalled();
  });

  it("propagates taskId and deviceProfileKey through startNetworkSession", async () => {
    const fixture = await createFixture();
    const taskWithProfile: LotteryTask = { ...fixture.task, deviceProfileKey: "iphone-13" };
    const adapter = adapterFixture({ state: "LotteryForm", url: "https://eplus.jp/review", text: "Review" });
    const engine = { startNetworkSession: vi.fn(async () => true), reuseSession: vi.fn(async () => false), manualTakeover: vi.fn(async () => undefined), close: vi.fn(async () => undefined) };
    const network = new NetworkService({ rotate: vi.fn(async () => undefined), detectIp: vi.fn(async () => ({ ip: "1.1.1.1", country: "Japan", region: "Tokyo" })) }, { getSetting: () => undefined });
    const orchestrator = new LotteryOrchestrator(engine, adapter, network, fixture.db, {}, (cipher) => `decrypted-${cipher}`, new SubmissionGuard(fixture.db, "registry"));

    await expect(orchestrator.runSingleAccount({ ...fixture, task: taskWithProfile })).rejects.toThrow();

    expect(engine.startNetworkSession).toHaveBeenCalledWith(expect.objectContaining({ taskId: fixture.task.id, deviceProfileKey: "iphone-13", launchGuard: expect.any(Function) }));
  });

  it("threads lease validation through submitApplication at the action boundary", async () => {
    const fixture = await createFixture();
    const review: ReviewPageData = { state: "LotteryForm", url: "https://eplus.jp/review", text: "Review" };
    const adapter = adapterFixture(review);
    let validatorCalled = false;
    adapter.submitApplication = vi.fn(async (validator?: () => void) => { validator?.(); validatorCalled = true; return { url: "https://eplus.jp/receipt", receiptText: "受付番号: EP12345678" }; });
    const engine = { startNetworkSession: vi.fn(async () => true), reuseSession: vi.fn(async () => false), manualTakeover: vi.fn(async () => undefined), close: vi.fn(async () => undefined) };
    const network = new NetworkService({ rotate: vi.fn(async () => undefined), detectIp: vi.fn(async () => ({ ip: "1.1.1.1", country: "Japan", region: "Tokyo" })) }, { getSetting: () => undefined });
    const guard = new SubmissionGuard(fixture.db, "registry");
    const orchestrator = new LotteryOrchestrator(engine, adapter, network, fixture.db, {}, (cipher) => `decrypted-${cipher}`, guard);
    prepareAuthorization(fixture.db, fixture.run.id, digest(review));
    await orchestrator.runSingleAccount({ ...fixture, authorization: fixture.db.getSubmissionAuthorization(fixture.run.id)! });
    const bound = fixture.db.getSubmissionAuthorization(fixture.run.id);
    if (!bound) throw new Error("Expected bound authorization.");

    const result = await orchestrator.dispatchFinal({ taskId: fixture.task.id, runId: fixture.run.id, authorizationRevision: bound.authorizationRevision ?? 0, nonce: bound.nonce ?? "" });

    expect(adapter.submitApplication).toHaveBeenCalledWith(expect.any(Function));
    expect(validatorCalled).toBe(true);
    expect(result.status).toBe("Submitted");
  });

  it("rejects dispatch when lease is fenced before the submit action", async () => {
    const fixture = await createFixture();
    const review: ReviewPageData = { state: "LotteryForm", url: "https://eplus.jp/review", text: "Review" };
    const adapter = adapterFixture(review);
    adapter.submitApplication = vi.fn(async () => { throw new Error("should not be reached"); });
    const engine = { startNetworkSession: vi.fn(async () => true), reuseSession: vi.fn(async () => false), manualTakeover: vi.fn(async () => undefined), close: vi.fn(async () => undefined) };
    const network = new NetworkService({ rotate: vi.fn(async () => undefined), detectIp: vi.fn(async () => ({ ip: "1.1.1.1", country: "Japan", region: "Tokyo" })) }, { getSetting: () => undefined });
    const guard = new SubmissionGuard(fixture.db, "registry");
    const orchestrator = new LotteryOrchestrator(engine, adapter, network, fixture.db, {}, (cipher) => `decrypted-${cipher}`, guard);
    prepareAuthorization(fixture.db, fixture.run.id, digest(review));
    await orchestrator.runSingleAccount({ ...fixture, authorization: fixture.db.getSubmissionAuthorization(fixture.run.id)! });
    const bound = fixture.db.getSubmissionAuthorization(fixture.run.id);
    if (!bound) throw new Error("Expected bound authorization.");
    fixture.db.saveRecoveryFence({ runId: fixture.run.id, submissionRecoveryRevision: 1, recoveryFenceToken: "fenced-token", fencedAt: new Date().toISOString() });

    await expect(orchestrator.dispatchFinal({ taskId: fixture.task.id, runId: fixture.run.id, authorizationRevision: bound.authorizationRevision ?? 0, nonce: bound.nonce ?? '' })).rejects.toThrow(/bindings/);

    expect(adapter.submitApplication).not.toHaveBeenCalled();
  });
});

async function createFixture(): Promise<{ db: AppDatabase; task: LotteryTask; run: AccountRun; event: EventSnapshot }> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "eplus-orchestrator-")); directories.push(directory);
  const db = new AppDatabase(directory); await db.open();
  const account = db.upsertAccount({ id: "account", eplusEmail: "person@example.test", password: "unused", encryptedPassword: "encrypted", encryptedMailConfig: "mail" });
  const event: EventSnapshot = { id: "event", sourceUrl: "https://eplus.jp/source", canonicalUrl: "https://eplus.jp/event", title: "Event", fetchedAt: "2026-07-21T00:00:00.000Z", pageFingerprint: "fp", rawFormSchema: { sourceKind: "standard-detail", options: [], applicationLinks: [], serialCode: { required: false, label: "Code", errorSelectors: [], knownErrorMessages: [] }, selectorHints: {}, requiresManualInspection: false, notes: [] } }; db.saveEventSnapshot(event);
  const task: LotteryTask = { id: "task", eventSnapshotId: event.id, preference: { entries: [], paymentMethodId: "store", consentFlags: {} }, accountIds: [account.id], status: "AwaitingConfirmation", confirmationDigest: "digest", createdAt: event.fetchedAt, updatedAt: event.fetchedAt }; db.createTask(task);
  const run = db.listRunsForTask(task.id)[0]; if (!run) throw new Error("Fixture run was not created."); return { db, task, run, event };
}

function adapterFixture(review: ReviewPageData) {
  return { openEvent: vi.fn(async () => undefined), detectChallenge: vi.fn(async (): Promise<PageState> => "LotteryForm"), login: vi.fn(async () => undefined), enterEmailCode: vi.fn(async () => undefined), readAvailableOptions: vi.fn(async (): Promise<EventOption[]> => []), discoverPaymentOptions: vi.fn(async () => ({ status: "ready" as const, groups: [{ groupKey: "payment", groupOrder: 0, controlType: "input" as const, selectorEvidence: evidence(), options: [{ candidateId: "payment:store", groupKey: "payment", groupOrder: 0, optionOrder: 0, controlType: "input" as const, domValue: "store", label: "Store", enabled: true, supported: true, ambiguous: false, selectorEvidence: evidence() }] }] })), applyPreference: vi.fn(async () => undefined), readReviewPage: vi.fn(async () => review), submitApplication: vi.fn(async () => ({ url: "https://eplus.jp/receipt", receiptText: "受付番号: EP12345678" })), readReceipt: vi.fn(async () => ({ url: "https://eplus.jp/receipt", receiptText: "受付番号: EP12345678" })) };
}

function createOrchestrator(db: AppDatabase, adapter: ReturnType<typeof adapterFixture>): LotteryOrchestrator {
  const engine = { startNetworkSession: vi.fn(async () => true), reuseSession: vi.fn(async () => false), manualTakeover: vi.fn(async () => undefined), close: vi.fn(async () => undefined) };
  const network = new NetworkService({ rotate: vi.fn(async () => undefined), detectIp: vi.fn(async () => ({ ip: "1.1.1.1", country: "Japan", region: "Tokyo" })) }, { getSetting: () => undefined });
  return new LotteryOrchestrator(engine, adapter, network, db, {}, (cipher) => `decrypted-${cipher}`, new SubmissionGuard(db, "registry"));
}

function digest(value: unknown): string { return createHash("sha256").update(stableJson(value)).digest("hex"); }

function prepareAuthorization(db: AppDatabase, runId: string, _reviewDigest: string) {
  const run = db.listRuns().find((candidate) => candidate.id === runId);
  if (!run) throw new Error("Expected run.");
  const controlFingerprint = "b".repeat(64);
  const checkpoint = { taskId: "task", runId, checkpointId: "checkpoint", checkpointRevision: 1, pageFingerprint: "a".repeat(64), controlFingerprint, contextGeneration: "context", deviceProfileKey: "desktop-chrome" as const, discoveredAt: "2026-07-21T00:00:00.000Z", candidateIds: ["candidate"], groupKeys: { payment: ["candidate"] }, groups: [{ groupKey: "payment", groupOrder: 0, controlType: "input" as const, selectorEvidence: evidence(), options: [{ candidateId: "candidate", groupKey: "payment", groupOrder: 0, optionOrder: 0, controlType: "input" as const, domValue: "store", label: "Store", enabled: true, supported: true, ambiguous: false, selectorEvidence: evidence() }] }] };
  const guard = new SubmissionGuard(db, "registry");
  db.updateRun({ id: run.id, status: "FillingForm", paymentState: "PaymentDiscoveryPending" });
  guard.saveDiscovery(checkpoint);
  return guard.select({ taskId: "task", runId, checkpointId: "checkpoint", checkpointRevision: 1, candidateIds: ["candidate"], expectedControlFingerprint: controlFingerprint }, 1);
}

function evidence() { return { scope: "document" as const, tag: "input" as const, groupOrdinal: 0, optionOrdinal: 0, allowedAttributes: { name: "payment", type: "radio", dataPaymentGroup: "payment" }, contextGeneration: "context" }; }
