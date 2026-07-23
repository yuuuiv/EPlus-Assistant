import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import initSqlJs, { type Database, type SqlJsStatic } from "sql.js";
import type {
  Account,
  AccountInput,
  AccountProfile,
  AuditLog,
  LotteryRecord
} from "../../shared/types.js";

type SqlValue = string | number | Uint8Array | null;
type Row = Record<string, string | number | null>;

interface AccountRow extends Row {
  id: string;
  label: string;
  eplus_email: string;
  encrypted_eplus_password: string;
  mail_provider_id: string;
  encrypted_mail_config: string;
  tags_json: string;
  enabled: number;
  last_login_at: string | null;
  last_login_status: string;
  created_at: string;
  updated_at: string;
}

export interface StoredAccount extends Account {
  encryptedEplusPassword: string;
  encryptedMailConfig: string;
}

export interface StoredRevealSession {
  id: string;
  accountId: string;
  requestId: string;
  senderWindowId: string;
  createdAt: string;
  expiresAt: string;
  consumed: boolean;
}

const MIGRATIONS: ReadonlyArray<{ readonly version: number; readonly sql: string }> = [
  {
    version: 1,
    sql: `
      create table if not exists accounts (id text primary key, label text not null, eplus_email text not null unique, encrypted_eplus_password text not null, mail_provider_id text not null, encrypted_mail_config text not null, tags_json text not null, enabled integer not null, last_login_at text, last_login_status text not null, created_at text not null, updated_at text not null);
      create table if not exists event_snapshots (id text primary key, source_url text not null, canonical_url text not null, title text not null, venue text, schedule_text text, application_deadline text, fetched_at text not null, raw_form_schema_json text not null, page_fingerprint text not null);
      create table if not exists lottery_tasks (id text primary key, event_snapshot_id text not null, preference_json text not null, account_ids_json text not null, status text not null, confirmation_digest text not null, created_at text not null, updated_at text not null);
      create table if not exists account_runs (id text primary key, task_id text not null, account_id text not null, status text not null, external_application_id text, resume_checkpoint_json text not null, error_code text, error_detail_redacted text, created_at text not null, updated_at text not null, foreign key(task_id) references lottery_tasks(id) on delete cascade, foreign key(account_id) references accounts(id) on delete cascade);
      create table if not exists audit_logs (id text primary key, task_id text, account_run_id text, level text not null, message text not null, metadata_json text not null, created_at text not null);
      create table if not exists app_settings (key text primary key, value_json text not null, updated_at text not null);
    `
  },
  {
    version: 2,
    sql: `
      create table if not exists account_profiles (id text primary key, account_id text not null unique, eplus_email text not null, encrypted_password text not null, reveal_supported integer not null default 0, phone text, name text, gender text, birthday text, address text, companions_json text not null default '[]', past_companions_json text not null default '[]', harvested_at text, harvest_status text not null default 'Pending', created_at text not null, updated_at text not null, foreign key(account_id) references accounts(id) on delete cascade);
      create table if not exists application_records (id text primary key, account_id text not null, event_title text not null, applied_at text not null, session_or_day text, ticket_type text not null, quantity integer not null, application_id text, status text not null, harvested_at text not null, created_at text not null, foreign key(account_id) references accounts(id) on delete cascade);
      create table if not exists lottery_result_records (id text primary key, account_id text not null, event_title text not null, result_kind text not null, decided_at text, payment_deadline text, application_id text, harvested_at text not null, created_at text not null, foreign key(account_id) references accounts(id) on delete cascade);
      create table if not exists profile_harvest_runs (id text primary key, account_id text not null, status text not null, harvested_fields_json text not null default '[]', error_detail text, started_at text not null, completed_at text, foreign key(account_id) references accounts(id) on delete cascade);
      create table if not exists artifact_manifests (id text primary key, account_run_id text not null, step_id text not null, kind text not null, file_path text not null, masked_selectors_json text not null default '[]', created_at text not null, foreign key(account_run_id) references account_runs(id) on delete cascade);
      create table if not exists password_reveal_sessions (id text primary key, account_id text not null, request_id text not null unique, sender_window_id text not null, created_at text not null, expires_at text not null, consumed integer not null default 0, foreign key(account_id) references accounts(id) on delete cascade);
      create index if not exists idx_application_records_account on application_records(account_id);
      create index if not exists idx_lottery_results_account on lottery_result_records(account_id);
      create index if not exists idx_artifact_manifests_run on artifact_manifests(account_run_id);
      create index if not exists idx_password_reveal_sessions_request on password_reveal_sessions(request_id);
    `
  },
  {
    version: 3,
    sql: `
      create unique index if not exists idx_application_records_refresh_identity on application_records(account_id, event_title, application_id) where application_id is not null;
      create unique index if not exists idx_lottery_results_refresh_identity on lottery_result_records(account_id, event_title, application_id) where application_id is not null;
    `
  },
  {
    version: 4,
    sql: `
      create table if not exists submission_authorizations (run_id text primary key, authorization_json text not null, created_at text not null, foreign key(run_id) references account_runs(id) on delete cascade);
      create table if not exists submission_intents (run_id text primary key, intent_json text not null, foreign key(run_id) references account_runs(id) on delete cascade);
    `
  },
  {
    version: 5,
    sql: `
      alter table account_runs add column payment_state text not null default 'Idle';
      alter table lottery_tasks add column device_profile_key text;
    `
  },
  {
    version: 6,
    sql: `
      create table if not exists payment_checkpoints (run_id text primary key, checkpoint_json text not null, foreign key(run_id) references account_runs(id) on delete cascade);
      create table if not exists payment_selections (run_id text primary key, selection_json text not null, foreign key(run_id) references account_runs(id) on delete cascade);
      create table if not exists dispatch_leases (run_id text primary key, lease_json text not null, foreign key(run_id) references account_runs(id) on delete cascade);
      create table if not exists recovery_fences (run_id text primary key, fence_json text not null, foreign key(run_id) references account_runs(id) on delete cascade);
    `
  },
  {
    version: 7,
    sql: `
      alter table account_profiles add column credit_cards_json text not null default '[]';
    `
  },
  {
    version: 8,
    sql: `
      alter table account_runs add column serial_code text;
    `
  },
  {
    version: 9,
    sql: `
      alter table account_runs add column serial_plan_json text;
    `
  },
  {
    // The Playwright-driven login/task-queue/payment-submission automation was replaced by a
    // browser userscript (userscript/eplus-collector.user.js) that the user runs manually and
    // then imports as JSON - so the whole run/task/payment/event-snapshot pipeline is retired
    // here. Accounts and account_profiles (real user data) are kept and carried forward;
    // application_records/lottery_result_records are dropped rather than migrated because they
    // came from a parser with guessed, never-validated selectors and aren't worth preserving.
    version: 10,
    sql: `
      drop table if exists artifact_manifests;
      drop table if exists submission_authorizations;
      drop table if exists submission_intents;
      drop table if exists payment_checkpoints;
      drop table if exists payment_selections;
      drop table if exists dispatch_leases;
      drop table if exists recovery_fences;
      drop table if exists account_runs;
      drop table if exists lottery_tasks;
      drop table if exists profile_harvest_runs;
      drop table if exists application_records;
      drop table if exists lottery_result_records;
      drop table if exists event_snapshots;
      alter table account_profiles add column name_kana text;
      alter table account_profiles add column birth_year text;
      update account_profiles set birth_year = birthday where birthday is not null and birth_year is null;
      create table if not exists lottery_records (id text primary key, account_id text not null, order_id text not null, tour_name text not null, event_datetime text, venue_name text, reception_name text, order_datetime text, status text not null, status_detail text, detail_url text, harvested_at text not null, created_at text not null, foreign key(account_id) references accounts(id) on delete cascade);
      create unique index if not exists idx_lottery_records_identity on lottery_records(account_id, order_id);
    `
  }
];

