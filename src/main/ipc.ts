import path from "node:path";
import { shell, ipcMain, type BrowserWindow } from "electron";
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
import type { CreateTaskInputV2, ImportAccountsInput } from "../shared/ipc.js";

export function registerIpc(
  window: BrowserWindow,
  db: AppDatabase,
  secretStore: SecretStore
): void {
  const accountService = new AccountService(db, secretStore);
  const eventService = new EventService(db);
  const settingsService = new SettingsService(db, secretStore);
  const taskService = new TaskService(db);
  const browserEngine = new BrowserSessionEngine(
    {
      executablePath: process.env.EPLUS_BROWSER_EXECUTABLE ?? process.execPath,
      profilesDir: path.join(db.getDataDir(), "profiles"),
      navigationTimeoutMs: 30_000,
      retryLimit: 1,
      retryDelayMs: 500
    },
    {
      captureScreenshot: async () => ({}),
      captureHtmlSnapshot: async () => ({})
    }
  );
  const browserAdapter = new EplusBrowserAdapter(browserEngine);
  const profileHarvester = new ProfileHarvester(browserEngine, browserAdapter, db);
  const recordRefresh = new RecordRefreshService(browserEngine, browserAdapter, db);

  ipcMain.handle("app:get-state", () => ({
    accounts: accountService.listAccounts(),
    events: eventService.listEvents(),
    tasks: taskService.listTasks(),
    runs: taskService.listRuns(),
    logs: db.listLogs(),
    verificationMailbox: settingsService.getVerificationMailbox(),
    network: settingsService.getNetworkSettings(),
    dataDir: db.getDataDir()
  }));

  ipcMain.handle("account:add", (_event, input) => accountService.addAccount(input));
  ipcMain.handle("account:import", (_event, input: ImportAccountsInput) =>
    accountService.importAccounts(input.kind, input.text)
  );
  ipcMain.handle("account:delete", (_event, id: string) => accountService.deleteAccount(id));
  ipcMain.handle("profile:harvest", (_event, input: { accountId: string; existingSession?: boolean }) => profileHarvester.harvest(input));
  ipcMain.handle("profile:refresh", (_event, accountId: string) => profileHarvester.refreshProfile(accountId));
  ipcMain.handle("profile:refresh-application-records", (_event, accountId: string) => recordRefresh.refreshApplicationRecords(accountId));
  ipcMain.handle("profile:refresh-lottery-results", (_event, accountId: string) => recordRefresh.refreshLotteryResults(accountId));
  ipcMain.handle("event:discover", (_event, input) => eventService.discoverFromUrl(input.sourceUrl));
  ipcMain.handle("event:save", (_event, input) => eventService.saveSnapshot(input));
  ipcMain.handle("task:create", (_event, input) => {
    const event = db.getEvent(input.eventSnapshotId);
    if (!event) {
      throw new Error("Event snapshot not found.");
    }
    if (event.rawFormSchema.serialCode?.required) {
      const commonCode = String(input.preference.serialCode ?? "").trim();
      const perAccountCodes = input.preference.serialCodesByAccountId ?? {};
      const missingAccounts = input.accountIds.filter((accountId: string) => !commonCode && !perAccountCodes[accountId]);
      if (missingAccounts.length > 0) {
        throw new Error("该页面需要抽选码。请填写公共抽选码，或为每个选中账号填写专用抽选码。");
      }
    }
    return taskService.createTask({ ...input, canonicalUrl: event.canonicalUrl });
  });
  ipcMain.handle("task:create-v2", (_event, input: CreateTaskInputV2) => {
    const event = db.getEvent(input.eventSnapshotId);
    if (!event) throw new Error("Event snapshot not found.");
    return taskService.createTaskV2({ ...input, event });
  });
  ipcMain.handle("task:update-status", (_event, taskId: string, status: string) =>
    taskService.updateTaskStatus(taskId, status as any)
  );
  ipcMain.handle("run:update-status", (_event, runId: string, status: string, note?: string) =>
    taskService.updateRunStatus(runId, status as any, note)
  );
  ipcMain.handle("run:manual-action", (event, input) => {
    if (event.sender !== window.webContents) throw new Error("Manual actions must originate from the application window.");
    if (!input || typeof input.runId !== "string" || !["continue", "cancel-account", "cancel-task", "reconcile-unknown"].includes(input.action)) throw new Error("Invalid manual action.");
    return taskService.performManualAction(input);
  });
  ipcMain.handle("submission:get-authorization", (_event, input: { taskId: string; runId: string }) => {
    const run = db.listRuns().find((candidate) => candidate.id === input.runId && candidate.taskId === input.taskId);
    return run ? db.getSubmissionAuthorization(run.id) ?? null : null;
  });
  ipcMain.handle("submission:reconcile", (_event, input: { taskId: string; runId: string }) => {
    const run = db.listRuns().find((candidate) => candidate.id === input.runId && candidate.taskId === input.taskId);
    if (!run || run.status !== "UnknownSubmissionState") throw new Error("Only an unknown submission can be reconciled.");
    const task = db.listTasks().find((candidate) => candidate.id === input.taskId);
    if (!task) throw new Error("Task not found.");
    const event = db.getEvent(task.eventSnapshotId);
    const historyMatch = event && db.listApplicationRecords(run.accountId).some((record) => record.eventTitle === event.title);
    if (historyMatch) { db.updateRun({ id: run.id, status: "AlreadyApplied" }); return "AlreadyApplied"; }
    db.updateRun({ id: run.id, status: "Failed", errorDetailRedacted: "No receipt or history was found during read-only reconciliation." });
    return "Failed";
  });
  ipcMain.handle("profile:get", (_event, accountId: string) => db.getProfile(accountId));
  ipcMain.handle("profile:list-companions", (_event, accountId: string) => db.getProfile(accountId)?.companions ?? []);
  ipcMain.handle("profile:list-application-records", (_event, accountId: string) => db.listApplicationRecords(accountId));
  ipcMain.handle("profile:list-lottery-results", (_event, accountId: string) => db.listLotteryResults(accountId));
  ipcMain.handle("settings:save-verification-mailbox", (_event, input) =>
    settingsService.saveVerificationMailbox(input)
  );
  ipcMain.handle("settings:test-verification-mailbox", () => settingsService.testVerificationMailbox());
  ipcMain.handle("settings:read-verification-code", (_event, input) =>
    settingsService.readVerificationCode(input)
  );
  ipcMain.handle("settings:get-network", () => settingsService.getNetworkSettings());
  ipcMain.handle("settings:save-network", (_event, input) => settingsService.saveNetworkSettings(input));
  ipcMain.handle("log:add", (_event, message: string, level = "info", metadata = {}) =>
    db.addLog({ message, level, metadata })
  );
  ipcMain.handle("app:open-data-folder", () => shell.openPath(path.resolve(db.getDataDir())));

  window.webContents.once("did-finish-load", () => {
    db.addLog({ level: "info", message: "Renderer loaded.", metadata: {} });
  });
}
