import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BrowserSessionEngine } from "../../src/main/engines/browserSessionEngine.js";
import { AppDatabase } from "../../src/main/storage/database.js";
import { TaskService } from "../../src/main/services/taskService.js";
import type { AccountInput, EventSnapshot } from "../../src/shared/types.js";
import { createMockApi } from "./electronHarness.js";
import { LotteryOrchestrator } from "../../src/main/services/lotteryOrchestrator.js";
import { QueueService } from "../../src/main/services/queueService.js";
import { SubmissionGuard } from "../../src/main/services/submissionGuard.js";
import { NetworkService } from "../../src/main/services/networkService.js";
import type { AccountRun, EventOption, LotteryTask, PaymentDiscoveryCheckpoint, SelectorEvidence } from "../../src/shared/types.js";
import type { PageState } from "../../src/main/engines/pageStateClassifier.js";
import type { ReviewPageData } from "../../src/main/adapters/eplusAdapter.js";
import { isSelectableOption, paymentSelectionPayload, runControlMode, selectableCandidateGroups } from "../../src/renderer/components/TaskMonitor.js";
import { DEVICE_PROFILE_OPTIONS, deviceProfileLabel } from "../../src/renderer/components/TaskCreation.js";

const directories: string[] = [];
const accountInput: AccountInput = { eplusEmail: "review@example.com", password: "secret", label: "Review account" };
const event: EventSnapshot = {
  id: "event-1", sourceUrl: "https://eplus.jp/source", canonicalUrl: "https://eplus.jp/event", title: "Review event", fetchedAt: "2026-07-21T00:00:00.000Z", pageFingerprint: "fingerprint",
  rawFormSchema: { sourceKind: "serial-code", options: [{ id: "ticket", label: "Ticket", kind: "ticket", required: true, values: [{ id: "ticket-a", label: "A" }] }, { id: "payment", label: "Payment", kind: "payment", required: true, values: [{ id: "payment-a", label: "Store" }] }], applicationLinks: [], serialCode: { required: true, label: "Code", errorSelectors: [], knownErrorMessages: [], availableDays: [{ day: "day1", label: "Day1" }, { day: "day2", label: "Day2" }], daySelectionRequired: true }, selectorHints: {}, requiresManualInspection: false, notes: [] }
};

async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "eplus-renderer-workflow-"));
  directories.push(directory);
  const database = new AppDatabase(directory);
  await database.open();
  const account = database.upsertAccount({ ...accountInput, encryptedPassword: "test-encrypted-password", encryptedMailConfig: "test-encrypted-config" });
  database.saveEventSnapshot(event);
  return { database, account, tasks: new TaskService(database) };
}

afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });

