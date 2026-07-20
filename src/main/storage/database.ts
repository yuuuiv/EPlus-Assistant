import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import initSqlJs, { type Database, type SqlJsStatic } from "sql.js";
import type {
  Account,
  AccountInput,
  AccountRun,
  AccountRunStatus,
  AuditLog,
  EventSnapshot,
  LotteryTask,
  TaskStatus
} from "../../shared/types.js";

type SqlValue = string | number | Uint8Array | null;

interface AccountRow extends Record<string, unknown> {
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

export class AppDatabase {
  private SQL?: SqlJsStatic;
  private db?: Database;

  constructor(
    private readonly dataDir: string,
    private readonly dbFile = path.join(dataDir, "app.db")
  ) {}

  async open(): Promise<void> {
    mkdirSync(this.dataDir, { recursive: true });
    this.SQL = await initSqlJs({
      locateFile: (file: string) => path.join(process.cwd(), "node_modules", "sql.js", "dist", file)
    });
    this.db = existsSync(this.dbFile)
      ? new this.SQL.Database(readFileSync(this.dbFile))
      : new this.SQL.Database();
    this.migrate();
    this.save();
  }

  getDataDir(): string {
    return this.dataDir;
  }

  listAccounts(): Account[] {
    return this.query<AccountRow>("select * from accounts order by created_at desc").map(toAccount);
  }

  getStoredAccount(id: string): StoredAccount | undefined {
    const row = this.query<AccountRow>("select * from accounts where id = ?", [id])[0];
    if (!row) {
      return undefined;
    }
    return {
      ...toAccount(row),
      encryptedEplusPassword: row.encrypted_eplus_password,
      encryptedMailConfig: row.encrypted_mail_config
    };
  }

  findAccountByEmail(email: string): StoredAccount | undefined {
    const row = this.query<AccountRow>("select * from accounts where lower(eplus_email) = lower(?)", [email])[0];
    if (!row) {
      return undefined;
    }
    return {
      ...toAccount(row),
      encryptedEplusPassword: row.encrypted_eplus_password,
      encryptedMailConfig: row.encrypted_mail_config
    };
  }

  upsertAccount(input: AccountInput & { id?: string; encryptedPassword: string; encryptedMailConfig: string }): Account {
    const now = new Date().toISOString();
    const existing = input.id ? this.getStoredAccount(input.id) : this.findAccountByEmail(input.eplusEmail);
    const id = existing?.id ?? randomUUID();
    const createdAt = existing?.createdAt ?? now;
    this.run(
      `insert into accounts (
        id, label, eplus_email, encrypted_eplus_password, mail_provider_id, encrypted_mail_config,
        tags_json, enabled, last_login_at, last_login_status, created_at, updated_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      on conflict(id) do update set
        label = excluded.label,
        eplus_email = excluded.eplus_email,
        encrypted_eplus_password = excluded.encrypted_eplus_password,
        mail_provider_id = excluded.mail_provider_id,
        encrypted_mail_config = excluded.encrypted_mail_config,
        tags_json = excluded.tags_json,
        enabled = excluded.enabled,
        updated_at = excluded.updated_at`,
      [
        id,
        input.label?.trim() || input.eplusEmail,
        input.eplusEmail.trim(),
        input.encryptedPassword,
        input.mailProviderId || "manual",
        input.encryptedMailConfig,
        JSON.stringify(input.tags ?? []),
        input.enabled === false ? 0 : 1,
        existing?.lastLoginAt ?? null,
        existing?.lastLoginStatus ?? "Unknown",
        createdAt,
        now
      ]
    );
    return this.getStoredAccount(id)!;
  }

  deleteAccount(id: string): void {
    this.run("delete from accounts where id = ?", [id]);
  }

  saveEventSnapshot(snapshot: EventSnapshot): EventSnapshot {
    this.run(
      `insert into event_snapshots (
        id, source_url, canonical_url, title, venue, schedule_text, application_deadline,
        fetched_at, raw_form_schema_json, page_fingerprint
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      on conflict(id) do update set
        canonical_url = excluded.canonical_url,
        title = excluded.title,
        venue = excluded.venue,
        schedule_text = excluded.schedule_text,
        application_deadline = excluded.application_deadline,
        fetched_at = excluded.fetched_at,
        raw_form_schema_json = excluded.raw_form_schema_json,
        page_fingerprint = excluded.page_fingerprint`,
      [
        snapshot.id,
        snapshot.sourceUrl,
        snapshot.canonicalUrl,
        snapshot.title,
        snapshot.venue ?? null,
        snapshot.scheduleText ?? null,
        snapshot.applicationDeadline ?? null,
        snapshot.fetchedAt,
        JSON.stringify(snapshot.rawFormSchema),
        snapshot.pageFingerprint
      ]
    );
    return snapshot;
  }

