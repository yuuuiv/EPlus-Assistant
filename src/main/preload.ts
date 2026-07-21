import { contextBridge, ipcRenderer } from "electron";
import type { ElectronApi } from "../shared/ipc.js";

const api: ElectronApi = {
  getState: () => ipcRenderer.invoke("app:get-state"),
  addAccount: (input) => ipcRenderer.invoke("account:add", input),
  importAccounts: (input) => ipcRenderer.invoke("account:import", input),
  deleteAccount: (id) => ipcRenderer.invoke("account:delete", id),
  discoverEvent: (input) => ipcRenderer.invoke("event:discover", input),
  saveEventSnapshot: (input) => ipcRenderer.invoke("event:save", input),
  createTask: (input) => ipcRenderer.invoke("task:create", input),
  createTaskV2: (input) => ipcRenderer.invoke("task:create-v2", input),
  updateTaskStatus: (taskId, status) => ipcRenderer.invoke("task:update-status", taskId, status),
  updateRunStatus: (runId, status, note) => ipcRenderer.invoke("run:update-status", runId, status, note),
  enqueueTask: (taskId) => ipcRenderer.invoke("queue:enqueue-task", taskId),
  pauseQueue: () => ipcRenderer.invoke("queue:pause"),
  resumeQueue: () => ipcRenderer.invoke("queue:resume"),
  cancelRun: (runId) => ipcRenderer.invoke("queue:cancel-run", runId),
  cancelTask: (taskId) => ipcRenderer.invoke("queue:cancel-task", taskId),
  getQueueState: () => ipcRenderer.invoke("queue:get-state"),
  revealPassword: (accountId) => ipcRenderer.invoke("account:reveal-password", accountId),
  performManualAction: (input) => ipcRenderer.invoke("run:manual-action", input),
  getAuthorization: (input) => ipcRenderer.invoke("submission:get-authorization", input),
  harvestProfile: (input) => ipcRenderer.invoke("profile:harvest", input),
  refreshProfile: (accountId) => ipcRenderer.invoke("profile:refresh", accountId),
  refreshApplicationRecords: (accountId) => ipcRenderer.invoke("profile:refresh-application-records", accountId),
  refreshLotteryResults: (accountId) => ipcRenderer.invoke("profile:refresh-lottery-results", accountId),
  reconcileSubmission: (input) => ipcRenderer.invoke("submission:reconcile", input),
  listProfiles: (accountId) => ipcRenderer.invoke("profile:get", accountId),
  listCompanions: (accountId) => ipcRenderer.invoke("profile:list-companions", accountId),
  listApplicationRecords: (accountId, filter) => ipcRenderer.invoke("profile:list-application-records", accountId, filter),
  listLotteryResults: (accountId, filter) => ipcRenderer.invoke("profile:list-lottery-results", accountId, filter),
  saveVerificationMailbox: (input) => ipcRenderer.invoke("settings:save-verification-mailbox", input),
  testVerificationMailbox: () => ipcRenderer.invoke("settings:test-verification-mailbox"),
  readVerificationCode: (input) => ipcRenderer.invoke("settings:read-verification-code", input),
  getNetworkSettings: () => ipcRenderer.invoke("settings:get-network"),
  saveNetworkSettings: (input) => ipcRenderer.invoke("settings:save-network", input),
  detectIp: () => ipcRenderer.invoke("network:detect"),
  rotateIp: () => ipcRenderer.invoke("network:rotate"),
  addLog: (message, level, metadata) => ipcRenderer.invoke("log:add", message, level, metadata),
  openDataFolder: () => ipcRenderer.invoke("app:open-data-folder")
};

contextBridge.exposeInMainWorld("eplusApi", api);