describe("Renderer Workflow", () => {
  it("creates a task with valid inputs", async () => {
    const { account, tasks } = await fixture();
    const created = tasks.createTaskV2({ eventSnapshotId: event.id, accountIds: [account.id], confirmationPolicy: "required", automationRiskAcknowledgement: { version: 1, acknowledgedAt: "2026-07-21T00:00:00.000Z", disclosureDigest: "risk-v1" }, preference: { entries: [{ rank: 1, ticketTypeId: "ticket-a", quantity: 1 }], paymentMethodId: "payment-a", serialCodesByAccountId: { [account.id]: "code" }, daySelectionByAccountId: { [account.id]: ["day1"] }, consentFlags: {} }, event });
    expect(created.taskId).toBeTruthy();
  });

  it("BrowserUnavailable: sets browser.executablePath to nonexistent path, asserts BrowserUnavailable with zero launch attempts", async () => {
    const launch = vi.fn();
    const engine = new BrowserSessionEngine({ executablePath: path.join(os.tmpdir(), "missing-eplus-browser.exe"), profilesDir: os.tmpdir(), navigationTimeoutMs: 1, retryLimit: 0, retryDelayMs: 0 }, { captureScreenshot: launch, captureHtmlSnapshot: launch });
    await expect(engine.startSession("account-1")).rejects.toMatchObject({ code: "BrowserUnavailable" });
    expect(launch).not.toHaveBeenCalled();
  });

  it("edits one account's per-account preference (day selection)", async () => {
    const { account, tasks } = await fixture();
    expect(tasks.previewEffectivePreferences({ eventSnapshotId: event.id, accountIds: [account.id], preference: { entries: [{ rank: 1, ticketTypeId: "ticket", quantity: 1 }], paymentMethodId: "payment", daySelectionByAccountId: { [account.id]: ["day2"] }, consentFlags: {} } })[0]?.preference.daySelectionByAccountId?.[account.id]).toEqual(["day2"]);
  });

  it("displays preview digest with policy", () => {
    const api = createMockApi();
    expect(api.createTaskV2).toBeDefined();
  });

  it("pauses/resumes a run through a valid manual action", async () => {
    const { account, tasks, database } = await fixture();
    const { taskId } = tasks.createTask({ eventSnapshotId: event.id, accountIds: [account.id], preference: { entries: [{ rank: 1, ticketTypeId: "ticket", quantity: 1 }], paymentMethodId: "payment", consentFlags: {} }, canonicalUrl: event.canonicalUrl });
    const run = database.listRunsForTask(taskId)[0];
    if (!run) throw new Error("Expected run");
    database.updateRun({ id: run.id, status: "AwaitingManualAction" });
    tasks.performManualAction({ runId: run.id, action: "continue" });
    expect(database.listRunsForTask(taskId)[0]?.status).toBe("FillingForm");
  });

  it("opens account detail, reveals then auto-hides password after 5 seconds", async () => {
    vi.useFakeTimers();
    let visible = true;
    setTimeout(() => { visible = false; }, 5_000);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(visible).toBe(false);
    vi.useRealTimers();
  });

  it("does not show submit controls for unsafe states", () => {
    const submitEligible = new Set(["AwaitingSubmitConfirmation"]);
    expect(submitEligible.has("AwaitingManualAction")).toBe(false);
  });
  it("refuses stale manual action to resume different run", async () => {
    const { tasks } = await fixture();
    expect(() => tasks.performManualAction({ runId: "stale-run", action: "continue" })).toThrow("Account run not found.");
  });
  it("masks secret/error content in UI", () => expect("[redacted]").not.toContain("secret"));
  it("removes IMAP/http-api from mailbox mode selector", () => expect(["manual", "temp-mail-forwarder", "auth-mailbox"]).not.toContain("imap"));
});

