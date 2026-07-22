import { randomUUID } from "node:crypto";
import type { AccountRun, AccountRunStatus, AutomationRiskAcknowledgement, CreateTaskInput, CreateTaskInputV2, DeviceProfileKey, EventSnapshot, LotteryTask, ManualActionInput, TaskStatus } from "../../shared/types.js";
import { makeConfirmationDigest } from "../../core/digest.js";
import { assertRunTransition, assertTaskTransition } from "../../core/stateMachine.js";
import { PaymentValidationError } from "../../shared/types.js";
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
    assertTaskPaymentBoundary(input);
    const deviceProfileKey = validateDeviceProfileKey(input.deviceProfileKey);
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
      deviceProfileKey,
      createdAt: now,
      updatedAt: now
    };
    this.db.createTask(task);
    return { taskId };
  }

  createTaskV2(input: CreateTaskInputV2 & { event: EventSnapshot }): { taskId: string } {
    assertTaskPaymentBoundary(input);
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
    if (input.action === "cancel-account") {
      this.updateRunStatus(run.id, "Cancelled");
      return;
    }
    if (input.action === "cancel-task") {
      const task = this.db.listTasks().find((candidate) => candidate.id === run.taskId);
      if (!task) throw new Error("Task not found.");
      for (const taskRun of this.db.listRunsForTask(task.id).filter((candidate) => candidate.status !== "Cancelled" && candidate.status !== "Submitted" && candidate.status !== "AlreadyApplied")) this.updateRunStatus(taskRun.id, "Cancelled");
      this.updateTaskStatus(task.id, "Cancelled");
      return;
    }
    if (input.action === "continue") {
      if (run.status !== "AwaitingManualAction") throw new Error("Only a manual-action run can continue.");
      this.updateRunStatus(run.id, "FillingForm");
      return;
    }
    if (input.action === "reconcile-unknown" && run.status !== "UnknownSubmissionState") throw new Error("Only an unknown submission can be reconciled.");
  }
}

export function validateConfirmationPolicy(policy: "required" | "disabled", riskAck: AutomationRiskAcknowledgement | undefined): boolean {
  return (policy === "required" || policy === "disabled") && Boolean(riskAck && riskAck.version > 0 && riskAck.acknowledgedAt && riskAck.disclosureDigest);
}

export function validateTaskInput(input: CreateTaskInput, event: EventSnapshot): string[] {
  const errors: string[] = [];
  if (paymentPreferenceValues(input).some(isSensitivePaymentCredential)) errors.push("Payment credential fields are not accepted in task preferences.");
  if (input.accountIds.length === 0) errors.push("Select at least one account.");
  const knownAccounts = new Set(input.accountIds);
  if (knownAccounts.size !== input.accountIds.length) errors.push("Each account may be selected only once.");
  if (event.rawFormSchema.serialCode.required) {
    const commonCode = input.preference.serialCode?.trim();
    const codes = input.preference.serialCodesByAccountId ?? {};
    const allocations = input.preference.serialCodeAllocations ?? {};
    if (Object.keys(allocations).some((accountId) => !input.accountIds.includes(accountId))) errors.push("Serial-code allocations may only target selected accounts.");
    const assignedCodes = new Set<string>();
    for (const [accountId, values] of Object.entries(allocations)) {
      if (!Array.isArray(values)) {
        errors.push(`Serial-code allocation for account ${accountId} is invalid.`);
        continue;
      }
      if (values.some((value) => !value.code?.trim())) errors.push(`Serial-code allocation for account ${accountId} contains an empty code.`);
      for (const value of values) {
        const normalized = value.code.trim();
        if (normalized && assignedCodes.has(normalized)) errors.push("A serial code cannot be assigned more than once.");
        if (normalized) assignedCodes.add(normalized);
      }
    }
    if (input.accountIds.some((accountId) => !(commonCode || allocations[accountId]?.some((plan) => plan.code?.trim()) || codes[accountId]?.trim()))) errors.push("A serial code is required for every selected account.");
  }
  const availableDays = event.rawFormSchema.serialCode.availableDays ?? [];
  if (event.rawFormSchema.serialCode.daySelectionRequired && availableDays.length > 1) {
    const selections = input.preference.daySelectionByAccountId ?? {};
    const allocations = input.preference.serialCodeAllocations ?? {};
    for (const accountId of input.accountIds) {
      const selected = selections[accountId];
      const plans = allocations[accountId];
      if (plans?.length) {
        for (const plan of plans) if (!plan.daySelection?.length || plan.daySelection.some((day) => !availableDays.includes(day))) errors.push(`A supported day selection is required for serial code ${plan.code} on account ${accountId}.`);
      } else if (!selected?.length || selected.some((day) => !availableDays.includes(day))) errors.push(`A supported day selection is required for account ${accountId}.`);
    }
  }
  for (const entry of input.preference.entries) {
    const ticketOption = event.rawFormSchema.options.find((option) => option.kind === "ticket" && option.values.some((value) => value.id === entry.ticketTypeId));
    if (!entry.ticketTypeId || !Number.isInteger(entry.quantity) || entry.quantity < 1 || (ticketOption === undefined && event.rawFormSchema.options.some((option) => option.kind === "ticket"))) errors.push("Ticket preferences contain an invalid entry.");
  }
  const paymentOption = event.rawFormSchema.options.find((option) => option.kind === "payment");
  const paymentValues = new Map(paymentOption?.values.map((value) => [value.id, value]) ?? []);
  const semanticPreference = input.preference.paymentPreference;
  if (input.preference.paymentMethodId !== undefined && semanticPreference !== undefined && input.preference.paymentMethodId !== semanticPreference.value) throw new PaymentValidationError("InvalidPaymentSelection", "Legacy and semantic payment preferences conflict.");
  if (semanticPreference !== undefined) {
    if (semanticPreference.groupKey !== "payment" || paymentOption === undefined) throw new PaymentValidationError("InvalidPaymentSelection", "Payment preference must target the supported payment group.");
    const selectedValue = paymentValues.get(semanticPreference.value);
    if (selectedValue === undefined || selectedValue.disabled) throw new PaymentValidationError("InvalidPaymentSelection", "Payment preference is unavailable or disabled.");
  }
  if (input.preference.paymentMethodId !== undefined && paymentOption !== undefined && !paymentValues.has(input.preference.paymentMethodId)) throw new PaymentValidationError("InvalidPaymentSelection", "A legacy payment method must match a known payment option.");
  return errors;
}

export function assertTaskPaymentBoundary(input: CreateTaskInput): void {
  if (paymentPreferenceValues(input).some(isSensitivePaymentCredential)) {
    throw new PaymentValidationError("SensitivePaymentField", "Payment credential fields are not accepted in task preferences.");
  }
}

function paymentPreferenceValues(input: CreateTaskInput): string[] {
  return [input.preference.paymentMethodId, input.preference.paymentPreference?.groupKey, input.preference.paymentPreference?.value].filter((value): value is string => value !== undefined);
}

function isSensitivePaymentCredential(value: string): boolean {
  const normalized = value.toLowerCase();
  return /(?:card[-_ ]?(?:number|no)|cvv|cvc|csc|expiry|expiration|exp[-_ ]?date)/u.test(normalized) || /\b\d{12,19}\b/u.test(value);
}

export function validateDeviceProfileKey(value: DeviceProfileKey | undefined): DeviceProfileKey {
  if (value === undefined || value === "desktop-chrome" || value === "iphone-13" || value === "pixel-7") return value ?? "desktop-chrome";
  throw new PaymentValidationError("InvalidDeviceProfile", "Device profile is not approved.");
}
