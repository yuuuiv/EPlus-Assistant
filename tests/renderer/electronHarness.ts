import { vi } from "vitest";
import type { ElectronApi } from "../../src/shared/ipc.js";

export function createMockApi(): ElectronApi {
  return {
    getState: vi.fn(), addAccount: vi.fn(), importAccounts: vi.fn(), deleteAccount: vi.fn(),
    discoverEvent: vi.fn(), saveEventSnapshot: vi.fn(), createTask: vi.fn(), createTaskV2: vi.fn(),
    enqueueTask: vi.fn(), pauseQueue: vi.fn(), resumeQueue: vi.fn(), cancelRun: vi.fn(), cancelTask: vi.fn(), getQueueState: vi.fn(),
    revealPassword: vi.fn(), performManualAction: vi.fn(), getAuthorization: vi.fn(), harvestProfile: vi.fn(), refreshProfile: vi.fn(),
    refreshApplicationRecords: vi.fn(), refreshLotteryResults: vi.fn(), reconcileSubmission: vi.fn(), listProfiles: vi.fn(), listCompanions: vi.fn(),
    listApplicationRecords: vi.fn(), listLotteryResults: vi.fn(), saveVerificationMailbox: vi.fn(), testVerificationMailbox: vi.fn(),
    readVerificationCode: vi.fn(), getNetworkSettings: vi.fn(), saveNetworkSettings: vi.fn(), detectIp: vi.fn(), rotateIp: vi.fn(),
    addLog: vi.fn(), openDataFolder: vi.fn()
  };
}
