import type { AccountRun, AccountRunStatus, LotteryTask, SubmissionAuthorization, TaskStatus } from "../../shared/types.js";
import type { LotteryOrchestrator } from "./lotteryOrchestrator.js";
import type { AppDatabase } from "../storage/database.js";

export type TaskQueueEvent =
  | { kind: "run-started"; taskId: string; runId: string; accountId: string }
  | { kind: "run-completed"; taskId: string; runId: string; accountId: string; status: string }
  | { kind: "run-failed"; taskId: string; runId: string; accountId: string; error: string }
  | { kind: "manual-action-required"; taskId: string; runId: string; accountId: string; state: string }
  | { kind: "task-completed"; taskId: string; status: string }
  | { kind: "task-failed"; taskId: string; error: string };

export interface QueueState {
  queue: Array<{ taskId: string; runIndex: number }>;
  currentRun: { taskId: string; runId: string; accountId: string } | null;
  status: "idle" | "running" | "paused" | "completed";
  events: TaskQueueEvent[];
}

type QueueItem = { readonly taskId: string; readonly runIndex: number };
type RunExecutor = Pick<LotteryOrchestrator, "runSingleAccount" | "reconcile">;
type ManualAction = "continue" | "cancel-account" | "cancel-task" | "reconcile-unknown";

const completedStatuses = new Set<AccountRunStatus>(["Submitted", "AlreadyApplied"]);
const terminalStatuses = new Set<AccountRunStatus>(["Submitted", "AlreadyApplied", "Failed", "Cancelled", "UnknownSubmissionState"]);

export class QueueService {
  private readonly queue: QueueItem[] = [];
  private readonly events: TaskQueueEvent[] = [];
  private readonly subscribers = new Set<(event: TaskQueueEvent) => void>();
  private currentRun: QueueState["currentRun"] = null;
  private status: QueueState["status"] = "idle";
  private pauseRequested = false;
  private processing = false;

  constructor(
    private readonly orchestrator: RunExecutor,
    private readonly db: AppDatabase
  ) {}

  async enqueueTask(task: LotteryTask): Promise<void> {
    if (task.status !== "Queued") throw new Error("Only queued tasks can be enqueued.");
    if (!this.db.getEvent(task.eventSnapshotId)) throw new Error("Task event snapshot was not found.");

    const runsByAccount = new Map(this.db.listRunsForTask(task.id).map((run) => [run.accountId, run]));
    const orderedRuns = task.accountIds.map((accountId) => runsByAccount.get(accountId));
    if (orderedRuns.some((run) => !run)) throw new Error("Task account runs are incomplete.");

    for (let runIndex = 0; runIndex < orderedRuns.length; runIndex += 1) {
      const run = orderedRuns[runIndex];
      if (run?.status === "Pending") this.queue.push({ taskId: task.id, runIndex });
    }
    this.audit(task.id, undefined, "info", "queue.task.enqueued", { runCount: orderedRuns.length });
    if (this.status === "idle" || this.status === "completed") await this.processNext();
  }

  async processNext(): Promise<void> {
    if (this.processing || this.status === "paused") return;
    this.processing = true;
    this.status = "running";
    try {
      while (!this.pauseRequested) {
        const item = this.queue.shift();
        if (!item) {
          this.status = "completed";
          return;
        }
        await this.processItem(item);
      }
      this.pauseRequested = false;
      this.status = "paused";
    } finally {
      this.processing = false;
    }
  }

  async pause(): Promise<void> {
    this.pauseRequested = true;
    if (!this.processing) this.status = "paused";
    this.audit(undefined, undefined, "info", "queue.pause.requested", {});
  }

  async resume(): Promise<void> {
    if (this.status !== "paused") return;
    this.pauseRequested = false;
    this.audit(undefined, undefined, "info", "queue.resumed", {});
    await this.processNext();
  }

  async cancelRun(runId: string): Promise<void> {
    const run = this.requireRun(runId);
    if (this.processing && this.currentRun?.runId === runId) {
      throw new Error("An active browser run cannot be cancelled until it reaches a checkpoint.");
    }
    if (!terminalStatuses.has(run.status)) this.db.updateRun({ id: run.id, status: "Cancelled", errorDetailRedacted: "Cancelled by operator." });
    this.removeQueuedRun(run);
    this.audit(run.taskId, run.id, "info", "queue.run.cancelled", {});
    this.aggregateTask(run.taskId);
  }

