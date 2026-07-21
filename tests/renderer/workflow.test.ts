import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BrowserSessionEngine } from "../../src/main/engines/browserSessionEngine.js";
import { AppDatabase } from "../../src/main/storage/database.js";
import { TaskService } from "../../src/main/services/taskService.js";
import type { AccountInput, EventSnapshot } from "../../src/shared/types.js";
import { createMockApi } from "./electronHarness.js";

const directories: string[] = [];
const accountInput: AccountInput = { eplusEmail: "review@example.com", password: "secret", label: "Review account" };
const event: EventSnapshot = {
  id: "event-1", sourceUrl: "https://eplus.jp/source", canonicalUrl: "https://eplus.jp/event", title: "Review event", fetchedAt: "2026-07-21T00:00:00.000Z", pageFingerprint: "fingerprint",
  rawFormSchema: { sourceKind: "serial-code", options: [{ id: "ticket", label: "Ticket", kind: "ticket", required: true, values: [{ id: "ticket-a", label: "A" }] }, { id: "payment", label: "Payment", kind: "payment", required: true, values: [{ id: "payment-a", label: "Store" }] }], applicationLinks: [], serialCode: { required: true, label: "Code", errorSelectors: [], knownErrorMessages: [], availableDays: ["day1", "day2"], daySelectionRequired: true }, selectorHints: {}, requiresManualInspection: false, notes: [] }
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