export class AppDatabase {
  private SQL?: SqlJsStatic;
  private db?: Database;
  private transactionDepth = 0;

  constructor(
    private readonly dataDir: string,
    private readonly dbFile = path.join(dataDir, "app.db"),
    private readonly beforeMigration?: (version: number) => void
  ) {}

  async open(): Promise<void> {
    mkdirSync(this.dataDir, { recursive: true });
    this.SQL = await initSqlJs({ locateFile: (file) => path.join(process.cwd(), "node_modules", "sql.js", "dist", file) });
    this.db = existsSync(this.dbFile) ? new this.SQL.Database(readFileSync(this.dbFile)) : new this.SQL.Database();
    this.migrate();
    this.exec("pragma foreign_keys = on");
    this.save();
  }

  getDataDir(): string { return this.dataDir; }
  listAccounts(): Account[] { return this.query<AccountRow>("select * from accounts order by created_at desc").map(toAccount); }
  getStoredAccount(id: string): StoredAccount | undefined { const row = this.query<AccountRow>("select * from accounts where id = ?", [id])[0]; return row ? toStoredAccount(row) : undefined; }
  findAccountByEmail(email: string): StoredAccount | undefined { const row = this.query<AccountRow>("select * from accounts where lower(eplus_email) = lower(?)", [email])[0]; return row ? toStoredAccount(row) : undefined; }

