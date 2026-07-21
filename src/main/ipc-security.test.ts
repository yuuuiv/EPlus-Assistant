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

describe("IPC Security", () => {
  it("queue commands validate sender identity and payloads", async () => {
    const fixture = await createFixture();
    const enqueue = requireHandler("queue:enqueue-task");
    const pause = requireHandler("queue:pause");

    await expect(enqueue({ sender: {} }, fixture.taskId)).rejects.toThrow("application window");
    await expect(enqueue({ sender: fixture.webContents }, "")).rejects.toThrow();
    await expect(pause({ sender: {} })).rejects.toThrow("application window");
  });

  it("manual actions validate runId, action, sender, and stale run ownership", async () => {
    const fixture = await createFixture();
    const manualAction = requireHandler("run:manual-action");

    await expect(manualAction({ sender: {} }, { runId: fixture.runId, action: "continue" })).rejects.toThrow("application window");
    await expect(manualAction({ sender: fixture.webContents }, { runId: fixture.runId, action: "forged" })).rejects.toThrow();
    await expect(manualAction({ sender: fixture.webContents }, { runId: fixture.runId, action: "continue" })).rejects.toThrow("manual checkpoint");
  });

  it("does not register renderer-controlled status mutation channels", async () => {
    await createFixture();
    expect(handlers.has("task:update-status")).toBe(false);
    expect(handlers.has("run:update-status")).toBe(false);
  });
});

function requireHandler(channel: string): (...args: unknown[]) => Promise<unknown> {
  const handler = handlers.get(channel);
  if (!handler) throw new Error(`Expected ${channel} handler.`);
  return async (...args) => handler(...args);
}

async function createFixture(): Promise<{ taskId: string; runId: string; webContents: object }> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "eplus-ipc-security-"));
  directories.push(directory);
  const db = new AppDatabase(directory);
  await db.open();
  const account = db.upsertAccount({ id: "account", eplusEmail: "person@example.test", password: "unused", encryptedPassword: "encrypted", encryptedMailConfig: "mail" });
  db.saveEventSnapshot({ id: "event", sourceUrl: "https://eplus.jp/source", canonicalUrl: "https://eplus.jp/event", title: "Event", fetchedAt: "2026-07-21T00:00:00.000Z", pageFingerprint: "fp", rawFormSchema: { sourceKind: "standard-detail", options: [], applicationLinks: [], serialCode: { required: false, label: "Code", errorSelectors: [], knownErrorMessages: [] }, selectorHints: {}, requiresManualInspection: false, notes: [] } });
  db.createTask({ id: "task", eventSnapshotId: "event", preference: { entries: [], paymentMethodId: "store", consentFlags: {} }, accountIds: [account.id], status: "AwaitingConfirmation", confirmationDigest: "digest", createdAt: "2026-07-21T00:00:00.000Z", updatedAt: "2026-07-21T00:00:00.000Z" });
  const run = db.listRunsForTask("task")[0];
  if (!run) throw new Error("Expected fixture run.");
  const webContents = { once: vi.fn() };
  registerIpc({ webContents } as never, db, { encryptString: vi.fn((value: string) => value), decryptString: vi.fn((value: string) => value), encryptJson: vi.fn(), decryptJson: vi.fn() } as never);
  return { taskId: "task", runId: run.id, webContents };
}
