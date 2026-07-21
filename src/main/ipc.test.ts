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

    expect(() => handler({}, { eventSnapshotId: fixture.eventId, accountIds: [fixture.accountId], confirmationPolicy: "disabled", preference: { entries: [], paymentMethodId: "store", consentFlags: {}, daySelectionByAccountId: {} } })).toThrow("serial code");
  });

  it("performManualAction validates sender and input", async () => {
    const fixture = await createFixture();
    const handler = handlers.get("run:manual-action");
    if (!handler) throw new Error("Manual action handler was not registered.");

    expect(() => handler({ sender: {} }, { runId: fixture.runId, action: "continue" })).toThrow("application window");
    expect(() => handler({ sender: fixture.webContents }, { runId: fixture.runId, action: "bad" })).toThrow("Invalid manual action");
  });
});

async function createFixture(): Promise<{ accountId: string; eventId: string; runId: string; webContents: object }> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "eplus-ipc-")); directories.push(directory);
  const db = new AppDatabase(directory); await db.open();
  const account = db.upsertAccount({ id: "account", eplusEmail: "person@example.test", password: "unused", encryptedPassword: "encrypted", encryptedMailConfig: "mail" });
  db.saveEventSnapshot({ id: "event", sourceUrl: "https://eplus.jp/source", canonicalUrl: "https://eplus.jp/event", title: "Event", fetchedAt: "2026-07-21T00:00:00.000Z", pageFingerprint: "fp", rawFormSchema: { sourceKind: "serial-code", options: [], applicationLinks: [], serialCode: { required: true, label: "Code", errorSelectors: [], knownErrorMessages: [], availableDays: ["day1", "day2"], daySelectionRequired: true }, selectorHints: {}, requiresManualInspection: false, notes: [] } });
  db.createTask({ id: "task", eventSnapshotId: "event", preference: { entries: [], paymentMethodId: "store", consentFlags: {} }, accountIds: [account.id], status: "AwaitingConfirmation", confirmationDigest: "digest", createdAt: "2026-07-21T00:00:00.000Z", updatedAt: "2026-07-21T00:00:00.000Z" });
  const run = db.listRunsForTask("task")[0]; if (!run) throw new Error("Fixture run was not created.");
  const webContents = { once: vi.fn() };
  const secretStore = { encryptString: vi.fn((value: string) => value), decryptString: vi.fn((value: string) => value), encryptJson: vi.fn(), decryptJson: vi.fn() };
  registerIpc({ webContents } as never, db, secretStore as never);
  return { accountId: account.id, eventId: "event", runId: run.id, webContents };
}
