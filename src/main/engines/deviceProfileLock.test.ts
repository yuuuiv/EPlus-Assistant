import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DeviceProfileLock, DeviceProfileLockError, type ProcessIdentity, type ProcessInspector } from "./deviceProfileLock.js";

const identity = (pid: number, processStartTime: string): ProcessIdentity => ({ pid, processStartTime });
const record = { accountId: "account", runId: "run", deviceProfileKey: "desktop-chrome", registryDigest: "digest", contextGeneration: 1 };

async function fixture() {
  return mkdtemp(path.join(os.tmpdir(), "eplus-device-lock-"));
}

describe("device profile lock", () => {
  it("rejects active locks and refreshes a heartbeat", async () => {
    const directory = await fixture();
    const inspector: ProcessInspector = { identity: () => identity(10, "start-a"), isAlive: async () => true };
    const first = new DeviceProfileLock(directory, inspector);
    await first.acquire(record);
    const second = new DeviceProfileLock(directory, inspector);
    await expect(second.acquire({ ...record, runId: "run-2" })).rejects.toMatchObject({ code: "Active" });
    const before = await readFile(path.join(directory, ".owner.lock"), "utf8");
    await first.heartbeat();
    expect(await readFile(path.join(directory, ".owner.lock"), "utf8")).not.toBe(before);
    await first.release();
    await rm(directory, { recursive: true, force: true });
  });

  it("reclaims stale dead locks but rejects PID reuse", async () => {
    const directory = await fixture();
    const stale = { ...record, ownerPid: 10, ownerProcessStartTime: "old", heartbeatAt: new Date(Date.now() - 31_000).toISOString() };
    await writeFile(path.join(directory, ".owner.lock"), JSON.stringify(stale));
    const dead: ProcessInspector = { identity: () => identity(11, "new"), isAlive: async () => false };
    await expect(new DeviceProfileLock(directory, dead).acquire(record)).resolves.toMatchObject({ ownerPid: 11 });
    const reused = { ...stale, ownerPid: 11, ownerProcessStartTime: "different" };
    await writeFile(path.join(directory, ".owner.lock"), JSON.stringify(reused));
    const sameProcess: ProcessInspector = { identity: () => identity(11, "new"), isAlive: async (value) => value.pid === 11 && value.processStartTime === "different" };
    await expect(new DeviceProfileLock(directory, sameProcess).acquire(record)).rejects.toMatchObject({ code: "Active" });
    await rm(directory, { recursive: true, force: true });
  });

  it("fences a worker after its lock is replaced", async () => {
    const directory = await fixture();
    const inspector: ProcessInspector = { identity: () => identity(10, "start"), isAlive: async () => true };
    const lock = new DeviceProfileLock(directory, inspector);
    await lock.acquire(record);
    await writeFile(path.join(directory, ".owner.lock"), JSON.stringify({ ...record, ownerPid: 99, ownerProcessStartTime: "other", heartbeatAt: new Date().toISOString() }));
    await expect(lock.heartbeat()).rejects.toBeInstanceOf(DeviceProfileLockError);
    await rm(directory, { recursive: true, force: true });
  });
});
