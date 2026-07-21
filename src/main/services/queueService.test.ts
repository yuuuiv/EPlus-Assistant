import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AccountRun, LotteryTask } from "../../shared/types.js";
import { AppDatabase } from "../storage/database.js";
import { QueueService } from "./queueService.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("QueueService", () => {
  it("executes accounts serially and isolates a failed account", async () => {
    const fixture = await createFixture(["one", "two", "three"]);
    const activeRuns: string[] = [];
    let maximumActive = 0;
    const orchestrator = {
      runSingleAccount: vi.fn(async ({ run }: { run: AccountRun }) => {
        activeRuns.push(run.accountId);
        maximumActive = Math.max(maximumActive, activeRuns.length);
        activeRuns.pop();
        if (run.accountId === fixture.accountIds[1]) throw new Error("account failure");
        fixture.db.updateRun({ id: run.id, status: "Submitted" });
        return fixture.db.listRuns().find((candidate) => candidate.id === run.id) ?? run;
      }),
      reconcile: vi.fn()
    };
    const queue = new QueueService(orchestrator, fixture.db);

    await queue.enqueueTask(fixture.task);

    expect(maximumActive).toBe(1);
    expect(orchestrator.runSingleAccount.mock.calls.map(([input]) => input.run.accountId)).toEqual(fixture.accountIds);
    expect(fixture.db.listRunsForTask(fixture.task.id).map((run) => run.status)).toEqual(["Submitted", "Failed", "Submitted"]);
    expect(fixture.db.listTasks()[0]?.status).toBe("Failed");
    expect(fixture.db.listLogs().some((log) => log.message === "queue.run.failed")).toBe(true);
  });

  it("pauses at a manual checkpoint and rejects stale continuation", async () => {
    const fixture = await createFixture(["one", "two"]);
    const orchestrator = {
      runSingleAccount: vi.fn(async ({ run }: { run: AccountRun }) => {
        if (run.accountId === fixture.accountIds[0] && orchestrator.runSingleAccount.mock.calls.length === 1) fixture.db.updateRun({ id: run.id, status: "AwaitingManualAction" });
        else fixture.db.updateRun({ id: run.id, status: "Submitted" });
        return fixture.db.listRuns().find((candidate) => candidate.id === run.id) ?? run;
      }),
      reconcile: vi.fn()
    };
    const queue = new QueueService(orchestrator, fixture.db);

    await queue.enqueueTask(fixture.task);
    const firstRun = fixture.db.listRunsForTask(fixture.task.id)[0];
    const secondRun = fixture.db.listRunsForTask(fixture.task.id)[1];
    if (!firstRun || !secondRun) throw new Error("Expected fixture runs.");

    expect(queue.getState().status).toBe("paused");
    await expect(queue.performManualAction({ runId: secondRun.id, action: "continue" })).rejects.toThrow("manual checkpoint");
    await queue.performManualAction({ runId: firstRun.id, action: "continue" });
    expect(orchestrator.runSingleAccount).toHaveBeenCalledTimes(3);
  });
});

async function createFixture(accountIds: readonly string[]): Promise<{ db: AppDatabase; task: LotteryTask; accountIds: string[] }> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "eplus-queue-"));
  directories.push(directory);
  const db = new AppDatabase(directory);
  await db.open();
  const persistedAccountIds = accountIds.map((accountId) => db.upsertAccount({ id: accountId, eplusEmail: `${accountId}@example.test`, password: "unused", encryptedPassword: "encrypted", encryptedMailConfig: "mail" }).id);
  db.saveEventSnapshot({ id: "event", sourceUrl: "https://eplus.jp/source", canonicalUrl: "https://eplus.jp/event", title: "Event", fetchedAt: "2026-07-21T00:00:00.000Z", pageFingerprint: "fp", rawFormSchema: { sourceKind: "standard-detail", options: [], applicationLinks: [], serialCode: { required: false, label: "Code", errorSelectors: [], knownErrorMessages: [] }, selectorHints: {}, requiresManualInspection: false, notes: [] } });
  const task: LotteryTask = { id: "task", eventSnapshotId: "event", preference: { entries: [], paymentMethodId: "store", consentFlags: {} }, accountIds: persistedAccountIds, status: "Queued", confirmationDigest: "digest", createdAt: "2026-07-21T00:00:00.000Z", updatedAt: "2026-07-21T00:00:00.000Z" };
  db.createTask(task);
  for (const run of db.listRunsForTask(task.id)) {
    db.saveSubmissionAuthorization({ taskId: task.id, runId: run.id, accountId: run.accountId, effectivePreferenceDigest: "digest", reviewDigest: "review", idempotencyKey: run.id, policy: "disabled", acknowledgementVersion: 1, checkpointVersion: 1, createdAt: task.createdAt, expiresAt: "2099-01-01T00:00:00.000Z", consumed: false });
  }
  return { db, task, accountIds: persistedAccountIds };
}
