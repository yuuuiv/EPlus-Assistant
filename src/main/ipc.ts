import path from "node:path";
import { shell, ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from "electron";
import { z } from "zod";
import type { AppDatabase } from "./storage/database.js";
import type { SecretStore } from "./storage/secretStore.js";
import { AccountService } from "./services/accountService.js";
import { EventService } from "./services/eventService.js";
import { SettingsService } from "./services/settingsService.js";
import { TaskService } from "./services/taskService.js";
import { EplusBrowserAdapter } from "./adapters/eplusAdapter.js";
import { BrowserSessionEngine } from "./engines/browserSessionEngine.js";
import { ProfileHarvester } from "./services/profileHarvester.js";
import { RecordRefreshService } from "./services/recordRefresh.js";
import { ClashControllerProvider } from "./adapters/networkRotationProvider.js";
import { NetworkService } from "./services/networkService.js";
import { LotteryOrchestrator } from "./services/lotteryOrchestrator.js";
import { QueueService } from "./services/queueService.js";

const idSchema = z.string().trim().min(1).max(128);
const emptySchema = z.undefined();
const recordSchema = z.record(z.string(), z.unknown());
const addAccountSchema = z.object({
  id: idSchema.optional(), label: z.string().optional(), eplusEmail: z.string().email(), password: z.string().min(1),
  mailProviderId: z.string().optional(), mailConfig: recordSchema.optional(), tags: z.array(z.string()).optional(), enabled: z.boolean().optional()
}).strict();
const importAccountsSchema = z.object({ kind: z.enum(["csv", "json"]), text: z.string().min(1) }).strict();
const discoverEventSchema = z.object({ sourceUrl: z.string().url() }).strict();
const eventSnapshotSchema = z.object({
  sourceUrl: z.string().url(), canonicalUrl: z.string().url().optional(), title: z.string().min(1), venue: z.string().optional(),
  scheduleText: z.string().optional(), applicationDeadline: z.string().optional(), pageFingerprint: z.string().optional(), rawFormSchemaJson: z.string().optional()
}).strict();
const preferenceEntrySchema = z.object({ rank: z.number(), ticketTypeId: z.string(), quantity: z.number(), optionalDateOrShowId: z.string().optional() }).strict();
const preferenceSchema = z.object({
  entries: z.array(preferenceEntrySchema), paymentMethodId: z.string(), deliveryMethodId: z.string().optional(), serialCode: z.string().optional(),
  serialCodesByAccountId: z.record(z.string(), z.string()).optional(), daySelectionByAccountId: z.record(z.string(), z.array(z.enum(["day1", "day2"]))).optional(),
  applicationLinkId: z.string().optional(), consentFlags: z.record(z.string(), z.boolean())
}).strict();
const taskSchema = z.object({ eventSnapshotId: idSchema, preference: preferenceSchema, accountIds: z.array(idSchema) }).strict();
const taskV2Schema = taskSchema.extend({ confirmationPolicy: z.enum(["required", "disabled"]), automationRiskAcknowledgement: z.object({ version: z.number(), acknowledgedAt: z.string(), disclosureDigest: z.string() }).strict().optional() }).strict();
const manualActionSchema = z.object({ runId: idSchema, action: z.enum(["continue", "cancel-account", "cancel-task", "reconcile-unknown"]), verificationCode: z.string().optional() }).strict();
const pairSchema = z.object({ taskId: idSchema, runId: idSchema }).strict();
const harvestSchema = z.object({ accountId: idSchema, existingSession: z.boolean().optional() }).strict();
const mailboxSchema = z.object({
  providerId: z.string(), mailboxAddress: z.string(), mode: z.enum(["manual", "imap", "http-api", "temp-mail-forwarder", "auth-mailbox"]), endpoint: z.string().optional(), username: z.string().optional(),
  password: z.string().optional(), apiToken: z.string().optional(), senderAllowlist: z.array(z.string()), subjectMatchers: z.array(z.string()), pollingIntervalMs: z.number(), timeoutMs: z.number()
}).strict();
const verificationCodeSchema = z.object({ recipient: z.string().optional(), startedAt: z.string().optional(), timeoutMs: z.number().optional() }).strict().optional();
const networkSchema = z.object({ host: z.string(), port: z.number(), secret: z.string().optional(), proxyGroup: z.string(), requiredCountry: z.string(), policy: z.string() }).strict();

type Handler<T> = (value: T) => unknown | Promise<unknown>;

export function validateSender(event: IpcMainInvokeEvent, window: BrowserWindow): void {
  if (!event.senderFrame || event.senderFrame.url !== event.sender.getURL() || event.sender !== window.webContents) {
    throw new Error("Unauthorized IPC sender.");
  }
}

function sanitizedError(error: unknown): Error {
  if (error instanceof z.ZodError) return new Error("Invalid IPC payload.");
  if (error instanceof Error) return new Error(error.message.replace(/[A-Za-z]:\\[^\n ]+|\/[^\n ]+/g, "[redacted]").slice(0, 500));
  return new Error("Handler failed.");
}

function registerHandler<T>(channel: string, window: BrowserWindow, schema: z.ZodType<T>, handler: Handler<T>): void {
  ipcMain.handle(channel, async (event, payload: unknown) => {
    validateSender(event, window);
    try {
      return await handler(schema.parse(payload));
    } catch (error) {
      throw sanitizedError(error);
    }
  });
}

export function registerIpc(window: BrowserWindow, db: AppDatabase, secretStore: SecretStore): void {
  const accountService = new AccountService(db, secretStore);
  const eventService = new EventService(db);
  const settingsService = new SettingsService(db, secretStore);
  const taskService = new TaskService(db);
  const network = new NetworkService({
    detectIp: async () => { const config = settingsService.getClashConfig(); if (!config) throw new Error("Network controller is not configured."); return new ClashControllerProvider(config).detectIp(); },
    rotate: async () => { const config = settingsService.getClashConfig(); if (!config) throw new Error("Network controller is not configured."); await new ClashControllerProvider(config).rotate(); }
  }, { getSetting: (key) => db.getSetting(key) });
  const browserEngine = new BrowserSessionEngine({ executablePath: process.env.EPLUS_BROWSER_EXECUTABLE ?? process.execPath, profilesDir: path.join(db.getDataDir(), "profiles"), navigationTimeoutMs: 30_000, retryLimit: 1, retryDelayMs: 500 }, { captureScreenshot: async () => ({}), captureHtmlSnapshot: async () => ({}) }, network);
  const browserAdapter = new EplusBrowserAdapter(browserEngine);
  const queueService = new QueueService(new LotteryOrchestrator(browserEngine, browserAdapter, network, db, {}), db);
  const profileHarvester = new ProfileHarvester(browserEngine, browserAdapter, db);
  const recordRefresh = new RecordRefreshService(browserEngine, browserAdapter, db);

  registerHandler("app:get-state", window, emptySchema, () => ({ accounts: accountService.listAccounts(), events: eventService.listEvents(), tasks: taskService.listTasks(), runs: taskService.listRuns(), logs: db.listLogs(), verificationMailbox: settingsService.getVerificationMailbox(), network: settingsService.getNetworkSettings(), dataDir: db.getDataDir() }));
  registerHandler("account:add", window, addAccountSchema, (input) => accountService.addAccount(input));
  registerHandler("account:import", window, importAccountsSchema, (input) => accountService.importAccounts(input.kind, input.text));
  registerHandler("account:delete", window, idSchema, (id) => accountService.deleteAccount(id));
  registerHandler("account:reveal-password", window, idSchema, (id) => accountService.revealPassword(id));
  registerHandler("profile:harvest", window, harvestSchema, (input) => profileHarvester.harvest(input));
  registerHandler("profile:refresh", window, idSchema, (id) => profileHarvester.refreshProfile(id));
  registerHandler("profile:refresh-application-records", window, idSchema, (id) => recordRefresh.refreshApplicationRecords(id));
  registerHandler("profile:refresh-lottery-results", window, idSchema, (id) => recordRefresh.refreshLotteryResults(id));
  registerHandler("event:discover", window, discoverEventSchema, (input) => eventService.discoverFromUrl(input.sourceUrl));
  registerHandler("event:save", window, eventSnapshotSchema, (input) => eventService.saveSnapshot(input));
  registerHandler("task:create", window, taskSchema, (input) => {
    const event = db.getEvent(input.eventSnapshotId); if (!event) throw new Error("Event snapshot not found.");
    if (event.rawFormSchema.serialCode?.required) { const commonCode = String(input.preference.serialCode ?? "").trim(); const codes = input.preference.serialCodesByAccountId ?? {}; if (input.accountIds.some((accountId) => !commonCode && !codes[accountId])) throw new Error("Required serial code is missing."); }
    return taskService.createTask({ ...input, canonicalUrl: event.canonicalUrl });
  });
  registerHandler("task:create-v2", window, taskV2Schema, (input) => { const event = db.getEvent(input.eventSnapshotId); if (!event) throw new Error("Event snapshot not found."); return taskService.createTaskV2({ ...input, event }); });
  registerHandler("run:manual-action", window, manualActionSchema, (input) => queueService.performManualAction(input));
  registerHandler("queue:enqueue-task", window, idSchema, async (taskId) => { const task = db.listTasks().find((candidate) => candidate.id === taskId); if (!task) throw new Error("Task not found."); if (task.status === "AwaitingConfirmation" || task.status === "Failed") taskService.updateTaskStatus(task.id, "Queued"); await queueService.enqueueTask(db.listTasks().find((candidate) => candidate.id === taskId) ?? task); });
  registerHandler("queue:pause", window, emptySchema, () => queueService.pause());
  registerHandler("queue:resume", window, emptySchema, () => queueService.resume());
  registerHandler("queue:cancel-run", window, idSchema, (runId) => queueService.cancelRun(runId));
  registerHandler("queue:cancel-task", window, idSchema, (taskId) => queueService.cancelTask(taskId));
  registerHandler("queue:get-state", window, emptySchema, () => queueService.getState());
  registerHandler("submission:get-authorization", window, pairSchema, (input) => { const run = db.listRuns().find((candidate) => candidate.id === input.runId && candidate.taskId === input.taskId); return run ? db.getSubmissionAuthorization(run.id) ?? null : null; });
  registerHandler("submission:reconcile", window, pairSchema, (input) => { const run = db.listRuns().find((candidate) => candidate.id === input.runId && candidate.taskId === input.taskId); if (!run || run.status !== "UnknownSubmissionState") throw new Error("Only an unknown submission can be reconciled."); const task = db.listTasks().find((candidate) => candidate.id === input.taskId); if (!task) throw new Error("Task not found."); const event = db.getEvent(task.eventSnapshotId); const historyMatch = event && db.listApplicationRecords(run.accountId).some((record) => record.eventTitle === event.title); if (historyMatch) { db.updateRun({ id: run.id, status: "AlreadyApplied" }); return "AlreadyApplied"; } db.updateRun({ id: run.id, status: "Failed", errorDetailRedacted: "No receipt or history was found during read-only reconciliation." }); return "Failed"; });
  registerHandler("profile:get", window, idSchema, (accountId) => db.getProfile(accountId));
  registerHandler("profile:list-companions", window, idSchema, (accountId) => db.getProfile(accountId)?.companions ?? []);
  registerHandler("profile:list-application-records", window, idSchema, (accountId) => db.listApplicationRecords(accountId));
  registerHandler("profile:list-lottery-results", window, idSchema, (accountId) => db.listLotteryResults(accountId));
  registerHandler("settings:save-verification-mailbox", window, mailboxSchema, (input) => settingsService.saveVerificationMailbox(input));
  registerHandler("settings:test-verification-mailbox", window, emptySchema, () => settingsService.testVerificationMailbox());
  registerHandler("settings:read-verification-code", window, verificationCodeSchema, (input) => settingsService.readVerificationCode(input));
  registerHandler("settings:get-network", window, emptySchema, () => settingsService.getNetworkSettings());
  registerHandler("settings:save-network", window, networkSchema, (input) => settingsService.saveNetworkSettings(input));
  registerHandler("network:detect", window, emptySchema, async () => { const config = settingsService.getClashConfig(); if (!config) throw new Error("Network controller is not configured."); return new ClashControllerProvider(config).detectIp(); });
  registerHandler("network:rotate", window, emptySchema, async () => { const config = settingsService.getClashConfig(); if (!config) throw new Error("Network controller is not configured."); await new ClashControllerProvider(config).rotate(); });
  registerHandler("app:open-data-folder", window, emptySchema, () => shell.openPath(path.resolve(db.getDataDir())));
  window.webContents.once("did-finish-load", () => { db.addLog({ level: "info", message: "Renderer loaded.", metadata: {} }); });
}