  async cancelTask(taskId: string): Promise<void> {
    const task = this.requireTask(taskId);
    for (const run of this.db.listRunsForTask(taskId)) {
      if (!terminalStatuses.has(run.status)) this.db.updateRun({ id: run.id, status: "Cancelled", errorDetailRedacted: "Task cancelled by operator." });
    }
    this.removeQueuedTask(taskId);
    if (task.status !== "Cancelled") this.db.updateTaskStatus(taskId, "Cancelled");
    this.audit(taskId, undefined, "info", "queue.task.cancelled", {});
    this.emit({ kind: "task-completed", taskId, status: "Cancelled" });
  }

  async performManualAction(input: { readonly runId: string; readonly action: ManualAction }): Promise<void> {
    const run = this.requireRun(input.runId);
    const task = this.requireTask(run.taskId);
    if (input.action === "cancel-account") return this.cancelRun(run.id);
    if (input.action === "cancel-task") return this.cancelTask(task.id);
    if (input.action === "reconcile-unknown") {
      if (run.status !== "UnknownSubmissionState") throw new Error("Only an unknown submission can be reconciled.");
      const result = await this.orchestrator.reconcile({ run, task });
      this.audit(task.id, run.id, "info", "queue.run.reconciled", { result });
      this.aggregateTask(task.id);
      return;
    }
    if (run.status !== "AwaitingManualAction" && run.status !== "AwaitingSubmitConfirmation") {
      throw new Error("Only the current manual checkpoint can continue.");
    }
    if (!this.currentRun || this.currentRun.runId !== run.id) throw new Error("Manual action is stale for this queue run.");
    this.queue.unshift(this.itemForRun(task, run));
    this.currentRun = null;
    this.status = "idle";
    this.audit(task.id, run.id, "info", "queue.run.continued", {});
    await this.processNext();
  }

  getState(): QueueState {
    return {
      queue: this.queue.map((item) => ({ ...item })),
      currentRun: this.currentRun ? { ...this.currentRun } : null,
      status: this.status,
      events: [...this.events]
    };
  }

  subscribe(callback: (event: TaskQueueEvent) => void): () => void {
    this.subscribers.add(callback);
    return () => this.subscribers.delete(callback);
  }

  private async processItem(item: QueueItem): Promise<void> {
    const task = this.requireTask(item.taskId);
    const run = this.runForItem(task, item);
    if (run.status === "Cancelled" || terminalStatuses.has(run.status)) {
      this.aggregateTask(task.id);
      return;
    }
    const event = this.db.getEvent(task.eventSnapshotId);
    if (!event) throw new Error("Task event snapshot was not found.");
    const authorization = this.db.getSubmissionAuthorization(run.id);
    if (!authorization) return this.pauseForManualAction(task, run, "AwaitingSubmissionAuthorization");

    if (task.status !== "Running") this.db.updateTaskStatus(task.id, "Running");
    this.currentRun = { taskId: task.id, runId: run.id, accountId: run.accountId };
    this.emit({ kind: "run-started", taskId: task.id, runId: run.id, accountId: run.accountId });
    this.audit(task.id, run.id, "info", "queue.run.started", {});
    try {
      const result = await this.orchestrator.runSingleAccount({ run, task, event, policy: authorization.policy, authorization });
      this.handleResult(task, result);
    } catch (error) {
      const message = redactError(error);
      this.db.updateRun({ id: run.id, status: "Failed", errorDetailRedacted: message });
      this.emit({ kind: "run-failed", taskId: task.id, runId: run.id, accountId: run.accountId, error: message });
      this.audit(task.id, run.id, "error", "queue.run.failed", { error: message });
    } finally {
      if (this.currentRun?.runId === run.id && !isManualCheckpoint(this.requireRun(run.id).status)) this.currentRun = null;
      this.aggregateTask(task.id);
    }
  }