  listEvents(): EventSnapshot[] {
    return this.query<Record<string, string | null>>("select * from event_snapshots order by fetched_at desc").map(
      (row) => ({
        id: String(row.id),
        sourceUrl: String(row.source_url),
        canonicalUrl: String(row.canonical_url),
        title: String(row.title),
        venue: row.venue ? String(row.venue) : undefined,
        scheduleText: row.schedule_text ? String(row.schedule_text) : undefined,
        applicationDeadline: row.application_deadline ? String(row.application_deadline) : undefined,
        fetchedAt: String(row.fetched_at),
        rawFormSchema: JSON.parse(String(row.raw_form_schema_json)),
        pageFingerprint: String(row.page_fingerprint)
      })
    );
  }

  getEvent(id: string): EventSnapshot | undefined {
    return this.listEvents().find((event) => event.id === id);
  }

  createTask(task: LotteryTask): LotteryTask {
    this.run(
      `insert into lottery_tasks (
        id, event_snapshot_id, preference_json, account_ids_json, status, confirmation_digest, created_at, updated_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        task.id,
        task.eventSnapshotId,
        JSON.stringify(task.preference),
        JSON.stringify(task.accountIds),
        task.status,
        task.confirmationDigest,
        task.createdAt,
        task.updatedAt
      ]
    );
    for (const accountId of task.accountIds) {
      this.createRun({
        id: randomUUID(),
        taskId: task.id,
        accountId,
        status: "Pending",
        resumeCheckpoint: {},
        createdAt: task.createdAt,
        updatedAt: task.createdAt
      });
    }
    return task;
  }

  listTasks(): LotteryTask[] {
    return this.query<Record<string, string>>("select * from lottery_tasks order by created_at desc").map((row) => ({
      id: row.id,
      eventSnapshotId: row.event_snapshot_id,
      preference: JSON.parse(row.preference_json),
      accountIds: JSON.parse(row.account_ids_json),
      status: row.status as TaskStatus,
      confirmationDigest: row.confirmation_digest,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    }));
  }

  updateTaskStatus(id: string, status: TaskStatus): void {
    this.run("update lottery_tasks set status = ?, updated_at = ? where id = ?", [status, new Date().toISOString(), id]);
  }

  listRuns(): AccountRun[] {
    return this.query<Record<string, string | null>>("select * from account_runs order by created_at asc").map(rowToRun);
  }

  listRunsForTask(taskId: string): AccountRun[] {
    return this.query<Record<string, string | null>>("select * from account_runs where task_id = ? order by created_at asc", [
      taskId
    ]).map(rowToRun);
  }

  updateRun(input: {
    id: string;
    status: AccountRunStatus;
    resumeCheckpoint?: Record<string, unknown>;
    externalApplicationId?: string;
    errorCode?: string;
    errorDetailRedacted?: string;
  }): void {
    this.run(
      `update account_runs set
        status = ?,
        resume_checkpoint_json = coalesce(?, resume_checkpoint_json),
        external_application_id = coalesce(?, external_application_id),
        error_code = ?,
        error_detail_redacted = ?,
        updated_at = ?
      where id = ?`,
      [
        input.status,
        input.resumeCheckpoint ? JSON.stringify(input.resumeCheckpoint) : null,
        input.externalApplicationId ?? null,
        input.errorCode ?? null,
        input.errorDetailRedacted ?? null,
        new Date().toISOString(),
        input.id
      ]
    );
  }

  createRun(run: AccountRun): AccountRun {
    this.run(
      `insert into account_runs (
        id, task_id, account_id, status, external_application_id, resume_checkpoint_json,
        error_code, error_detail_redacted, created_at, updated_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        run.id,
        run.taskId,
        run.accountId,
        run.status,
        run.externalApplicationId ?? null,
        JSON.stringify(run.resumeCheckpoint),
        run.errorCode ?? null,
        run.errorDetailRedacted ?? null,
        run.createdAt,
        run.updatedAt
      ]
    );
    return run;
  }

  getSetting<T>(key: string): T | undefined {
    const row = this.query<Record<string, string | null>>("select value_json from app_settings where key = ?", [key])[0];
    return row ? (JSON.parse(String(row.value_json)) as T) : undefined;
  }

  setSetting(key: string, value: unknown): void {
    this.run(
      `insert into app_settings (key, value_json, updated_at) values (?, ?, ?)
      on conflict(key) do update set value_json = excluded.value_json, updated_at = excluded.updated_at`,
      [key, JSON.stringify(value), new Date().toISOString()]
    );
  }

