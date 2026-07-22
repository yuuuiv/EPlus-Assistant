import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const handlers = new Map<string, (...args: unknown[]) => unknown>();
vi.mock("electron", () => ({
  ipcMain: { handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => handlers.set(channel, handler)) },
  shell: { openPath: vi.fn(async () => "") }
}));

import { registerIpc } from "./ipc.js";
import { AppDatabase } from "./storage/database.js";

const directories: string[] = [];
afterEach(async () => { handlers.clear(); await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });

describe("IPC + preload", () => {
  it("createTaskV2 validates task input before creating a task", async () => {
    const fixture = await createFixture();
    const handler = handlers.get("task:create-v2");
    if (!handler) throw new Error("Task V2 handler was not registered.");

    await expect(handler(rendererEvent(fixture.webContents), { eventSnapshotId: fixture.eventId, accountIds: [fixture.accountId], confirmationPolicy: "disabled", preference: { entries: [], paymentMethodId: "store", consentFlags: {}, daySelectionByAccountId: {} } })).rejects.toThrow("serial code");
  });

  it("performManualAction validates sender and input", async () => {
    const fixture = await createFixture();
    const handler = handlers.get("run:manual-action");
    if (!handler) throw new Error("Manual action handler was not registered.");

    await expect(handler({ sender: {} }, { runId: fixture.runId, action: "continue" })).rejects.toThrow("Unauthorized IPC sender");
    await expect(handler(rendererEvent(fixture.webContents), { runId: fixture.runId, action: "bad" })).rejects.toThrow("Invalid IPC payload");
  });

  it("accepts legacy task payloads without paymentMethodId and rejects arbitrary device or DOM fields", async () => {
    const fixture = await createFixture();
    const create = handlers.get("task:create-v2");
    const select = handlers.get("run:select-payment-options");
    if (!create || !select) throw new Error("Expected payment handlers.");

    await expect(create(rendererEvent(fixture.webContents), { eventSnapshotId: fixture.eventId, accountIds: [fixture.accountId], confirmationPolicy: "disabled", automationRiskAcknowledgement: { version: 1, acknowledgedAt: "2026-07-21T00:00:00.000Z", disclosureDigest: "digest" }, preference: { entries: [], consentFlags: {}, serialCode: "code", daySelectionByAccountId: { [fixture.accountId]: ["day1"] } } })).resolves.toEqual(expect.objectContaining({ taskId: expect.any(String) }));
    await expect(create(rendererEvent(fixture.webContents), { eventSnapshotId: fixture.eventId, accountIds: [fixture.accountId], confirmationPolicy: "disabled", automationRiskAcknowledgement: { version: 1, acknowledgedAt: "2026-07-21T00:00:00.000Z", disclosureDigest: "digest" }, deviceProfileKey: "custom-user-agent", preference: { entries: [], consentFlags: {}, serialCode: "code", daySelectionByAccountId: { [fixture.accountId]: ["day1"] } } })).rejects.toThrow("Invalid IPC payload");
    await expect(select(rendererEvent(fixture.webContents), { taskId: "task", runId: fixture.runId, checkpointId: "checkpoint", checkpointRevision: 1, candidateIds: ["candidate"], expectedControlFingerprint: "a".repeat(64), domValue: "card" })).rejects.toThrow("Invalid IPC payload");
  });

  it("rejects sensitive payment credentials at the IPC task boundary", async () => {
    const fixture = await createFixture();
    const create = handlers.get("task:create-v2");
    if (!create) throw new Error("Expected task handler.");

    await expect(create(rendererEvent(fixture.webContents), { eventSnapshotId: fixture.eventId, accountIds: [fixture.accountId], confirmationPolicy: "disabled", automationRiskAcknowledgement: { version: 1, acknowledgedAt: "2026-07-21T00:00:00.000Z", disclosureDigest: "digest" }, preference: { entries: [], paymentMethodId: "4111111111111111", consentFlags: {}, serialCode: "code", daySelectionByAccountId: { [fixture.accountId]: ["day1"] } } })).rejects.toThrow("Payment credential fields");
  });

  it("saves named node-subset presets and the active preset selection", async () => {
    const fixture = await createFixture();
    const save = handlers.get("settings:save-network");
    const get = handlers.get("settings:get-network");
    if (!save || !get) throw new Error("Expected network settings handlers.");

    await save(rendererEvent(fixture.webContents), { controller: "clash", host: "127.0.0.1", port: 9090, secret: "topsecret", proxyGroup: "Proxies", nodeSubsetPresets: [{ name: "日本优先", nodes: ["node-a", "node-b"] }], activeNodeSubsetPresetName: "日本优先", requiredCountry: "Japan", policy: "required" });
    await save(rendererEvent(fixture.webContents), { controller: "clash", host: "127.0.0.1", port: 9090, nodeSubsetPresets: [{ name: "日本优先", nodes: ["node-a", "node-b"] }, { name: "备用", nodes: ["node-c"] }], activeNodeSubsetPresetName: "备用", requiredCountry: "Japan", policy: "required" });

    const settings = await get(rendererEvent(fixture.webContents), undefined);
    expect(settings).toMatchObject({ proxyGroup: "Proxies", activeNodeSubsetPresetName: "备用", nodeSubsetPresets: [{ name: "日本优先", nodes: ["node-a", "node-b"] }, { name: "备用", nodes: ["node-c"] }] });
  });

  it("rejects the retired flat selectedNodes field and requires a configured controller before listing nodes", async () => {
    const fixture = await createFixture();
    const save = handlers.get("settings:save-network");
    const listNodes = handlers.get("network:list-nodes");
    if (!save || !listNodes) throw new Error("Expected network handlers.");

    await expect(save(rendererEvent(fixture.webContents), { controller: "clash", host: "127.0.0.1", port: 9090, secret: "topsecret", proxyGroup: "Proxies", selectedNodes: ["node-a"], requiredCountry: "Japan", policy: "required" })).rejects.toThrow("Invalid IPC payload");
    await expect(listNodes(rendererEvent(fixture.webContents), undefined)).rejects.toThrow();
  });
});

