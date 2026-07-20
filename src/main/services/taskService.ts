import { randomUUID } from "node:crypto";
import type { AccountRun, AccountRunStatus, CreateTaskInput, LotteryTask, TaskStatus } from "../../shared/types.js";
import { makeConfirmationDigest } from "../../core/digest.js";
import { assertRunTransition, assertTaskTransition } from "../../core/stateMachine.js";
import type { AppDatabase } from "../storage/database.js";

export class TaskService {
  constructor(private readonly db: AppDatabase) {}

  listTasks(): LotteryTask[] {
    return this.db.listTasks();
  }

  listRuns(): AccountRun[] {
    return this.db.listRuns();
  }

  createTask(input: CreateTaskInput & { canonicalUrl: string }): { taskId: string } {
    const taskId = randomUUID();
    const now = new Date().toISOString();
    const task: LotteryTask = {
      id: taskId,
      eventSnapshotId: input.eventSnapshotId,
      preference: input.preference,
      accountIds: input.accountIds,
      status: "AwaitingConfirmation",
      confirmationDigest: makeConfirmationDigest({
        canonicalUrl: input.canonicalUrl,
        preference: input.preference,
        accountIds: input.accountIds
      }),
      createdAt: now,
      updatedAt: now
    };
    this.db.createTask(task);
    return { taskId };
  }

  updateTaskStatus(taskId: string, status: TaskStatus): void {
    const task = this.db.listTasks().find((item) => item.id === taskId);
    if (!task) {
      throw new Error("Task not found.");
    }
    assertTaskTransition(task.status, status);
    this.db.updateTaskStatus(taskId, status);
  }

  updateRunStatus(runId: string, status: AccountRunStatus, note?: string): void {
    const run = this.db.listRuns().find((item) => item.id === runId);
    if (!run) {
      throw new Error("Run not found.");
    }
    assertRunTransition(run.status, status);
    this.db.updateRun({
      id: runId,
      status,
      errorDetailRedacted: note
    });
  }
}
