import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { stableJson } from "../../core/digest.js";
import type { AccountRun, EventSnapshot, LotteryTask } from "../../shared/types.js";
import { AppDatabase } from "../storage/database.js";
import { LotteryOrchestrator } from "./lotteryOrchestrator.js";
import { NetworkService } from "./networkService.js";
import type { PageState } from "../engines/pageStateClassifier.js";
import type { ReviewPageData } from "../adapters/eplusAdapter.js";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });

describe("LotteryOrchestrator", () => {
  it("submits once after review digest verification and extracts the receipt", async () => {
    const fixture = await createFixture();
    const review: ReviewPageData = { state: "LotteryForm", url: "https://eplus.jp/review", text: "Review" };
    const adapter = adapterFixture(review);
    const orchestrator = createOrchestrator(fixture.db, adapter);
    const authorization = orchestrator.createAuthorization({ taskId: fixture.task.id, runId: fixture.run.id, accountId: fixture.run.accountId, preference: fixture.task.preference, reviewDigest: digest(review), policy: "disabled", acknowledgementVersion: 1 });
    fixture.db.saveSubmissionAuthorization(authorization);

    const result = await orchestrator.runSingleAccount({ ...fixture, policy: "disabled", authorization });

    expect(result.status).toBe("Submitted");
    expect(result.externalApplicationId).toBe("EP12345678");
    expect(adapter.submitApplication).toHaveBeenCalledOnce();
    expect(fixture.db.getSubmissionIntent(fixture.run.id)?.status).toBe("Acknowledged");
  });

  it("changed review payload pauses and prevents submission", async () => {
    const fixture = await createFixture();
    const adapter = adapterFixture({ state: "LotteryForm", url: "https://eplus.jp/review", text: "Changed" });
    const orchestrator = createOrchestrator(fixture.db, adapter);
    const authorization = orchestrator.createAuthorization({ taskId: fixture.task.id, runId: fixture.run.id, accountId: fixture.run.accountId, preference: fixture.task.preference, reviewDigest: "different", policy: "disabled", acknowledgementVersion: 1 });
    fixture.db.saveSubmissionAuthorization(authorization);

    const result = await orchestrator.runSingleAccount({ ...fixture, policy: "disabled", authorization });

    expect(result.status).toBe("AwaitingManualAction");
    expect(adapter.submitApplication).not.toHaveBeenCalled();
  });

  it("ambiguous final timeout produces UnknownSubmissionState and reconciliation never resubmits", async () => {
    const fixture = await createFixture();
    const review: ReviewPageData = { state: "LotteryForm", url: "https://eplus.jp/review", text: "Review" };
    const adapter = adapterFixture(review);
    adapter.submitApplication.mockRejectedValue(new Error("timeout"));
    const orchestrator = createOrchestrator(fixture.db, adapter);
    const authorization = orchestrator.createAuthorization({ taskId: fixture.task.id, runId: fixture.run.id, accountId: fixture.run.accountId, preference: fixture.task.preference, reviewDigest: digest(review), policy: "disabled", acknowledgementVersion: 1 });
    fixture.db.saveSubmissionAuthorization(authorization);

    expect((await orchestrator.runSingleAccount({ ...fixture, policy: "disabled", authorization })).status).toBe("UnknownSubmissionState");
    expect(await orchestrator.reconcile({ run: fixture.db.listRuns()[0]!, task: fixture.task })).toBe("Failed");
    expect(adapter.submitApplication).toHaveBeenCalledOnce();
  });
});

async function createFixture(): Promise<{ db: AppDatabase; task: LotteryTask; run: AccountRun; event: EventSnapshot }> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "eplus-orchestrator-")); directories.push(directory);
  const db = new AppDatabase(directory); await db.open();
  const account = db.upsertAccount({ id: "account", eplusEmail: "person@example.test", password: "unused", encryptedPassword: "encrypted", encryptedMailConfig: "mail" });
  const event: EventSnapshot = { id: "event", sourceUrl: "https://eplus.jp/source", canonicalUrl: "https://eplus.jp/event", title: "Event", fetchedAt: "2026-07-21T00:00:00.000Z", pageFingerprint: "fp", rawFormSchema: { sourceKind: "standard-detail", options: [], applicationLinks: [], serialCode: { required: false, label: "Code", errorSelectors: [], knownErrorMessages: [] }, selectorHints: {}, requiresManualInspection: false, notes: [] } }; db.saveEventSnapshot(event);
  const task: LotteryTask = { id: "task", eventSnapshotId: event.id, preference: { entries: [], paymentMethodId: "store", consentFlags: {} }, accountIds: [account.id], status: "AwaitingConfirmation", confirmationDigest: "digest", createdAt: event.fetchedAt, updatedAt: event.fetchedAt }; db.createTask(task);
  const run = db.listRunsForTask(task.id)[0]; if (!run) throw new Error("Fixture run was not created."); return { db, task, run, event };
}

function adapterFixture(review: ReviewPageData) {
  return { openEvent: vi.fn(async () => undefined), detectChallenge: vi.fn(async (): Promise<PageState> => "LotteryForm"), login: vi.fn(async () => undefined), enterEmailCode: vi.fn(async () => undefined), readAvailableOptions: vi.fn(async () => []), applyPreference: vi.fn(async () => undefined), readReviewPage: vi.fn(async () => review), submitApplication: vi.fn(async () => ({ url: "https://eplus.jp/receipt", receiptText: "受付番号: EP12345678" })), readReceipt: vi.fn(async () => ({ url: "https://eplus.jp/receipt", receiptText: "受付番号: EP12345678" })) };
}

function createOrchestrator(db: AppDatabase, adapter: ReturnType<typeof adapterFixture>): LotteryOrchestrator {
  const engine = { startNetworkSession: vi.fn(async () => true), reuseSession: vi.fn(async () => false), manualTakeover: vi.fn(async () => undefined), close: vi.fn(async () => undefined) };
  const network = new NetworkService({ rotate: vi.fn(async () => undefined), detectIp: vi.fn(async () => ({ ip: "1.1.1.1", country: "Japan", region: "Tokyo" })) }, { getSetting: () => undefined });
  return new LotteryOrchestrator(engine, adapter, network, db, {}, (cipher) => `decrypted-${cipher}`);
}

function digest(value: unknown): string { return createHash("sha256").update(stableJson(value)).digest("hex"); }