async function createFixture(): Promise<{ accountId: string; eventId: string; runId: string; webContents: { once: ReturnType<typeof vi.fn>; getURL: () => string } }> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "eplus-ipc-")); directories.push(directory);
  const db = new AppDatabase(directory); await db.open();
  const account = db.upsertAccount({ id: "account", eplusEmail: "person@example.test", password: "unused", encryptedPassword: "encrypted", encryptedMailConfig: "mail" });
  db.saveEventSnapshot({ id: "event", sourceUrl: "https://eplus.jp/source", canonicalUrl: "https://eplus.jp/event", title: "Event", fetchedAt: "2026-07-21T00:00:00.000Z", pageFingerprint: "fp", rawFormSchema: { sourceKind: "serial-code", options: [], applicationLinks: [], serialCode: { required: true, label: "Code", errorSelectors: [], knownErrorMessages: [], availableDays: [{ day: "day1", label: "Day1" }, { day: "day2", label: "Day2" }], daySelectionRequired: true }, selectorHints: {}, requiresManualInspection: false, notes: [] } });
  db.createTask({ id: "task", eventSnapshotId: "event", preference: { entries: [], paymentMethodId: "store", consentFlags: {} }, accountIds: [account.id], status: "AwaitingConfirmation", confirmationDigest: "digest", createdAt: "2026-07-21T00:00:00.000Z", updatedAt: "2026-07-21T00:00:00.000Z" });
  const run = db.listRunsForTask("task")[0]; if (!run) throw new Error("Fixture run was not created.");
  const webContents = { once: vi.fn(), getURL: () => "file:///app/index.html" };
  const secretStore = { encryptString: vi.fn((value: string) => value), decryptString: vi.fn((value: string) => value), encryptJson: vi.fn(), decryptJson: vi.fn() };
  registerIpc({ webContents } as never, db, secretStore as never);
  return { accountId: account.id, eventId: "event", runId: run.id, webContents };
}

function rendererEvent(webContents: { getURL: () => string }): { sender: typeof webContents; senderFrame: { url: string } } {
  return { sender: webContents, senderFrame: { url: webContents.getURL() } };
}