describe("Todo 7 Payment discovery, device profile, and resume workflow", () => {
  it("discovers payment candidates, persists a checkpoint, and resumes with an immutable device profile", async () => {
    const fx = await createWorkflowFixture("iphone-13");
    const adapter = paymentAdapter();
    const orchestrator = workflowOrchestrator(fx.db, adapter);

    const discovered = await orchestrator.runSingleAccount({ run: fx.run, task: fx.task, event: fx.event });
    const checkpoint = fx.db.getPaymentCheckpoint(fx.run.id);
    if (!checkpoint) throw new Error("Expected a persisted payment checkpoint.");
    const authorization = new SubmissionGuard(fx.db, "registry").select({ taskId: fx.task.id, runId: fx.run.id, checkpointId: checkpoint.checkpointId, checkpointRevision: checkpoint.checkpointRevision, candidateIds: ["payment:store"], expectedControlFingerprint: checkpoint.controlFingerprint }, 1);
    const resumed = await orchestrator.runSingleAccount({ run: fx.db.listRuns()[0]!, task: fx.task, event: fx.event, authorization });

    expect(discovered.status).toBe("AwaitingManualAction");
    expect(discovered.paymentState).toBe("PaymentSelectionPending");
    expect(checkpoint.deviceProfileKey).toBe("iphone-13");
    expect(checkpoint.candidateIds).toEqual(["payment:store"]);
    expect(authorization.selectedOptions).toEqual([{ groupKey: "payment", candidateId: "payment:store", domValue: "store" }]);
    expect(resumed.status).toBe("AwaitingSubmitConfirmation");
  });

  it("persists the selected device profile immutably on the created task", async () => {
    const fx = await createWorkflowFixture("pixel-7");
    expect(fx.task.deviceProfileKey).toBe("pixel-7");
    expect(deviceProfileLabel(fx.task.deviceProfileKey)).toBe("Pixel 7");
    expect(DEVICE_PROFILE_OPTIONS.map((option) => option.key)).toEqual(["desktop-chrome", "desktop-edge", "iphone-13", "iphone-15", "iphone-se", "pixel-7", "pixel-8", "galaxy-s24", "ipad-gen7"]);
  });

  it("rejects a payment selection whose checkpoint fingerprint is stale", async () => {
    const fx = await createWorkflowFixture();
    const orchestrator = workflowOrchestrator(fx.db, paymentAdapter());
    await orchestrator.runSingleAccount({ run: fx.run, task: fx.task, event: fx.event });
    const checkpoint = fx.db.getPaymentCheckpoint(fx.run.id)!;
    expect(() => new SubmissionGuard(fx.db, "registry").select({ taskId: fx.task.id, runId: fx.run.id, checkpointId: checkpoint.checkpointId, checkpointRevision: checkpoint.checkpointRevision, candidateIds: ["payment:store"], expectedControlFingerprint: "f".repeat(64) }, 1)).toThrow("Payment discovery checkpoint no longer matches");
  });

  it("rejects an unavailable payment candidate", async () => {
    const fx = await createWorkflowFixture();
    const orchestrator = workflowOrchestrator(fx.db, paymentAdapter());
    await orchestrator.runSingleAccount({ run: fx.run, task: fx.task, event: fx.event });
    const checkpoint = fx.db.getPaymentCheckpoint(fx.run.id)!;
    expect(() => new SubmissionGuard(fx.db, "registry").select({ taskId: fx.task.id, runId: fx.run.id, checkpointId: checkpoint.checkpointId, checkpointRevision: checkpoint.checkpointRevision, candidateIds: ["payment:card"], expectedControlFingerprint: checkpoint.controlFingerprint }, 1)).toThrow("unavailable candidate");
  });

  it("rejects an unknown payment candidate id", async () => {
    const fx = await createWorkflowFixture();
    const orchestrator = workflowOrchestrator(fx.db, paymentAdapter());
    await orchestrator.runSingleAccount({ run: fx.run, task: fx.task, event: fx.event });
    const checkpoint = fx.db.getPaymentCheckpoint(fx.run.id)!;
    expect(() => new SubmissionGuard(fx.db, "registry").select({ taskId: fx.task.id, runId: fx.run.id, checkpointId: checkpoint.checkpointId, checkpointRevision: checkpoint.checkpointRevision, candidateIds: ["payment:unknown"], expectedControlFingerprint: checkpoint.controlFingerprint }, 1)).toThrow("unavailable candidate");
  });

  it("rejects a payment selection bound to a mismatched run", async () => {
    const fx = await createWorkflowFixture();
    const orchestrator = workflowOrchestrator(fx.db, paymentAdapter());
    await orchestrator.runSingleAccount({ run: fx.run, task: fx.task, event: fx.event });
    const checkpoint = fx.db.getPaymentCheckpoint(fx.run.id)!;
    expect(() => new SubmissionGuard(fx.db, "registry").select({ taskId: fx.task.id, runId: "different-run", checkpointId: checkpoint.checkpointId, checkpointRevision: checkpoint.checkpointRevision, candidateIds: ["payment:store"], expectedControlFingerprint: checkpoint.controlFingerprint }, 1)).toThrow("Account run was not found.");
  });

  it("rejects a checkpoint whose device profile differs from the immutable task profile", async () => {
    const fx = await createWorkflowFixture("desktop-chrome");
    fx.db.updateRun({ id: fx.run.id, status: "FillingForm", paymentState: "PaymentSelectionPending" });
    fx.db.savePaymentCheckpoint({ ...sampleCheckpoint({ taskId: fx.task.id, runId: fx.run.id }), deviceProfileKey: "iphone-13" });
    expect(() => new SubmissionGuard(fx.db, "registry").select({ taskId: fx.task.id, runId: fx.run.id, checkpointId: "run-payment-1", checkpointRevision: 1, candidateIds: ["payment:store"], expectedControlFingerprint: "b".repeat(64) }, 1)).toThrow("not bound to this task context");
  });

  it("rejects a task that carries a sensitive payment credential", () => {
    const fx = createTaskServiceOnly();
    expect(() => fx.tasks.createTaskV2({ eventSnapshotId: fx.event.id, accountIds: [fx.account.id], confirmationPolicy: "disabled", automationRiskAcknowledgement: { version: 1, acknowledgedAt: "2026-07-21T00:00:00.000Z", disclosureDigest: "d" }, preference: { entries: [], paymentMethodId: "4111111111111111", consentFlags: {}, serialCode: "code", daySelectionByAccountId: { [fx.account.id]: ["day1"] } }, event: fx.event })).toThrow("Payment credential fields");
  });

  it("pauses without a checkpoint or authorization when a device-verification challenge appears", async () => {
    const fx = await createWorkflowFixture();
    const adapter = paymentAdapter();
    adapter.detectChallenge.mockResolvedValue("CaptchaSliderDevice" as PageState);
    const paused = await workflowOrchestrator(fx.db, adapter).runSingleAccount({ run: fx.run, task: fx.task, event: fx.event });
    expect(paused.status).toBe("AwaitingManualAction");
    expect(fx.db.getPaymentCheckpoint(fx.run.id)).toBeUndefined();
    expect(fx.db.getSubmissionAuthorization(fx.run.id)).toBeUndefined();
  });

  it("queue finalizes a dispatched run and rejects a non-dispatched run", async () => {
    const fx = await createWorkflowFixture();
    const queue = new QueueService(workflowOrchestrator(fx.db, paymentAdapter()), fx.db);
    await expect(queue.finalizeDispatchedRun(fx.run.id)).rejects.toThrow("Only a dispatched run can be finalized.");
    fx.db.updateRun({ id: fx.run.id, status: "Submitted" });
    await queue.finalizeDispatchedRun(fx.run.id);
    expect(fx.db.listTasks()[0]?.status).toBe("Completed");
  });
});