  private handleResult(task: LotteryTask, run: AccountRun): void {
    if (isManualCheckpoint(run.status)) {
      this.pauseForManualAction(task, run, run.status);
      return;
    }
    if (completedStatuses.has(run.status)) {
      this.emit({ kind: "run-completed", taskId: task.id, runId: run.id, accountId: run.accountId, status: run.status });
      this.audit(task.id, run.id, "info", "queue.run.completed", { status: run.status });
      return;
    }
    const error = run.errorDetailRedacted ?? `Run ended with ${run.status}.`;
    this.emit({ kind: "run-failed", taskId: task.id, runId: run.id, accountId: run.accountId, error });
    this.audit(task.id, run.id, "error", "queue.run.failed", { error });
  }

  private pauseForManualAction(task: LotteryTask, run: AccountRun, state: string): void {
    this.currentRun = { taskId: task.id, runId: run.id, accountId: run.accountId };
    if (task.status !== "Paused") this.db.updateTaskStatus(task.id, "Paused");
    this.pauseRequested = true;
    this.status = "paused";
    this.emit({ kind: "manual-action-required", taskId: task.id, runId: run.id, accountId: run.accountId, state });
    this.audit(task.id, run.id, "warn", "queue.manual-action.required", { state });
  }

  private aggregateTask(taskId: string): void {
    const task = this.requireTask(taskId);
    const runs = this.db.listRunsForTask(taskId);
    if (runs.some((run) => !terminalStatuses.has(run.status))) return;
    const failed = runs.find((run) => run.status === "Failed" || run.status === "UnknownSubmissionState");
    const status: TaskStatus = failed ? "Failed" : runs.every((run) => run.status === "Cancelled") ? "Cancelled" : "Completed";
    if (task.status !== status) this.db.updateTaskStatus(taskId, status);
    if (failed) {
      const error = failed.errorDetailRedacted ?? `Run ${failed.id} failed.`;
      this.emit({ kind: "task-failed", taskId, error });
      this.audit(taskId, failed.id, "error", "queue.task.failed", { error });
      return;
    }
    this.emit({ kind: "task-completed", taskId, status });
    this.audit(taskId, undefined, "info", "queue.task.completed", { status });
  }

  private runForItem(task: LotteryTask, item: QueueItem): AccountRun {
    const accountId = task.accountIds[item.runIndex];
    if (!accountId) throw new Error("Queue run index is invalid.");
    const run = this.db.listRunsForTask(task.id).find((candidate) => candidate.accountId === accountId);
    if (!run) throw new Error("Task account run was not found.");
    return run;
  }

  private itemForRun(task: LotteryTask, run: AccountRun): QueueItem {
    const runIndex = task.accountIds.indexOf(run.accountId);
    if (runIndex < 0) throw new Error("Run account is not part of its task.");
    return { taskId: task.id, runIndex };
  }

  private requireTask(taskId: string): LotteryTask {
    const task = this.db.listTasks().find((candidate) => candidate.id === taskId);
    if (!task) throw new Error("Task was not found.");
    return task;
  }

  private requireRun(runId: string): AccountRun {
    const run = this.db.listRuns().find((candidate) => candidate.id === runId);
    if (!run) throw new Error("Account run was not found.");
    return run;
  }

  private removeQueuedRun(run: AccountRun): void {
    const task = this.requireTask(run.taskId);
    const item = this.itemForRun(task, run);
    this.removeQueueItems((candidate) => candidate.taskId === item.taskId && candidate.runIndex === item.runIndex);
  }

  private removeQueuedTask(taskId: string): void {
    this.removeQueueItems((candidate) => candidate.taskId === taskId);
  }

  private removeQueueItems(matches: (item: QueueItem) => boolean): void {
    for (let index = this.queue.length - 1; index >= 0; index -= 1) {
      const item = this.queue[index];
      if (item && matches(item)) this.queue.splice(index, 1);
    }
  }

  private emit(event: TaskQueueEvent): void {
    this.events.push(event);
    for (const subscriber of this.subscribers) subscriber(event);
  }

  private audit(taskId: string | undefined, accountRunId: string | undefined, level: "info" | "warn" | "error", message: string, metadata: Record<string, unknown>): void {
    this.db.addLog({ taskId, accountRunId, level, message, metadata });
  }
}

function isManualCheckpoint(status: AccountRunStatus): boolean {
  return status === "AwaitingManualAction" || status === "AwaitingSubmitConfirmation";
}

function redactError(error: unknown): string {
  const message = error instanceof Error ? error.message : "Account run failed.";
  return message.replace(/https?:\/\/[^\s]+/giu, "[redacted-url]").slice(0, 500);
}
