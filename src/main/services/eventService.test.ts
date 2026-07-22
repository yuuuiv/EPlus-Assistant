import { describe, expect, it, vi } from "vitest";
import { EventService } from "./eventService.js";
import type { AppDatabase } from "../storage/database.js";
import type { EventSnapshot, LotteryTask } from "../../shared/types.js";

const event: EventSnapshot = {
  id: "event", sourceUrl: "https://eplus.jp/source", canonicalUrl: "https://eplus.jp/event", title: "Event", fetchedAt: "2026-07-21T00:00:00.000Z", pageFingerprint: "fingerprint",
  rawFormSchema: { sourceKind: "standard-detail", options: [], applicationLinks: [], serialCode: { required: false, label: "Code", errorSelectors: [], knownErrorMessages: [] }, selectorHints: {}, requiresManualInspection: false, notes: [] }
};

function task(status: LotteryTask["status"]): LotteryTask {
  return { id: "task", eventSnapshotId: event.id, preference: { entries: [], consentFlags: {} }, accountIds: ["account"], status, confirmationDigest: "digest", createdAt: event.fetchedAt, updatedAt: event.fetchedAt };
}

describe("EventService.deleteEvent", () => {
  it("rejects deleting a snapshot still referenced by a non-terminal task", () => {
    const deleteEvent = vi.fn();
    const service = new EventService({ getEvent: () => event, listTasks: () => [task("Running")], deleteEvent } as unknown as AppDatabase);

    expect(() => service.deleteEvent(event.id)).toThrow("有未完成的任务仍在使用该演出快照");
    expect(deleteEvent).not.toHaveBeenCalled();
  });

  it("allows deleting a snapshot once its only tasks are terminal", () => {
    const deleteEvent = vi.fn();
    const service = new EventService({ getEvent: () => event, listTasks: () => [task("Completed")], deleteEvent } as unknown as AppDatabase);

    service.deleteEvent(event.id);

    expect(deleteEvent).toHaveBeenCalledWith(event.id);
  });

  it("allows deleting a snapshot with no referencing tasks at all", () => {
    const deleteEvent = vi.fn();
    const service = new EventService({ getEvent: () => event, listTasks: () => [], deleteEvent } as unknown as AppDatabase);

    service.deleteEvent(event.id);

    expect(deleteEvent).toHaveBeenCalledWith(event.id);
  });

  it("rejects deleting a snapshot that does not exist", () => {
    const service = new EventService({ getEvent: () => undefined, listTasks: () => [], deleteEvent: vi.fn() } as unknown as AppDatabase);

    expect(() => service.deleteEvent("missing")).toThrow("Event snapshot not found");
  });
});