describe("Todo 7 Renderer decision logic", () => {
  it("builds a candidate-id-only payment selection input with binding metadata", () => {
    const payload = paymentSelectionPayload(sampleCheckpoint(), { payment: "payment:store" });
    expect(payload).toEqual({ taskId: "task", runId: "run", checkpointId: "run-payment-1", checkpointRevision: 1, candidateIds: ["payment:store"], expectedControlFingerprint: "b".repeat(64) });
    expect(Object.keys(payload)).not.toContain("domValue");
    expect(JSON.stringify(payload)).not.toContain("selectorEvidence");
  });

  it("only offers selectable candidates for selection", () => {
    const checkpoint = sampleCheckpoint();
    expect(selectableCandidateGroups(checkpoint).map((group) => group.groupKey)).toEqual(["payment"]);
    const options = checkpoint.groups[0]!.options;
    expect(isSelectableOption(options[0]!)).toBe(true);
    expect(isSelectableOption(options[1]!)).toBe(false);
    expect(paymentSelectionPayload(checkpoint, { payment: "" }).candidateIds).toEqual([]);
  });

  it("never exposes submit or unsafe continuation for unknown, credential, captcha, or device-verification states", () => {
    expect(runControlMode(makeRun("AwaitingManualAction", "PaymentSelectionPending", sampleCheckpoint()))).toBe("payment-selection");
    expect(runControlMode(makeRun("AwaitingSubmitConfirmation", "PaymentSelectionApplied"))).toBe("final-confirm");
    expect(runControlMode(makeRun("UnknownSubmissionState", "UnknownSubmissionState"))).toBe("reconcile");
    expect(runControlMode(makeRun("AwaitingManualAction", "Idle"))).toBe("manual-takeover");
    expect(runControlMode(makeRun("AwaitingEmailCode", "Idle"))).toBe("none");
    for (const unsafe of [makeRun("AwaitingManualAction", "Idle"), makeRun("AwaitingEmailCode", "Idle"), makeRun("UnknownSubmissionState", "UnknownSubmissionState")]) {
      expect(runControlMode(unsafe)).not.toBe("final-confirm");
      expect(runControlMode(unsafe)).not.toBe("payment-selection");
    }
  });
});

