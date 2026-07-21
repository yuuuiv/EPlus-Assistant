import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import initSqlJs from "sql.js";
import { afterEach, describe, expect, it } from "vitest";
import { AppDatabase } from "./database.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("AppDatabase migrations", () => {
  it("preserves current-schema rows while adding the V2 tables", async () => {
    const directory = await tempDirectory();
    const dbFile = path.join(directory, "app.db");
    await createCurrentSchemaFixture(dbFile);

    const database = new AppDatabase(directory, dbFile);
    await database.open();

    expect(database.getSetting<number>("schema_version")).toBe(4);
    expect(database.listAccounts()).toHaveLength(1);
    expect(database.listAccounts()[0]?.eplusEmail).toBe("saved@example.test");
    expect(await hasTable(dbFile, "artifact_manifests")).toBe(true);
  });

  it("rolls back a failed migration without changing the prior schema version or rows", async () => {
    const directory = await tempDirectory();
    const dbFile = path.join(directory, "app.db");
    await createVersionOneFixture(dbFile);

    const database = new AppDatabase(directory, dbFile, (version) => {
      if (version === 2) throw new Error("injected migration failure");
    });

    await expect(database.open()).rejects.toThrow("injected migration failure");
    const bytes = await readFile(dbFile);
    const SQL = await initSqlJs({ locateFile: sqlJsFile });
    const fixture = new SQL.Database(bytes);
    const version = fixture.exec("select value_json from app_settings where key = 'schema_version'");
    const accounts = fixture.exec("select eplus_email from accounts");
    const v2Table = fixture.exec("select name from sqlite_master where type='table' and name='account_profiles'");

    expect(version[0]?.values[0]?.[0]).toBe("1");
    expect(accounts[0]?.values[0]?.[0]).toBe("saved@example.test");
    expect(v2Table).toHaveLength(0);
  });
});

describe("AppDatabase storage primitives", () => {
  it("persists and deletes all account-owned V2 records", async () => {
    const database = await openDatabase();
    const account = database.upsertAccount({ eplusEmail: "person@example.test", password: "unused", encryptedPassword: "encrypted", encryptedMailConfig: "mail" });
    const now = "2026-07-21T00:00:00.000Z";
    database.upsertProfile({ accountId: account.id, eplusEmail: account.eplusEmail, encryptedPassword: "encrypted", revealSupported: true, phone: "08012345678", name: "山田太郎", companions: [{ name: "Companion" }], pastCompanions: [], harvestedAt: now, harvestStatus: "Ok" });
    database.addApplicationRecord({ id: "application", accountId: account.id, eventTitle: "Event", appliedAt: now, ticketType: "General", quantity: 2, applicationId: "EP2024123400012345", status: "Pending", harvestedAt: now });
    database.addLotteryResult({ id: "result", accountId: account.id, eventTitle: "Event", resultKind: "中選", applicationId: "EP2024123400012345", harvestedAt: now });
    database.createProfileHarvestRun({ id: "harvest", accountId: account.id, status: "Pending", harvestedFields: [], startedAt: now });
    database.updateProfileHarvestRun({ id: "harvest", status: "Completed", harvestedFields: ["name"], completedAt: now });
    database.createRevealSession({ id: "reveal", accountId: account.id, requestId: "request", senderWindowId: "window", createdAt: now, expiresAt: "2099-01-01T00:00:00.000Z", consumed: false });
    database.createTask({ id: "task", eventSnapshotId: "event", preference: { entries: [], paymentMethodId: "card", consentFlags: {} }, accountIds: [account.id], status: "AwaitingConfirmation", confirmationDigest: "digest", createdAt: now, updatedAt: now });
    const run = database.listRunsForTask("task")[0];
    if (!run) throw new Error("Expected account run.");
    database.addArtifactManifest({ id: "artifact", runId: run.id, stepId: "step", kind: "html-snapshot", filePath: "opaque.html", maskedSelectors: [".secret"], createdAt: now });

    expect(database.getProfile(account.id)?.name).toBe("山田太郎");
    expect(database.listApplicationRecords(account.id)).toHaveLength(1);
    expect(database.listLotteryResults(account.id)).toHaveLength(1);
    expect(database.consumeRevealSession("request", "window")?.consumed).toBe(true);
    expect(database.listArtifactsForRun(run.id)).toHaveLength(1);

    database.deleteAccount(account.id);

    expect(database.getProfile(account.id)).toBeUndefined();
    expect(database.listApplicationRecords(account.id)).toHaveLength(0);
    expect(database.listLotteryResults(account.id)).toHaveLength(0);
    expect(database.getRevealSession("request")).toBeUndefined();
  });

  it("rolls back a task when one of its account runs cannot be created", async () => {
    const database = await openDatabase();
    const account = database.upsertAccount({ eplusEmail: "person@example.test", password: "unused", encryptedPassword: "encrypted", encryptedMailConfig: "mail" });
    const now = "2026-07-21T00:00:00.000Z";

    expect(() => database.createTask({ id: "task", eventSnapshotId: "event", preference: { entries: [], paymentMethodId: "card", consentFlags: {} }, accountIds: [account.id, "missing-account"], status: "AwaitingConfirmation", confirmationDigest: "digest", createdAt: now, updatedAt: now })).toThrow();
    expect(database.listTasks()).toHaveLength(0);
    expect(database.listRuns()).toHaveLength(0);
  });
});

async function openDatabase(): Promise<AppDatabase> {
  const directory = await tempDirectory();
  const database = new AppDatabase(directory);
  await database.open();
  return database;
}

async function tempDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "eplus-storage-"));
  directories.push(directory);
  return directory;
}

async function createCurrentSchemaFixture(dbFile: string): Promise<void> {
  await createFixture(dbFile, 0);
}

async function createVersionOneFixture(dbFile: string): Promise<void> {
  await createFixture(dbFile, 1);
}

async function createFixture(dbFile: string, schemaVersion: number): Promise<void> {
  const SQL = await initSqlJs({ locateFile: sqlJsFile });
  const fixture = new SQL.Database();
  fixture.exec(`create table accounts (id text primary key, label text not null, eplus_email text not null unique, encrypted_eplus_password text not null, mail_provider_id text not null, encrypted_mail_config text not null, tags_json text not null, enabled integer not null, last_login_at text, last_login_status text not null, created_at text not null, updated_at text not null); create table app_settings (key text primary key, value_json text not null, updated_at text not null);`);
  fixture.run("insert into accounts values (?,?,?,?,?,?,?,?,?,?,?,?)", ["account", "Saved", "saved@example.test", "encrypted", "manual", "mail", "[]", 1, null, "Unknown", "2026-07-21T00:00:00.000Z", "2026-07-21T00:00:00.000Z"]);
  if (schemaVersion > 0) fixture.run("insert into app_settings values (?,?,?)", ["schema_version", JSON.stringify(schemaVersion), "2026-07-21T00:00:00.000Z"]);
  await writeFile(dbFile, Buffer.from(fixture.export()));
}

async function hasTable(dbFile: string, name: string): Promise<boolean> {
  const SQL = await initSqlJs({ locateFile: sqlJsFile });
  const db = new SQL.Database(await readFile(dbFile));
  return db.exec("select name from sqlite_master where type='table' and name=?", [name]).length > 0;
}

function sqlJsFile(file: string): string {
  return path.join(process.cwd(), "node_modules", "sql.js", "dist", file);
}
