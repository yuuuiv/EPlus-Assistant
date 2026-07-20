import { describe, expect, it } from "vitest";
import { canTransitionRun, canTransitionTask } from "./stateMachine.js";

describe("lottery state machine", () => {
  it("allows the documented task path", () => {
    expect(canTransitionTask("Draft", "AwaitingConfirmation")).toBe(true);
    expect(canTransitionTask("AwaitingConfirmation", "Queued")).toBe(true);
    expect(canTransitionTask("Queued", "Running")).toBe(true);
    expect(canTransitionTask("Running", "Completed")).toBe(true);
  });

  it("blocks blind retry after an unknown submission state", () => {
    expect(canTransitionRun("UnknownSubmissionState", "Submitting")).toBe(false);
    expect(canTransitionRun("UnknownSubmissionState", "AwaitingManualAction")).toBe(true);
  });
});