  upsertAccount(input: AccountInput & { id?: string; encryptedPassword: string; encryptedMailConfig: string }): Account {
    const now = new Date().toISOString(); const existing = input.id ? this.getStoredAccount(input.id) : this.findAccountByEmail(input.eplusEmail); const id = existing?.id ?? randomUUID();
    this.run(`insert into accounts (id,label,eplus_email,encrypted_eplus_password,mail_provider_id,encrypted_mail_config,tags_json,enabled,last_login_at,last_login_status,created_at,updated_at) values (?,?,?,?,?,?,?,?,?,?,?,?) on conflict(id) do update set label=excluded.label,eplus_email=excluded.eplus_email,encrypted_eplus_password=excluded.encrypted_eplus_password,mail_provider_id=excluded.mail_provider_id,encrypted_mail_config=excluded.encrypted_mail_config,tags_json=excluded.tags_json,enabled=excluded.enabled,updated_at=excluded.updated_at`, [id, input.label?.trim() || input.eplusEmail, input.eplusEmail.trim(), input.encryptedPassword, input.mailProviderId || "manual", input.encryptedMailConfig, JSON.stringify(input.tags ?? []), input.enabled === false ? 0 : 1, existing?.lastLoginAt ?? null, existing?.lastLoginStatus ?? "Unknown", existing?.createdAt ?? now, now]);
    const stored = this.getStoredAccount(id); if (!stored) throw new Error("Account write failed."); return stored;
  }
  deleteAccount(id: string): void { this.inTransaction(() => { this.run("delete from account_profiles where account_id=?", [id]); this.run("delete from lottery_records where account_id=?", [id]); this.run("delete from password_reveal_sessions where account_id=?", [id]); this.run("delete from accounts where id=?", [id]); }); }

  upsertProfile(profile: AccountProfile): AccountProfile { const now = new Date().toISOString(); this.run(`insert into account_profiles (id,account_id,eplus_email,encrypted_password,reveal_supported,phone,name,name_kana,gender,birth_year,address,credit_cards_json,companions_json,past_companions_json,harvested_at,harvest_status,created_at,updated_at) values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) on conflict(account_id) do update set eplus_email=excluded.eplus_email,encrypted_password=excluded.encrypted_password,reveal_supported=excluded.reveal_supported,phone=coalesce(excluded.phone,account_profiles.phone),name=coalesce(excluded.name,account_profiles.name),name_kana=coalesce(excluded.name_kana,account_profiles.name_kana),gender=coalesce(excluded.gender,account_profiles.gender),birth_year=coalesce(excluded.birth_year,account_profiles.birth_year),address=coalesce(excluded.address,account_profiles.address),credit_cards_json=excluded.credit_cards_json,companions_json=excluded.companions_json,past_companions_json=excluded.past_companions_json,harvested_at=excluded.harvested_at,harvest_status=excluded.harvest_status,updated_at=excluded.updated_at`, [randomUUID(), profile.accountId, profile.eplusEmail, profile.encryptedPassword, profile.revealSupported ? 1 : 0, profile.phone ?? null, profile.name ?? null, profile.nameKana ?? null, profile.gender ?? null, profile.birthYear ?? null, profile.address ?? null, JSON.stringify(profile.creditCards ?? []), JSON.stringify(profile.companions), JSON.stringify(profile.pastCompanions), profile.harvestedAt, profile.harvestStatus, now, now]); return profile; }
  getProfile(accountId: string): AccountProfile | undefined { const row = this.query<Row>("select * from account_profiles where account_id=?",[accountId])[0]; return row ? rowToProfile(row) : undefined; }
  deleteProfile(accountId: string): void { this.run("delete from account_profiles where account_id=?",[accountId]); }