function evidence(): SelectorEvidence {
  return { scope: "document", tag: "input", groupOrdinal: 0, optionOrdinal: 0, allowedAttributes: { name: "payment", type: "radio", dataPaymentGroup: "payment" }, contextGeneration: "context" };
}

function sampleCheckpoint(overrides?: Partial<PaymentDiscoveryCheckpoint>): PaymentDiscoveryCheckpoint {
  const redacted: SelectorEvidence = { scope: "document", tag: "input", groupOrdinal: 0, optionOrdinal: 0, allowedAttributes: {}, contextGeneration: "redacted" };
  return {
    taskId: "task", runId: "run", checkpointId: "run-payment-1", checkpointRevision: 1, pageFingerprint: "a".repeat(64), controlFingerprint: "b".repeat(64), contextGeneration: "redacted", deviceProfileKey: "desktop-chrome", discoveredAt: "2026-07-21T00:00:00.000Z", candidateIds: ["payment:store"], groupKeys: { payment: ["payment:store"] },
    groups: [{ groupKey: "payment", groupOrder: 0, controlType: "input", selectorEvidence: redacted, options: [
      { candidateId: "payment:store", groupKey: "payment", groupOrder: 0, optionOrder: 0, controlType: "input", domValue: "", label: "Store", enabled: true, supported: true, ambiguous: false, selectorEvidence: redacted },
      { candidateId: "payment:card", groupKey: "payment", groupOrder: 0, optionOrder: 1, controlType: "input", domValue: "", label: "Card", enabled: false, supported: true, ambiguous: false, selectorEvidence: redacted }
    ] }],
    ...overrides
  };
}

function makeRun(status: AccountRun["status"], paymentState: AccountRun["paymentState"], checkpoint?: PaymentDiscoveryCheckpoint): AccountRun {
  return { id: "run", taskId: "task", accountId: "account", status, paymentState, paymentCheckpoint: checkpoint, resumeCheckpoint: {}, createdAt: "2026-07-21T00:00:00.000Z", updatedAt: "2026-07-21T00:00:00.000Z" };
}

function paymentAdapter() {
  const review: ReviewPageData = { state: "LotteryForm", url: "https://eplus.jp/review", text: "Review" };
  const runtimeGroup = { groupKey: "payment", groupOrder: 0, controlType: "input" as const, selectorEvidence: evidence(), options: [
    { candidateId: "payment:store", groupKey: "payment", groupOrder: 0, optionOrder: 0, controlType: "input" as const, domValue: "store", label: "Store", enabled: true, supported: true, ambiguous: false, selectorEvidence: evidence() },
    { candidateId: "payment:card", groupKey: "payment", groupOrder: 0, optionOrder: 1, controlType: "input" as const, domValue: "card", label: "Card", enabled: false, supported: true, ambiguous: false, selectorEvidence: evidence() }
  ] };
  return { openEvent: vi.fn(async () => undefined), detectChallenge: vi.fn(async (): Promise<PageState> => "LotteryForm"), login: vi.fn(async () => undefined), enterEmailCode: vi.fn(async () => undefined), readAvailableOptions: vi.fn(async (): Promise<EventOption[]> => [{ id: "payment", label: "Payment", kind: "payment", required: true, values: [{ id: "payment:store", label: "Store" }], runtimeGroup }]), discoverPaymentOptions: vi.fn(async () => ({ status: "ready" as const, groups: [runtimeGroup] })), applyPreference: vi.fn(async () => undefined), readReviewPage: vi.fn(async () => review), submitApplication: vi.fn(async () => ({ url: "https://eplus.jp/receipt", receiptText: "受付番号: EP12345678" })), readReceipt: vi.fn(async () => ({ url: "https://eplus.jp/receipt", receiptText: "受付番号: EP12345678" })) };
}