  addLog(log: Omit<AuditLog, "id" | "createdAt">): AuditLog {
    const row: AuditLog = {
      id: randomUUID(),
      createdAt: new Date().toISOString(),
      ...log
    };
    this.run(
      "insert into audit_logs (id, task_id, account_run_id, level, message, metadata_json, created_at) values (?, ?, ?, ?, ?, ?, ?)",
      [
        row.id,
        row.taskId ?? null,
        row.accountRunId ?? null,
        row.level,
        row.message,
        JSON.stringify(row.metadata),
        row.createdAt
      ]
    );
    return row;
  }

  listLogs(limit = 200): AuditLog[] {
    return this.query<Record<string, string | null>>(
      "select * from audit_logs order by created_at desc limit ?",
      [limit]
    ).map((row) => ({
      id: String(row.id),
      taskId: row.task_id ? String(row.task_id) : undefined,
      accountRunId: row.account_run_id ? String(row.account_run_id) : undefined,
      level: row.level as AuditLog["level"],
      message: String(row.message),
      metadata: JSON.parse(String(row.metadata_json)),
      createdAt: String(row.created_at)
    }));
  }

  private migrate(): void {
    this.exec(`
      create table if not exists accounts (
        id text primary key,
        label text not null,
        eplus_email text not null unique,
        encrypted_eplus_password text not null,
        mail_provider_id text not null,
        encrypted_mail_config text not null,
        tags_json text not null,
        enabled integer not null,
        last_login_at text,
        last_login_status text not null,
        created_at text not null,
        updated_at text not null
      );

      create table if not exists event_snapshots (
        id text primary key,
        source_url text not null,
        canonical_url text not null,
        title text not null,
        venue text,
        schedule_text text,
        application_deadline text,
        fetched_at text not null,
        raw_form_schema_json text not null,
        page_fingerprint text not null
      );

      create table if not exists lottery_tasks (
        id text primary key,
        event_snapshot_id text not null,
        preference_json text not null,
        account_ids_json text not null,
        status text not null,
        confirmation_digest text not null,
        created_at text not null,
        updated_at text not null
      );

      create table if not exists account_runs (
        id text primary key,
        task_id text not null,
        account_id text not null,
        status text not null,
        external_application_id text,
        resume_checkpoint_json text not null,
        error_code text,
        error_detail_redacted text,
        created_at text not null,
        updated_at text not null
      );

      create table if not exists audit_logs (
        id text primary key,
        task_id text,
        account_run_id text,
        level text not null,
        message text not null,
        metadata_json text not null,
        created_at text not null
      );

      create table if not exists app_settings (
        key text primary key,
        value_json text not null,
        updated_at text not null
      );
    `);
  }

  private exec(sql: string): void {
    this.assertOpen().exec(sql);
  }

  private run(sql: string, params: SqlValue[] = []): void {
    const statement = this.assertOpen().prepare(sql);
    try {
      statement.bind(params);
      statement.step();
    } finally {
      statement.free();
    }
    this.save();
  }

  private query<T extends Record<string, unknown>>(sql: string, params: SqlValue[] = []): T[] {
    const statement = this.assertOpen().prepare(sql);
    const rows: T[] = [];
    try {
      statement.bind(params);
      while (statement.step()) {
        rows.push(statement.getAsObject() as T);
      }
    } finally {
      statement.free();
    }
    return rows;
  }

  private save(): void {
    writeFileSync(this.dbFile, Buffer.from(this.assertOpen().export()));
  }

  private assertOpen(): Database {
    if (!this.db) {
      throw new Error("Database is not open.");
    }
    return this.db;
  }
}

function toAccount(row: AccountRow): Account {
  return {
    id: row.id,
    label: row.label,
    eplusEmail: row.eplus_email,
    mailProviderId: row.mail_provider_id,
    tags: JSON.parse(row.tags_json),
    enabled: Boolean(row.enabled),
    lastLoginAt: row.last_login_at ?? undefined,
    lastLoginStatus: row.last_login_status as Account["lastLoginStatus"],
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function rowToRun(row: Record<string, string | null>): AccountRun {
  return {
    id: String(row.id),
    taskId: String(row.task_id),
    accountId: String(row.account_id),
    status: row.status as AccountRunStatus,
    externalApplicationId: row.external_application_id ? String(row.external_application_id) : undefined,
    resumeCheckpoint: JSON.parse(String(row.resume_checkpoint_json)),
    errorCode: row.error_code ? String(row.error_code) : undefined,
    errorDetailRedacted: row.error_detail_redacted ? String(row.error_detail_redacted) : undefined,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  };
}
