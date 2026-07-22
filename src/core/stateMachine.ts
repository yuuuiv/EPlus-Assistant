import type { AccountRunStatus, PaymentRunState, SubmissionIntentStatus, TaskStatus } from "../shared/types.js";

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
  AwaitingManualAction: ["LoggingIn", "FillingForm", "Failed", "Cancelled"],
  FillingForm: ["AwaitingSubmitConfirmation", "AwaitingManualAction", "Failed", "Cancelled"],
  AwaitingSubmitConfirmation: ["Submitting", "AwaitingManualAction", "Cancelled"],
  Submitting: ["AwaitingCompletionEmail", "Submitted", "UnknownSubmissionState", "Failed", "Cancelled"],
  AwaitingCompletionEmail: ["Submitted", "Failed", "Cancelled"],
  Submitted: [],
  AlreadyApplied: [],
  UnknownSubmissionState: ["Submitted", "AlreadyApplied", "Failed"],
  Failed: [],
  Cancelled: []
};

const paymentRunTransitions: Record<PaymentRunState, PaymentRunState[]> = {
  Idle: ["PaymentDiscoveryPending"],
  PaymentDiscoveryPending: ["PaymentSelectionPending"],
  PaymentSelectionPending: ["PaymentSelectionApplied"],
  PaymentSelectionApplied: ["Submitting"],
  Submitting: ["UnknownSubmissionState"],
  UnknownSubmissionState: []
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

export function canTransitionPaymentRun(from: PaymentRunState, to: PaymentRunState): boolean {
  return paymentRunTransitions[from].includes(to);
}

export function isPaymentStateAllowedForRun(status: AccountRunStatus, paymentState: PaymentRunState): boolean {
  switch (status) {
    case "Pending":
    case "LoggingIn":
    case "AwaitingEmailCode":
      return paymentState === "Idle";
    case "FillingForm":
      return paymentState === "PaymentDiscoveryPending" || paymentState === "PaymentSelectionPending" || paymentState === "PaymentSelectionApplied";
    case "AwaitingSubmitConfirmation":
      return paymentState === "PaymentSelectionApplied";
    case "Submitting":
    case "AwaitingCompletionEmail":
      return paymentState === "Submitting";
    case "UnknownSubmissionState":
      return paymentState === "UnknownSubmissionState";
    case "AwaitingManualAction":
    case "Submitted":
    case "AlreadyApplied":
    case "Failed":
    case "Cancelled":
      return true;
  }
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

export function assertPaymentRunTransition(from: PaymentRunState, to: PaymentRunState): void {
  if (!canTransitionPaymentRun(from, to)) {
    throw new Error(`Invalid payment transition: ${from} -> ${to}`);
  }
}

export function assertPaymentStateForRun(status: AccountRunStatus, paymentState: PaymentRunState): void {
  if (!isPaymentStateAllowedForRun(status, paymentState)) {
    throw new Error(`Payment state ${paymentState} is not valid for run status ${status}.`);
  }
}

export function canResumeManualAction(paymentState: PaymentRunState): boolean {
  return paymentState === "PaymentDiscoveryPending" || paymentState === "PaymentSelectionPending" || paymentState === "UnknownSubmissionState";
}

export function assertSubmissionIntentTransition(from: SubmissionIntentStatus, to: SubmissionIntentStatus): void {
  if (!canTransitionSubmissionIntent(from, to)) {
    throw new Error(`Invalid submission intent transition: ${from} -> ${to}`);
  }
}
