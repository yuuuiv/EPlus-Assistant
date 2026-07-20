import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import initSqlJs, { type Database, type SqlJsStatic } from "sql.js";
import type {
  Account,
  AccountInput,
  AccountProfile,
  AccountRun,
  AccountRunStatus,
  ApplicationRecord,
  ArtifactManifest,
  AuditLog,
  EventSnapshot,
  LotteryResultRecord,
  LotteryTask,
  ProfileHarvestRun,
  ProfileHarvestRunStatus,
  TaskStatus
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
  deleteAccount(id: string): void { this.inTransaction(() => { this.run("delete from artifact_manifests where account_run_id in (select id from account_runs where account_id=?)", [id]); this.run("delete from account_runs where account_id=?", [id]); this.run("delete from account_profiles where account_id=?", [id]); this.run("delete from application_records where account_id=?", [id]); this.run("delete from lottery_result_records where account_id=?", [id]); this.run("delete from profile_harvest_runs where account_id=?", [id]); this.run("delete from password_reveal_sessions where account_id=?", [id]); this.run("delete from accounts where id=?", [id]); }); }

  saveEventSnapshot(snapshot: EventSnapshot): EventSnapshot { this.run(`insert into event_snapshots (id,source_url,canonical_url,title,venue,schedule_text,application_deadline,fetched_at,raw_form_schema_json,page_fingerprint) values (?,?,?,?,?,?,?,?,?,?) on conflict(id) do update set canonical_url=excluded.canonical_url,title=excluded.title,venue=excluded.venue,schedule_text=excluded.schedule_text,application_deadline=excluded.application_deadline,fetched_at=excluded.fetched_at,raw_form_schema_json=excluded.raw_form_schema_json,page_fingerprint=excluded.page_fingerprint`, [snapshot.id,snapshot.sourceUrl,snapshot.canonicalUrl,snapshot.title,snapshot.venue ?? null,snapshot.scheduleText ?? null,snapshot.applicationDeadline ?? null,snapshot.fetchedAt,JSON.stringify(snapshot.rawFormSchema),snapshot.pageFingerprint]); return snapshot; }
  listEvents(): EventSnapshot[] { return this.query<Row>("select * from event_snapshots order by fetched_at desc").map((row) => ({ id: text(row.id), sourceUrl: text(row.source_url), canonicalUrl: text(row.canonical_url), title: text(row.title), venue: optional(row.venue), scheduleText: optional(row.schedule_text), applicationDeadline: optional(row.application_deadline), fetchedAt: text(row.fetched_at), rawFormSchema: JSON.parse(text(row.raw_form_schema_json)), pageFingerprint: text(row.page_fingerprint) })); }
  getEvent(id: string): EventSnapshot | undefined { return this.listEvents().find((event) => event.id === id); }

  createTask(task: LotteryTask): LotteryTask { this.inTransaction(() => { this.run(`insert into lottery_tasks (id,event_snapshot_id,preference_json,account_ids_json,status,confirmation_digest,created_at,updated_at) values (?,?,?,?,?,?,?,?)`, [task.id,task.eventSnapshotId,JSON.stringify(task.preference),JSON.stringify(task.accountIds),task.status,task.confirmationDigest,task.createdAt,task.updatedAt]); for (const accountId of task.accountIds) this.createRun({ id: randomUUID(),taskId: task.id,accountId,status: "Pending",resumeCheckpoint: {},createdAt: task.createdAt,updatedAt: task.createdAt }); }); return task; }
  listTasks(): LotteryTask[] { return this.query<Row>("select * from lottery_tasks order by created_at desc").map((row) => ({ id:text(row.id),eventSnapshotId:text(row.event_snapshot_id),preference:JSON.parse(text(row.preference_json)),accountIds:JSON.parse(text(row.account_ids_json)),status:text(row.status) as TaskStatus,confirmationDigest:text(row.confirmation_digest),createdAt:text(row.created_at),updatedAt:text(row.updated_at) })); }
  updateTaskStatus(id: string, status: TaskStatus): void { this.run("update lottery_tasks set status = ?, updated_at = ? where id = ?", [status,new Date().toISOString(),id]); }
  listRuns(): AccountRun[] { return this.query<Row>("select * from account_runs order by created_at asc").map(rowToRun); }
  listRunsForTask(taskId: string): AccountRun[] { return this.query<Row>("select * from account_runs where task_id = ? order by created_at asc", [taskId]).map(rowToRun); }
  updateRun(input: { id:string; status:AccountRunStatus; resumeCheckpoint?:Record<string,unknown>; externalApplicationId?:string; errorCode?:string; errorDetailRedacted?:string }): void { this.run("update account_runs set status=?,resume_checkpoint_json=coalesce(?,resume_checkpoint_json),external_application_id=coalesce(?,external_application_id),error_code=?,error_detail_redacted=?,updated_at=? where id=?", [input.status,input.resumeCheckpoint ? JSON.stringify(input.resumeCheckpoint) : null,input.externalApplicationId ?? null,input.errorCode ?? null,input.errorDetailRedacted ?? null,new Date().toISOString(),input.id]); }
  createRun(run: AccountRun): AccountRun { if (!this.getStoredAccount(run.accountId)) throw new Error("Account run requires an existing account."); this.run("insert into account_runs (id,task_id,account_id,status,external_application_id,resume_checkpoint_json,error_code,error_detail_redacted,created_at,updated_at) values (?,?,?,?,?,?,?,?,?,?)", [run.id,run.taskId,run.accountId,run.status,run.externalApplicationId ?? null,JSON.stringify(run.resumeCheckpoint),run.errorCode ?? null,run.errorDetailRedacted ?? null,run.createdAt,run.updatedAt]); return run; }

  upsertProfile(profile: AccountProfile): AccountProfile { const now = new Date().toISOString(); this.run(`insert into account_profiles (id,account_id,eplus_email,encrypted_password,reveal_supported,phone,name,gender,birthday,address,companions_json,past_companions_json,harvested_at,harvest_status,created_at,updated_at) values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) on conflict(account_id) do update set eplus_email=excluded.eplus_email,encrypted_password=excluded.encrypted_password,reveal_supported=excluded.reveal_supported,phone=excluded.phone,name=excluded.name,gender=excluded.gender,birthday=excluded.birthday,address=excluded.address,companions_json=excluded.companions_json,past_companions_json=excluded.past_companions_json,harvested_at=excluded.harvested_at,harvest_status=excluded.harvest_status,updated_at=excluded.updated_at`, [randomUUID(),profile.accountId,profile.eplusEmail,profile.encryptedPassword,profile.revealSupported ? 1 : 0,profile.phone ?? null,profile.name ?? null,profile.gender ?? null,profile.birthday ?? null,profile.address ?? null,JSON.stringify(profile.companions),JSON.stringify(profile.pastCompanions),profile.harvestedAt,profile.harvestStatus,now,now]); return profile; }
  getProfile(accountId: string): AccountProfile | undefined { const row = this.query<Row>("select * from account_profiles where account_id=?",[accountId])[0]; return row ? rowToProfile(row) : undefined; }
  deleteProfile(accountId: string): void { this.run("delete from account_profiles where account_id=?",[accountId]); }
  addApplicationRecord(record: ApplicationRecord): ApplicationRecord { this.run("insert into application_records (id,account_id,event_title,applied_at,session_or_day,ticket_type,quantity,application_id,status,harvested_at,created_at) values (?,?,?,?,?,?,?,?,?,?,?)",[record.id,record.accountId,record.eventTitle,record.appliedAt,record.sessionOrDay ?? null,record.ticketType,record.quantity,record.applicationId ?? null,record.status,record.harvestedAt,new Date().toISOString()]); return record; }
  listApplicationRecords(accountId: string): ApplicationRecord[] { return this.query<Row>("select * from application_records where account_id=? order by applied_at desc",[accountId]).map((row) => ({id:text(row.id),accountId:text(row.account_id),eventTitle:text(row.event_title),appliedAt:text(row.applied_at),sessionOrDay:optional(row.session_or_day),ticketType:text(row.ticket_type),quantity:Number(row.quantity),applicationId:optional(row.application_id),status:text(row.status),harvestedAt:text(row.harvested_at)})); }
  addLotteryResult(record: LotteryResultRecord): LotteryResultRecord { this.run("insert into lottery_result_records (id,account_id,event_title,result_kind,decided_at,payment_deadline,application_id,harvested_at,created_at) values (?,?,?,?,?,?,?,?,?)",[record.id,record.accountId,record.eventTitle,record.resultKind,record.decidedAt ?? null,record.paymentDeadline ?? null,record.applicationId ?? null,record.harvestedAt,new Date().toISOString()]); return record; }
  listLotteryResults(accountId: string): LotteryResultRecord[] { return this.query<Row>("select * from lottery_result_records where account_id=? order by harvested_at desc",[accountId]).map((row) => ({id:text(row.id),accountId:text(row.account_id),eventTitle:text(row.event_title),resultKind:text(row.result_kind) as LotteryResultRecord["resultKind"],decidedAt:optional(row.decided_at),paymentDeadline:optional(row.payment_deadline),applicationId:optional(row.application_id),harvestedAt:text(row.harvested_at)})); }
  createProfileHarvestRun(run: ProfileHarvestRun): ProfileHarvestRun { this.run("insert into profile_harvest_runs (id,account_id,status,harvested_fields_json,error_detail,started_at,completed_at) values (?,?,?,?,?,?,?)",[run.id,run.accountId,run.status,JSON.stringify(run.harvestedFields),run.errorDetail ?? null,run.startedAt,run.completedAt ?? null]); return run; }
  updateProfileHarvestRun(input: Pick<ProfileHarvestRun,"id"|"status"> & Partial<Pick<ProfileHarvestRun,"harvestedFields"|"errorDetail"|"completedAt">>): void { this.run("update profile_harvest_runs set status=?,harvested_fields_json=coalesce(?,harvested_fields_json),error_detail=?,completed_at=? where id=?",[input.status,input.harvestedFields ? JSON.stringify(input.harvestedFields) : null,input.errorDetail ?? null,input.completedAt ?? null,input.id]); }
  addArtifactManifest(manifest: ArtifactManifest): ArtifactManifest { this.run("insert into artifact_manifests (id,account_run_id,step_id,kind,file_path,masked_selectors_json,created_at) values (?,?,?,?,?,?,?)",[manifest.id,manifest.runId,manifest.stepId,manifest.kind,manifest.filePath,JSON.stringify(manifest.maskedSelectors),manifest.createdAt]); return manifest; }
  listArtifactsForRun(runId: string): ArtifactManifest[] { return this.query<Row>("select * from artifact_manifests where account_run_id=? order by created_at asc",[runId]).map((row) => ({id:text(row.id),runId:text(row.account_run_id),stepId:text(row.step_id),kind:text(row.kind) as ArtifactManifest["kind"],filePath:text(row.file_path),maskedSelectors:JSON.parse(text(row.masked_selectors_json)),createdAt:text(row.created_at)})); }
  createRevealSession(session: StoredRevealSession): StoredRevealSession { this.run("insert into password_reveal_sessions (id,account_id,request_id,sender_window_id,created_at,expires_at,consumed) values (?,?,?,?,?,?,?)",[session.id,session.accountId,session.requestId,session.senderWindowId,session.createdAt,session.expiresAt,session.consumed ? 1 : 0]); return session; }
  getRevealSession(requestId: string): StoredRevealSession | undefined { const row=this.query<Row>("select * from password_reveal_sessions where request_id=?",[requestId])[0]; return row ? rowToRevealSession(row) : undefined; }
  consumeRevealSession(requestId: string, senderWindowId: string): StoredRevealSession | undefined { const session=this.getRevealSession(requestId); if (!session || session.senderWindowId !== senderWindowId || session.consumed || Date.parse(session.expiresAt) <= Date.now()) return undefined; this.run("update password_reveal_sessions set consumed=1 where request_id=?",[requestId]); return {...session,consumed:true}; }

  getSetting<T>(key: string): T | undefined { const row=this.query<Row>("select value_json from app_settings where key=?",[key])[0]; return row ? JSON.parse(text(row.value_json)) as T : undefined; }
  setSetting(key: string, value: unknown): void { this.run("insert into app_settings (key,value_json,updated_at) values (?,?,?) on conflict(key) do update set value_json=excluded.value_json,updated_at=excluded.updated_at",[key,JSON.stringify(value),new Date().toISOString()]); }
  addLog(log: Omit<AuditLog,"id"|"createdAt">): AuditLog { const row={id:randomUUID(),createdAt:new Date().toISOString(),...log}; this.run("insert into audit_logs (id,task_id,account_run_id,level,message,metadata_json,created_at) values (?,?,?,?,?,?,?)",[row.id,row.taskId ?? null,row.accountRunId ?? null,row.level,row.message,JSON.stringify(row.metadata),row.createdAt]); return row; }
  listLogs(limit=200): AuditLog[] { return this.query<Row>("select * from audit_logs order by created_at desc limit ?",[limit]).map((row)=>({id:text(row.id),taskId:optional(row.task_id),accountRunId:optional(row.account_run_id),level:text(row.level) as AuditLog["level"],message:text(row.message),metadata:JSON.parse(text(row.metadata_json)),createdAt:text(row.created_at)})); }

  private migrate(): void { this.runMigrations(this.hasTable("app_settings") ? this.getSetting<number>("schema_version") ?? 0 : 0); }
  private runMigrations(fromVersion: number): void { for (const migration of MIGRATIONS) if (migration.version > fromVersion) this.inTransaction(() => { this.beforeMigration?.(migration.version); this.exec(migration.sql); this.setSetting("schema_version",migration.version); }); }
  private inTransaction(action: () => void): void { this.exec("BEGIN"); this.transactionDepth += 1; try { action(); this.exec("COMMIT"); } catch (error) { this.exec("ROLLBACK"); throw error; } finally { this.transactionDepth -= 1; } this.save(); }
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
function rowToRun(row: Row): AccountRun { return {id:text(row.id),taskId:text(row.task_id),accountId:text(row.account_id),status:text(row.status) as AccountRunStatus,externalApplicationId:optional(row.external_application_id),resumeCheckpoint:JSON.parse(text(row.resume_checkpoint_json)),errorCode:optional(row.error_code),errorDetailRedacted:optional(row.error_detail_redacted),createdAt:text(row.created_at),updatedAt:text(row.updated_at)}; }
function rowToProfile(row: Row): AccountProfile { return {accountId:text(row.account_id),eplusEmail:text(row.eplus_email),encryptedPassword:text(row.encrypted_password),revealSupported:Boolean(row.reveal_supported),phone:optional(row.phone),name:optional(row.name),gender:optional(row.gender),birthday:optional(row.birthday),address:optional(row.address),companions:JSON.parse(text(row.companions_json)),pastCompanions:JSON.parse(text(row.past_companions_json)),harvestedAt:text(row.harvested_at),harvestStatus:text(row.harvest_status) as AccountProfile["harvestStatus"]}; }
function rowToRevealSession(row: Row): StoredRevealSession { return {id:text(row.id),accountId:text(row.account_id),requestId:text(row.request_id),senderWindowId:text(row.sender_window_id),createdAt:text(row.created_at),expiresAt:text(row.expires_at),consumed:Boolean(row.consumed)}; }
