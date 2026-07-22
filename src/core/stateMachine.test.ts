import { describe, expect, it } from "vitest";
import { canResumeManualAction, canTransitionPaymentRun, canTransitionRun, canTransitionSubmissionIntent, canTransitionTask, isPaymentStateAllowedForRun } from "./stateMachine.js";

describe("lottery state machine", () => {
  it("allows the documented task path", () => {
    expect(canTransitionTask("Draft", "AwaitingConfirmation")).toBe(true);
    expect(canTransitionTask("AwaitingConfirmation", "Queued")).toBe(true);
    expect(canTransitionTask("Queued", "Running")).toBe(true);
    expect(canTransitionTask("Running", "Completed")).toBe(true);
  });

  it("blocks blind retry after an unknown submission state", () => {
    expect(canTransitionRun("UnknownSubmissionState", "Submitting")).toBe(false);
  });

  it("allows unknown submissions to reconcile to a verified outcome", () => {
    expect(canTransitionRun("UnknownSubmissionState", "Submitted")).toBe(true);
    expect(canTransitionRun("UnknownSubmissionState", "AlreadyApplied")).toBe(true);
    expect(canTransitionRun("UnknownSubmissionState", "Failed")).toBe(true);
  });

  it("allows only the documented submission intent lifecycle", () => {
    expect(canTransitionSubmissionIntent("Prepared", "Dispatching")).toBe(true);
    expect(canTransitionSubmissionIntent("Dispatching", "Acknowledged")).toBe(true);
    expect(canTransitionSubmissionIntent("Dispatching", "Unknown")).toBe(true);
    expect(canTransitionSubmissionIntent("Unknown", "Acknowledged")).toBe(true);
    expect(canTransitionSubmissionIntent("Unknown", "Failed")).toBe(true);
    expect(canTransitionSubmissionIntent("Unknown", "Dispatching")).toBe(false);
  });

  it("keeps task and account-run transitions distinct", () => {
    expect(canTransitionTask("Queued", "Running")).toBe(true);
    expect(canTransitionRun("Pending", "LoggingIn")).toBe(true);
    expect(canTransitionRun("Pending", "Submitting")).toBe(false);
  });

  it("allows the locked payment lifecycle and rejects direct manual submission", () => {
    expect(canTransitionPaymentRun("Idle", "PaymentDiscoveryPending")).toBe(true);
    expect(canTransitionPaymentRun("PaymentSelectionPending", "PaymentSelectionApplied")).toBe(true);
    expect(canTransitionRun("AwaitingManualAction", "Submitting")).toBe(false);
    expect(isPaymentStateAllowedForRun("AwaitingSubmitConfirmation", "PaymentSelectionApplied")).toBe(true);
    expect(isPaymentStateAllowedForRun("Submitting", "PaymentSelectionApplied")).toBe(false);
    expect(canResumeManualAction("PaymentDiscoveryPending")).toBe(true);
    expect(canResumeManualAction("PaymentSelectionPending")).toBe(true);
    expect(canResumeManualAction("PaymentSelectionApplied")).toBe(false);
  });

  it("keeps recovery read-only and disallows payment-state skips", () => {
    expect(canTransitionPaymentRun("PaymentDiscoveryPending", "PaymentSelectionApplied")).toBe(false);
    expect(canTransitionPaymentRun("UnknownSubmissionState", "PaymentSelectionApplied")).toBe(false);
    expect(canTransitionRun("UnknownSubmissionState", "AwaitingManualAction")).toBe(false);
  });
});