  upsertLotteryRecords(accountId: string, records: readonly LotteryRecord[]): LotteryRecord[] { this.inTransaction(() => { for (const record of records) this.run("insert into lottery_records (id,account_id,order_id,tour_name,event_datetime,venue_name,reception_name,order_datetime,status,status_detail,detail_url,harvested_at,created_at) values (?,?,?,?,?,?,?,?,?,?,?,?,?) on conflict(account_id,order_id) do update set tour_name=excluded.tour_name,event_datetime=excluded.event_datetime,venue_name=excluded.venue_name,reception_name=excluded.reception_name,order_datetime=excluded.order_datetime,status=excluded.status,status_detail=excluded.status_detail,detail_url=excluded.detail_url,harvested_at=excluded.harvested_at", [record.id, accountId, record.orderId, record.tourName, record.eventDatetime ?? null, record.venueName ?? null, record.receptionName ?? null, record.orderDatetime ?? null, record.status, record.statusDetail ?? null, record.detailUrl ?? null, record.harvestedAt, new Date().toISOString()]); }); return this.listLotteryRecords(accountId); }
  listLotteryRecords(accountId: string): LotteryRecord[] { return this.query<Row>("select * from lottery_records where account_id=? order by harvested_at desc",[accountId]).map(rowToLotteryRecord); }

  createRevealSession(session: StoredRevealSession): StoredRevealSession { this.run("insert into password_reveal_sessions (id,account_id,request_id,sender_window_id,created_at,expires_at,consumed) values (?,?,?,?,?,?,?)",[session.id,session.accountId,session.requestId,session.senderWindowId,session.createdAt,session.expiresAt,session.consumed ? 1 : 0]); return session; }
  getRevealSession(requestId: string): StoredRevealSession | undefined { const row=this.query<Row>("select * from password_reveal_sessions where request_id=?",[requestId])[0]; return row ? rowToRevealSession(row) : undefined; }
  consumeRevealSession(requestId: string, senderWindowId: string): StoredRevealSession | undefined { const session=this.getRevealSession(requestId); if (!session || session.senderWindowId !== senderWindowId || session.consumed || Date.parse(session.expiresAt) <= Date.now()) return undefined; this.run("update password_reveal_sessions set consumed=1 where request_id=?",[requestId]); return {...session,consumed:true}; }

  getSetting<T>(key: string): T | undefined { const row=this.query<Row>("select value_json from app_settings where key=?",[key])[0]; return row ? JSON.parse(text(row.value_json)) as T : undefined; }
  setSetting(key: string, value: unknown): void { this.run("insert into app_settings (key,value_json,updated_at) values (?,?,?) on conflict(key) do update set value_json=excluded.value_json,updated_at=excluded.updated_at",[key,JSON.stringify(value),new Date().toISOString()]); }
  addLog(log: Omit<AuditLog,"id"|"createdAt">): AuditLog { const row={id:randomUUID(),createdAt:new Date().toISOString(),...log}; this.run("insert into audit_logs (id,level,message,metadata_json,created_at) values (?,?,?,?,?)",[row.id,row.level,row.message,JSON.stringify(row.metadata),row.createdAt]); return row; }
  listLogs(limit=200): AuditLog[] { return this.query<Row>("select * from audit_logs order by created_at desc limit ?",[limit]).map((row)=>({id:text(row.id),level:text(row.level) as AuditLog["level"],message:text(row.message),metadata:JSON.parse(text(row.metadata_json)),createdAt:text(row.created_at)})); }

