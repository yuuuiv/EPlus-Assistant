import { mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

export interface DeviceProfileLockRecord {
  readonly accountId: string;
  readonly runId: string;
  readonly deviceProfileKey: string;
  readonly registryDigest: string;
  readonly contextGeneration: number;
  readonly ownerPid: number;
  readonly ownerProcessStartTime: string;
  readonly heartbeatAt: string;
}

export interface ProcessIdentity {
  readonly pid: number;
  readonly processStartTime: string;
}

export interface ProcessInspector {
  identity(): ProcessIdentity;
  isAlive(identity: ProcessIdentity): Promise<boolean>;
}

const DEFAULT_MAX_AGE_MS = 30_000;

export class DeviceProfileLockError extends Error {
  readonly name = "DeviceProfileLockError";
  constructor(readonly code: "Active" | "OwnershipLost" | "Invalid", message: string) {
    super(message);
  }
}

const localProcessIdentity = { pid: process.pid, processStartTime: new Date(Date.now() - process.uptime() * 1000).toISOString() };
const localProcessInspector: ProcessInspector = {
  identity: () => localProcessIdentity,
  isAlive: async (identity) => {
    if (identity.pid !== process.pid) return false;
    return identity.processStartTime === localProcessIdentity.processStartTime;
  }
};

export class DeviceProfileLock {
  private readonly lockPath: string;
  private record: DeviceProfileLockRecord | undefined;

  constructor(
    private readonly profileDir: string,
    private readonly inspector: ProcessInspector = localProcessInspector,
    private readonly maxAgeMs = DEFAULT_MAX_AGE_MS
  ) {
    this.lockPath = path.join(profileDir, ".owner.lock");
  }

  async acquire(record: Omit<DeviceProfileLockRecord, "ownerPid" | "ownerProcessStartTime" | "heartbeatAt">): Promise<DeviceProfileLockRecord> {
    await mkdir(this.profileDir, { recursive: true });
    const identity = this.inspector.identity();
    const candidate: DeviceProfileLockRecord = {
      ...record,
      ownerPid: identity.pid,
      ownerProcessStartTime: identity.processStartTime,
      heartbeatAt: new Date().toISOString()
    };
    try {
      const handle = await open(this.lockPath, "wx");
      await handle.writeFile(JSON.stringify(candidate));
      await handle.close();
      this.record = candidate;
      return candidate;
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error;
      const existing = await this.read();
      if (!existing) throw new DeviceProfileLockError("Invalid", "The device profile lock is unreadable.");
      const age = Date.now() - Date.parse(existing.heartbeatAt);
      if (age < this.maxAgeMs || await this.inspector.isAlive({ pid: existing.ownerPid, processStartTime: existing.ownerProcessStartTime })) {
        throw new DeviceProfileLockError("Active", "The device profile is already owned by an active run.");
      }
      await this.replaceIfUnchanged(existing, candidate);
      this.record = candidate;
      return candidate;
    }
  }

  async heartbeat(): Promise<DeviceProfileLockRecord> {
    if (!this.record) throw new DeviceProfileLockError("OwnershipLost", "No device profile lock is owned by this worker.");
    const existing = await this.read();
    if (!existing || JSON.stringify(existing) !== JSON.stringify(this.record)) throw new DeviceProfileLockError("OwnershipLost", "The device profile lock was replaced.");
    const next = { ...this.record, heartbeatAt: new Date().toISOString() };
    await this.replaceIfUnchanged(existing, next);
    this.record = next;
    return next;
  }

  async release(): Promise<void> {
    if (!this.record) return;
    const existing = await this.read();
    if (existing && JSON.stringify(existing) === JSON.stringify(this.record)) await rm(this.lockPath, { force: true });
    this.record = undefined;
  }

  private async read(): Promise<DeviceProfileLockRecord | undefined> {
    try {
      return JSON.parse(await readFile(this.lockPath, "utf8")) as DeviceProfileLockRecord;
    } catch {
      return undefined;
    }
  }

  private async replaceIfUnchanged(expected: DeviceProfileLockRecord, next: DeviceProfileLockRecord): Promise<void> {
    const current = await this.read();
    if (!current || JSON.stringify(current) !== JSON.stringify(expected)) throw new DeviceProfileLockError("OwnershipLost", "The device profile lock changed concurrently.");
    const temporaryPath = `${this.lockPath}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temporaryPath, JSON.stringify(next), { flag: "wx" });
    await rename(temporaryPath, this.lockPath);
  }
}
