import type { AccountRunStatus, SubmissionIntentStatus, TaskStatus } from "../shared/types.js";

const taskTransitions: Record<TaskStatus, TaskStatus[]> = {
  Draft: ["AwaitingConfirmation", "Cancelled"],
  AwaitingConfirmation: ["Queued", "Draft", "Cancelled"],
  Queued: ["Running", "Cancelled"],
  Running: ["Paused", "Completed", "Failed", "Cancelled"],
  Paused: ["Running", "Failed", "Cancelled"],
  Completed: [],
  Failed: ["Queued"],
  Cancelled: []
};

const runTransitions: Record<AccountRunStatus, AccountRunStatus[]> = {
  Pending: ["LoggingIn", "Cancelled"],
  LoggingIn: ["AwaitingEmailCode", "AwaitingManualAction", "FillingForm", "Failed", "Cancelled"],
  AwaitingEmailCode: ["FillingForm", "AwaitingManualAction", "Failed", "Cancelled"],
  AwaitingManualAction: ["LoggingIn", "FillingForm", "Submitting", "Failed", "Cancelled"],
  FillingForm: ["AwaitingSubmitConfirmation", "AwaitingManualAction", "Failed", "Cancelled"],
  AwaitingSubmitConfirmation: ["Submitting", "AwaitingManualAction", "Cancelled"],
  Submitting: ["Submitted", "UnknownSubmissionState", "Failed", "Cancelled"],
  Submitted: [],
  AlreadyApplied: [],
  UnknownSubmissionState: ["Submitted", "AlreadyApplied", "Failed"],
  Failed: [],
  Cancelled: []
};

const submissionIntentTransitions: Record<SubmissionIntentStatus, SubmissionIntentStatus[]> = {
  Prepared: ["Dispatching"],
  Dispatching: ["Acknowledged", "Unknown"],
  Acknowledged: [],
  Unknown: ["Acknowledged", "Failed"],
  Failed: []
};

export function canTransitionTask(from: TaskStatus, to: TaskStatus): boolean {
  return taskTransitions[from].includes(to);
}

export function canTransitionRun(from: AccountRunStatus, to: AccountRunStatus): boolean {
  return runTransitions[from].includes(to);
}

export function canTransitionSubmissionIntent(from: SubmissionIntentStatus, to: SubmissionIntentStatus): boolean {
  return submissionIntentTransitions[from].includes(to);
}

export function assertTaskTransition(from: TaskStatus, to: TaskStatus): void {
  if (!canTransitionTask(from, to)) {
    throw new Error(`Invalid task transition: ${from} -> ${to}`);
  }
}

export function assertRunTransition(from: AccountRunStatus, to: AccountRunStatus): void {
  if (!canTransitionRun(from, to)) {
    throw new Error(`Invalid account run transition: ${from} -> ${to}`);
  }
}

export function assertSubmissionIntentTransition(from: SubmissionIntentStatus, to: SubmissionIntentStatus): void {
  if (!canTransitionSubmissionIntent(from, to)) {
    throw new Error(`Invalid submission intent transition: ${from} -> ${to}`);
  }
}
