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
  updateTaskStatus: (taskId, status) => ipcRenderer.invoke("task:update-status", taskId, status),
  updateRunStatus: (runId, status, note) => ipcRenderer.invoke("run:update-status", runId, status, note),
  addLog: (message, level, metadata) => ipcRenderer.invoke("log:add", message, level, metadata),
  openDataFolder: () => ipcRenderer.invoke("app:open-data-folder")
};

contextBridge.exposeInMainWorld("eplusApi", api);
