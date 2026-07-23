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
  it("registers exactly the trimmed account-management channel set", async () => {
    await createFixture();
    expect(new Set(handlers.keys())).toEqual(new Set([
      "app:get-state",
      "account:add",
      "account:import",
      "account:import-harvest",
      "account:delete",
      "account:reveal-password",
      "profile:get",
      "profile:list-lottery-records",
      "stats:get-overview",
      "app:open-data-folder"
    ]));
  });

  it("rejects an unexpected sender before every registered handler parses its payload", async () => {
    await createFixture();

    const results = await Promise.allSettled([...handlers.values()].map((handler) => Promise.resolve(handler({ sender: {} }))));
    expect(results).toHaveLength(handlers.size);
    for (const result of results) {
      expect(result.status).toBe("rejected");
      if (result.status === "rejected") expect(result.reason).toMatchObject({ message: "Unauthorized IPC sender." });
    }
  });

  it("account:add validates sender identity and rejects malformed payloads", async () => {
    const fixture = await createFixture();
    const addAccount = requireHandler("account:add");

    await expect(addAccount({ sender: {} }, { eplusEmail: "person@example.test", password: "secret" })).rejects.toThrow("Unauthorized IPC sender");
    await expect(addAccount(rendererEvent(fixture.webContents), { eplusEmail: "not-an-email", password: "secret" })).rejects.toThrow("Invalid IPC payload");
    await expect(addAccount(rendererEvent(fixture.webContents), { eplusEmail: "person@example.test", password: "secret" })).resolves.toMatchObject({ eplusEmail: "person@example.test" });
  });

  it("account:import-harvest validates the harvest JSON shape and matches an existing account by email", async () => {
    const fixture = await createFixture();
    const importHarvest = requireHandler("account:import-harvest");

    await expect(importHarvest(rendererEvent(fixture.webContents), { payload: { schemaVersion: 2, eplusEmail: "a@example.test", collectedAt: "now", profile: {}, creditCards: [], companions: [], lotteryRecords: [] } })).rejects.toThrow("Invalid IPC payload");

    const result = await importHarvest(rendererEvent(fixture.webContents), {
      payload: {
        schemaVersion: 1,
        eplusEmail: fixture.accountEmail,
        collectedAt: "2026-07-23T00:00:00.000Z",
        profile: { name: "Taro" },
        creditCards: [],
        companions: [],
        lotteryRecords: [{ orderId: "order-1", tourName: "Event", status: "当選" }]
      }
    });
    expect(result).toMatchObject({ accountId: fixture.accountId, accountCreated: false, report: { inserted: 1 } });
  });

  it("account:import-harvest tolerates the userscript's extra harvestedPages field instead of rejecting it", async () => {
    const fixture = await createFixture();
    const importHarvest = requireHandler("account:import-harvest");

    const result = await importHarvest(rendererEvent(fixture.webContents), {
      payload: {
        schemaVersion: 1,
        eplusEmail: fixture.accountEmail,
        collectedAt: "2026-07-23T00:00:00.000Z",
        profile: { name: "Taro" },
        creditCards: [],
        companions: [],
        lotteryRecords: [],
        harvestedPages: { "update-member": "2026-07-23T00:00:00.000Z" }
      }
    });
    expect(result).toMatchObject({ accountId: fixture.accountId, accountCreated: false });
  });
});

function requireHandler(channel: string): (...args: unknown[]) => Promise<unknown> {
  const handler = handlers.get(channel);
  if (!handler) throw new Error(`Expected ${channel} handler.`);
  return async (...args) => handler(...args);
}

async function createFixture(): Promise<{ accountId: string; accountEmail: string; webContents: { once: ReturnType<typeof vi.fn>; getURL: () => string } }> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "eplus-ipc-security-"));
  directories.push(directory);
  const db = new AppDatabase(directory);
  await db.open();
  const account = db.upsertAccount({ id: "account", eplusEmail: "person@example.test", password: "unused", encryptedPassword: "encrypted", encryptedMailConfig: "mail" });
  const webContents = { once: vi.fn(), getURL: () => "file:///app/index.html" };
  registerIpc({ webContents } as never, db, { encryptString: vi.fn((value: string) => value), decryptString: vi.fn((value: string) => value), encryptJson: vi.fn(() => "{}"), decryptJson: vi.fn() } as never);
  return { accountId: account.id, accountEmail: account.eplusEmail, webContents };
}

function rendererEvent(webContents: { getURL: () => string }): { sender: typeof webContents; senderFrame: { url: string } } {
  return { sender: webContents, senderFrame: { url: webContents.getURL() } };
}
