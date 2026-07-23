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
  it("upgrades a fresh database straight to the current schema", async () => {
    const database = await openDatabase();
    expect(database.getSetting<number>("schema_version")).toBe(10);
    const dbFile = path.join(database.getDataDir(), "app.db");
    expect(await hasTable(dbFile, "lottery_records")).toBe(true);
    expect(await hasTable(dbFile, "account_runs")).toBe(false);
    expect(await hasTable(dbFile, "lottery_tasks")).toBe(false);
  });

  it("carries accounts and profiles forward from the pre-trim (v9) schema and drops the retired automation tables", async () => {
    const directory = await tempDirectory();
    const dbFile = path.join(directory, "app.db");
    await createLegacyV9Fixture(dbFile);

    const database = new AppDatabase(directory, dbFile);
    await database.open();

    expect(database.getSetting<number>("schema_version")).toBe(10);
    expect(database.listAccounts()).toHaveLength(1);
    expect(database.listAccounts()[0]?.eplusEmail).toBe("saved@example.test");
    const profile = database.getProfile("account");
    expect(profile?.name).toBe("山田太郎");
    // birthday (legacy column) is carried into the new birthYear field.
    expect(profile?.birthYear).toBe("1990");
    expect(await hasTable(dbFile, "application_records")).toBe(false);
    expect(await hasTable(dbFile, "account_runs")).toBe(false);
    expect(await hasTable(dbFile, "lottery_records")).toBe(true);
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
  it("persists and deletes all account-owned records", async () => {
    const database = await openDatabase();
    const account = database.upsertAccount({ eplusEmail: "person@example.test", password: "unused", encryptedPassword: "encrypted", encryptedMailConfig: "mail" });
    const now = "2026-07-21T00:00:00.000Z";
    database.upsertProfile({ accountId: account.id, eplusEmail: account.eplusEmail, encryptedPassword: "encrypted", revealSupported: true, phone: "08012345678", name: "山田太郎", nameKana: "ヤマダタロウ", gender: "男性", birthYear: "1990年", creditCards: [{ brand: "Visa", last4: "1234" }], companions: [{ name: "Companion" }], pastCompanions: [], harvestedAt: now, harvestStatus: "Ok" });
    database.upsertLotteryRecords(account.id, [{ id: "record", accountId: account.id, orderId: "order-1", tourName: "Event", status: "当選", harvestedAt: now }]);
    database.createRevealSession({ id: "reveal", accountId: account.id, requestId: "request", senderWindowId: "window", createdAt: now, expiresAt: "2099-01-01T00:00:00.000Z", consumed: false });

    expect(database.getProfile(account.id)?.name).toBe("山田太郎");
    expect(database.getProfile(account.id)?.creditCards).toEqual([{ brand: "Visa", last4: "1234" }]);
    expect(database.listLotteryRecords(account.id)).toHaveLength(1);
    expect(database.listLotteryRecords(account.id)[0]?.status).toBe("当選");
    expect(database.consumeRevealSession("request", "window")?.consumed).toBe(true);

    database.deleteAccount(account.id);

    expect(database.getProfile(account.id)).toBeUndefined();
    expect(database.listLotteryRecords(account.id)).toHaveLength(0);
    expect(database.getRevealSession("request")).toBeUndefined();
  });

  it("upserts lottery records by (account, orderId) instead of duplicating them", async () => {
    const database = await openDatabase();
    const account = database.upsertAccount({ eplusEmail: "person@example.test", password: "unused", encryptedPassword: "encrypted", encryptedMailConfig: "mail" });
    const now = "2026-07-21T00:00:00.000Z";
    database.upsertLotteryRecords(account.id, [{ id: "r1", accountId: account.id, orderId: "order-1", tourName: "Event", status: "抽選前", harvestedAt: now }]);
    database.upsertLotteryRecords(account.id, [{ id: "r2", accountId: account.id, orderId: "order-1", tourName: "Event", status: "当選", harvestedAt: now }]);

    const records = database.listLotteryRecords(account.id);
    expect(records).toHaveLength(1);
    expect(records[0]?.status).toBe("当選");
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

async function createVersionOneFixture(dbFile: string): Promise<void> {
  const SQL = await initSqlJs({ locateFile: sqlJsFile });
  const fixture = new SQL.Database();
  fixture.exec(`create table accounts (id text primary key, label text not null, eplus_email text not null unique, encrypted_eplus_password text not null, mail_provider_id text not null, encrypted_mail_config text not null, tags_json text not null, enabled integer not null, last_login_at text, last_login_status text not null, created_at text not null, updated_at text not null); create table app_settings (key text primary key, value_json text not null, updated_at text not null);`);
  fixture.run("insert into accounts values (?,?,?,?,?,?,?,?,?,?,?,?)", ["account", "Saved", "saved@example.test", "encrypted", "manual", "mail", "[]", 1, null, "Unknown", "2026-07-21T00:00:00.000Z", "2026-07-21T00:00:00.000Z"]);
  await writeFile(dbFile, Buffer.from(fixture.export()));
}

/** A database that already ran the original migrations up through v9 (the last version before
 *  the automation stack was retired), to prove the v10 migration carries real user data forward. */
async function createLegacyV9Fixture(dbFile: string): Promise<void> {
  const SQL = await initSqlJs({ locateFile: sqlJsFile });
  const fixture = new SQL.Database();
  fixture.exec(`
    create table accounts (id text primary key, label text not null, eplus_email text not null unique, encrypted_eplus_password text not null, mail_provider_id text not null, encrypted_mail_config text not null, tags_json text not null, enabled integer not null, last_login_at text, last_login_status text not null, created_at text not null, updated_at text not null);
    create table event_snapshots (id text primary key, source_url text not null, canonical_url text not null, title text not null, venue text, schedule_text text, application_deadline text, fetched_at text not null, raw_form_schema_json text not null, page_fingerprint text not null);
    create table lottery_tasks (id text primary key, event_snapshot_id text not null, preference_json text not null, account_ids_json text not null, status text not null, confirmation_digest text not null, created_at text not null, updated_at text not null, device_profile_key text);
    create table account_runs (id text primary key, task_id text not null, account_id text not null, status text not null, external_application_id text, resume_checkpoint_json text not null, error_code text, error_detail_redacted text, created_at text not null, updated_at text not null, payment_state text not null default 'Idle', serial_code text, serial_plan_json text);
    create table audit_logs (id text primary key, task_id text, account_run_id text, level text not null, message text not null, metadata_json text not null, created_at text not null);
    create table app_settings (key text primary key, value_json text not null, updated_at text not null);
    create table account_profiles (id text primary key, account_id text not null unique, eplus_email text not null, encrypted_password text not null, reveal_supported integer not null default 0, phone text, name text, gender text, birthday text, address text, companions_json text not null default '[]', past_companions_json text not null default '[]', harvested_at text, harvest_status text not null default 'Pending', created_at text not null, updated_at text not null, credit_cards_json text not null default '[]');
    create table application_records (id text primary key, account_id text not null, event_title text not null, applied_at text not null, session_or_day text, ticket_type text not null, quantity integer not null, application_id text, status text not null, harvested_at text not null, created_at text not null);
    create table lottery_result_records (id text primary key, account_id text not null, event_title text not null, result_kind text not null, decided_at text, payment_deadline text, application_id text, harvested_at text not null, created_at text not null);
    create table profile_harvest_runs (id text primary key, account_id text not null, status text not null, harvested_fields_json text not null default '[]', error_detail text, started_at text not null, completed_at text);
    create table artifact_manifests (id text primary key, account_run_id text not null, step_id text not null, kind text not null, file_path text not null, masked_selectors_json text not null default '[]', created_at text not null);
    create table password_reveal_sessions (id text primary key, account_id text not null, request_id text not null unique, sender_window_id text not null, created_at text not null, expires_at text not null, consumed integer not null default 0);
    create table submission_authorizations (run_id text primary key, authorization_json text not null, created_at text not null);
    create table submission_intents (run_id text primary key, intent_json text not null);
    create table payment_checkpoints (run_id text primary key, checkpoint_json text not null);
    create table payment_selections (run_id text primary key, selection_json text not null);
    create table dispatch_leases (run_id text primary key, lease_json text not null);
    create table recovery_fences (run_id text primary key, fence_json text not null);
  `);
  const now = "2026-07-21T00:00:00.000Z";
  fixture.run("insert into accounts values (?,?,?,?,?,?,?,?,?,?,?,?)", ["account", "Saved", "saved@example.test", "encrypted", "manual", "mail", "[]", 1, null, "Unknown", now, now]);
  fixture.run("insert into account_profiles (id,account_id,eplus_email,encrypted_password,reveal_supported,phone,name,gender,birthday,address,companions_json,past_companions_json,harvested_at,harvest_status,created_at,updated_at,credit_cards_json) values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", ["profile", "account", "saved@example.test", "encrypted", 1, "08000000000", "山田太郎", "男性", "1990", "Tokyo", "[]", "[]", now, "Ok", now, now, "[]"]);
  fixture.run("insert into app_settings values (?,?,?)", ["schema_version", "9", now]);
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