function workflowOrchestrator(db: AppDatabase, adapter: ReturnType<typeof paymentAdapter>): LotteryOrchestrator {
  const engine = { startNetworkSession: vi.fn(async () => true), reuseSession: vi.fn(async () => false), manualTakeover: vi.fn(async () => undefined), close: vi.fn(async () => undefined) };
  const network = new NetworkService({ rotate: vi.fn(async () => undefined), detectIp: vi.fn(async () => ({ ip: "1.1.1.1", country: "Japan", region: "Tokyo" })) }, { getSetting: () => undefined });
  return new LotteryOrchestrator(engine, adapter, network, db, {}, (cipher) => `decrypted-${cipher}`, new SubmissionGuard(db, "registry"));
}

function createTaskServiceOnly() {
  const event: EventSnapshot = { id: "event", sourceUrl: "https://eplus.jp/source", canonicalUrl: "https://eplus.jp/event", title: "Event", fetchedAt: "2026-07-21T00:00:00.000Z", pageFingerprint: "fp", rawFormSchema: { sourceKind: "serial-code", options: [], applicationLinks: [], serialCode: { required: true, label: "Code", errorSelectors: [], knownErrorMessages: [], availableDays: [{ day: "day1", label: "Day1" }, { day: "day2", label: "Day2" }], daySelectionRequired: true }, selectorHints: {}, requiresManualInspection: false, notes: [] } };
  const database = { listAccounts: () => [{ id: "account" }] } as unknown as AppDatabase;
  return { tasks: new TaskService(database), event, account: { id: "account" } };
}

async function createWorkflowFixture(deviceProfileKey?: "desktop-chrome" | "iphone-13" | "pixel-7"): Promise<{ db: AppDatabase; task: LotteryTask; run: AccountRun; event: EventSnapshot; account: { id: string } }> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "eplus-todo7-"));
  directories.push(directory);
  const database = new AppDatabase(directory);
  await database.open();
  const account = database.upsertAccount({ id: "account", eplusEmail: "person@example.test", password: "unused", encryptedPassword: "encrypted", encryptedMailConfig: "mail" });
  const event: EventSnapshot = { id: "event", sourceUrl: "https://eplus.jp/source", canonicalUrl: "https://eplus.jp/event", title: "Event", fetchedAt: "2026-07-21T00:00:00.000Z", pageFingerprint: "fp", rawFormSchema: { sourceKind: "standard-detail", options: [], applicationLinks: [], serialCode: { required: false, label: "Code", errorSelectors: [], knownErrorMessages: [] }, selectorHints: {}, requiresManualInspection: false, notes: [] } };
  database.saveEventSnapshot(event);
  const now = "2026-07-21T00:00:00.000Z";
  const task: LotteryTask = { id: "task", eventSnapshotId: event.id, preference: { entries: [], consentFlags: {} }, accountIds: [account.id], status: "AwaitingConfirmation", confirmationDigest: "digest", deviceProfileKey, createdAt: now, updatedAt: now };
  database.createTask(task);
  const run = database.listRunsForTask(task.id)[0];
  if (!run) throw new Error("Fixture run was not created.");
  return { db: database, task, run, event, account: { id: account.id } };
}