  private migrate(): void { this.runMigrations(this.hasTable("app_settings") ? this.getSetting<number>("schema_version") ?? 0 : 0); }
  private runMigrations(fromVersion: number): void { for (const migration of MIGRATIONS) if (migration.version > fromVersion) this.inTransaction(() => { this.beforeMigration?.(migration.version); this.exec(migration.sql); this.setSetting("schema_version",migration.version); }); }
  private inTransaction<T>(action: () => T, begin = "BEGIN"): T { this.exec(begin); this.transactionDepth += 1; try { const value=action(); this.exec("COMMIT"); this.save(); return value; } catch (error) { this.exec("ROLLBACK"); throw error; } finally { this.transactionDepth -= 1; } }
  private exec(sql: string): void { this.assertOpen().exec(sql); }
  private run(sql: string, params: SqlValue[] = []): void { const statement=this.assertOpen().prepare(sql); try { statement.bind(params); statement.step(); } finally { statement.free(); } if (this.transactionDepth === 0) this.save(); }
  private query<T extends Record<string, unknown>>(sql: string, params: SqlValue[] = []): T[] { const statement=this.assertOpen().prepare(sql); const rows:T[]=[]; try { statement.bind(params); while(statement.step()) rows.push(statement.getAsObject() as T); } finally { statement.free(); } return rows; }
  private hasTable(name: string): boolean { return this.query<Row>("select name from sqlite_master where type='table' and name=?", [name]).length > 0; }
  private save(): void { writeFileSync(this.dbFile,Buffer.from(this.assertOpen().export())); }
  private assertOpen(): Database { if (!this.db) throw new Error("Database is not open."); return this.db; }
}

function text(value: string | number | null): string { return String(value ?? ""); }
function optional(value: string | number | null): string | undefined { return value === null ? undefined : String(value); }
function toAccount(row: AccountRow): Account { return {id:row.id,label:row.label,eplusEmail:row.eplus_email,mailProviderId:row.mail_provider_id,tags:JSON.parse(row.tags_json),enabled:Boolean(row.enabled),lastLoginAt:row.last_login_at ?? undefined,lastLoginStatus:row.last_login_status as Account["lastLoginStatus"],createdAt:row.created_at,updatedAt:row.updated_at}; }
function toStoredAccount(row: AccountRow): StoredAccount { return {...toAccount(row),encryptedEplusPassword:row.encrypted_eplus_password,encryptedMailConfig:row.encrypted_mail_config}; }
function rowToProfile(row: Row): AccountProfile { return {accountId:text(row.account_id),eplusEmail:text(row.eplus_email),encryptedPassword:text(row.encrypted_password),revealSupported:Boolean(row.reveal_supported),phone:optional(row.phone),name:optional(row.name),nameKana:optional(row.name_kana),gender:optional(row.gender),birthYear:optional(row.birth_year),address:optional(row.address),creditCards:JSON.parse(text(row.credit_cards_json || "[]")),companions:JSON.parse(text(row.companions_json)),pastCompanions:JSON.parse(text(row.past_companions_json)),harvestedAt:text(row.harvested_at),harvestStatus:text(row.harvest_status) as AccountProfile["harvestStatus"]}; }
function rowToLotteryRecord(row: Row): LotteryRecord { return {id:text(row.id),accountId:text(row.account_id),orderId:text(row.order_id),tourName:text(row.tour_name),eventDatetime:optional(row.event_datetime),venueName:optional(row.venue_name),receptionName:optional(row.reception_name),orderDatetime:optional(row.order_datetime),status:text(row.status),statusDetail:optional(row.status_detail),detailUrl:optional(row.detail_url),harvestedAt:text(row.harvested_at)}; }
function rowToRevealSession(row: Row): StoredRevealSession { return {id:text(row.id),accountId:text(row.account_id),requestId:text(row.request_id),senderWindowId:text(row.sender_window_id),createdAt:text(row.created_at),expiresAt:text(row.expires_at),consumed:Boolean(row.consumed)}; }
