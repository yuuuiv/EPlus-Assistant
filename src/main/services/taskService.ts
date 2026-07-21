import { randomUUID } from "node:crypto";
import type { AccountRun, AccountRunStatus, AutomationRiskAcknowledgement, CreateTaskInput, CreateTaskInputV2, EventSnapshot, LotteryTask, ManualActionInput, TaskStatus } from "../../shared/types.js";
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

  createTask(input: CreateTaskInput & { canonicalUrl: string; confirmationPolicy?: "required" | "disabled"; automationRiskAcknowledgement?: AutomationRiskAcknowledgement }): { taskId: string } {
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
        accountIds: input.accountIds,
        confirmationPolicy: input.confirmationPolicy,
        automationRiskAcknowledgementVersion: input.automationRiskAcknowledgement?.version
      }),
      createdAt: now,
      updatedAt: now
    };
    this.db.createTask(task);
    return { taskId };
  }

  createTaskV2(input: CreateTaskInputV2 & { event: EventSnapshot }): { taskId: string } {
    const errors = validateTaskInput(input, input.event);
    const accounts = new Set(this.db.listAccounts().map((account) => account.id));
    if (input.accountIds.some((accountId) => !accounts.has(accountId))) errors.push("Every selected account must exist.");
    if (errors.length > 0) throw new Error(errors.join(" "));
    if (!validateConfirmationPolicy(input.confirmationPolicy, input.automationRiskAcknowledgement)) {
      throw new Error("Automated submission requires a current automation risk acknowledgement.");
    }
    return this.createTask({ ...input, canonicalUrl: input.event.canonicalUrl });
  }

  previewEffectivePreferences(input: CreateTaskInput): Array<{ accountId: string; preference: CreateTaskInput["preference"] }> {
    return input.accountIds.map((accountId) => ({ accountId, preference: { ...input.preference, serialCode: input.preference.serialCodesByAccountId?.[accountId] ?? input.preference.serialCode, daySelectionByAccountId: input.preference.daySelectionByAccountId ? { [accountId]: input.preference.daySelectionByAccountId[accountId] ?? [] } : undefined } }));
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

  performManualAction(input: ManualActionInput): void {
    const run = this.db.listRuns().find((candidate) => candidate.id === input.runId);
    if (!run) throw new Error("Account run not found.");
    if (input.action === "cancel-account") return this.updateRunStatus(run.id, "Cancelled");
    if (input.action === "cancel-task") {
      const task = this.db.listTasks().find((candidate) => candidate.id === run.taskId);
      if (!task) throw new Error("Task not found.");
      for (const taskRun of this.db.listRunsForTask(task.id).filter((candidate) => candidate.status !== "Cancelled" && candidate.status !== "Submitted" && candidate.status !== "AlreadyApplied")) this.updateRunStatus(taskRun.id, "Cancelled");
      return this.updateTaskStatus(task.id, "Cancelled");
    }
    if (input.action === "continue") {
      if (run.status !== "AwaitingManualAction") throw new Error("Only a manual-action run can continue.");
      return this.updateRunStatus(run.id, "FillingForm");
    }
    if (input.action === "reconcile-unknown" && run.status !== "UnknownSubmissionState") throw new Error("Only an unknown submission can be reconciled.");
  }
}

export function validateConfirmationPolicy(policy: "required" | "disabled", riskAck: AutomationRiskAcknowledgement | undefined): boolean {
  return (policy === "required" || policy === "disabled") && Boolean(riskAck && riskAck.version > 0 && riskAck.acknowledgedAt && riskAck.disclosureDigest);
}

export function validateTaskInput(input: CreateTaskInput, event: EventSnapshot): string[] {
  const errors: string[] = [];
  if (input.accountIds.length === 0) errors.push("Select at least one account.");
  const knownAccounts = new Set(input.accountIds);
  if (knownAccounts.size !== input.accountIds.length) errors.push("Each account may be selected only once.");
  if (event.rawFormSchema.serialCode.required) {
    const commonCode = input.preference.serialCode?.trim();
    const codes = input.preference.serialCodesByAccountId ?? {};
    if (input.accountIds.some((accountId) => !(commonCode || codes[accountId]?.trim()))) errors.push("A serial code is required for every selected account.");
  }
  const availableDays = event.rawFormSchema.serialCode.availableDays ?? [];
  if (event.rawFormSchema.serialCode.daySelectionRequired && availableDays.length > 1) {
    const selections = input.preference.daySelectionByAccountId ?? {};
    for (const accountId of input.accountIds) {
      const selected = selections[accountId];
      if (!selected?.length || selected.some((day) => !availableDays.includes(day))) errors.push(`A supported day selection is required for account ${accountId}.`);
    }
  }
  const options = new Map(event.rawFormSchema.options.flatMap((option) => option.values.map((value) => [value.id, option] as const)));
  for (const entry of input.preference.entries) {
    if (!entry.ticketTypeId || !Number.isInteger(entry.quantity) || entry.quantity < 1 || (options.size > 0 && !options.has(entry.ticketTypeId))) errors.push("Ticket preferences contain an invalid entry.");
  }
  if (!input.preference.paymentMethodId || (options.size > 0 && !options.has(input.preference.paymentMethodId))) errors.push("A supported payment method is required.");
  return errors;
}
