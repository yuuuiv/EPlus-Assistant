import { createHash } from "node:crypto";
import { makeIdempotencyKey, stableJson } from "../../core/digest.js";
import type { AccountRun, LotteryPreference, LotteryTask, SubmissionAuthorization, SubmissionIntent } from "../../shared/types.js";
import type { EplusBrowserAdapter, ReceiptData } from "../adapters/eplusAdapter.js";
import { BrowserEngineFailure, type BrowserSessionEngine } from "../engines/browserSessionEngine.js";
import type { NetworkService } from "./networkService.js";
import type { AppDatabase } from "../storage/database.js";
import type { EventSnapshot } from "../../shared/types.js";

type SubmissionAdapter = Pick<EplusBrowserAdapter, "openEvent" | "detectChallenge" | "login" | "enterEmailCode" | "readAvailableOptions" | "applyPreference" | "readReviewPage" | "submitApplication" | "readReceipt">;
type SessionEngine = Pick<BrowserSessionEngine, "startNetworkSession" | "reuseSession" | "manualTakeover" | "close">;
export interface MailAttributionService {
  readCode?(input: { accountId: string; startedAt: string }): Promise<{ code?: string; manualActionRequired: boolean }>;
}

export class LotteryOrchestrator {
  constructor(
    private readonly engine: SessionEngine,
    private readonly adapter: SubmissionAdapter,
    private readonly network: NetworkService,
    private readonly db: AppDatabase,
    private readonly mailAttribution: MailAttributionService
  ) {}

  createAuthorization(input: { taskId: string; runId: string; accountId: string; preference: LotteryPreference; reviewDigest: string; policy: "required" | "disabled"; acknowledgementVersion: number }): SubmissionAuthorization {
    const createdAt = new Date().toISOString();
    return { taskId: input.taskId, runId: input.runId, accountId: input.accountId, effectivePreferenceDigest: digest(input.preference), reviewDigest: input.reviewDigest, idempotencyKey: makeIdempotencyKey({ accountId: input.accountId, canonicalUrl: input.taskId, preference: input.preference }), policy: input.policy, acknowledgementVersion: input.acknowledgementVersion, checkpointVersion: 1, createdAt, expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(), consumed: false };
  }

  async runSingleAccount(input: { run: AccountRun; task: LotteryTask; event: EventSnapshot; policy: "required" | "disabled"; authorization: SubmissionAuthorization }): Promise<AccountRun> {
    this.assertAuthorization(input);
    const prior = this.db.getSubmissionIntent(input.run.id);
    if (prior?.status === "Acknowledged") return this.requireRun(input.run.id);
    if (prior?.status === "Dispatching" || prior?.status === "Unknown" || input.run.status === "UnknownSubmissionState") throw new Error("Unknown submission state must be reconciled; it is never resubmitted.");
    if (this.hasExistingApplication(input.run.accountId, input.event)) return this.finishAlreadyApplied(input.run);
    const started = await this.engine.startNetworkSession({ accountId: input.run.accountId, runId: input.run.id, contextId: input.run.id });
    if (!started) return this.pause(input.run, "Network lease requires manual takeover.");
    try {
      this.update(input.run, "LoggingIn");
      await this.adapter.openEvent(input.event.canonicalUrl);
      let challenge = await this.adapter.detectChallenge();
      if (challenge === "Login") {
        const account = this.db.getStoredAccount(input.run.accountId);
        if (!account) throw new Error("Account not found.");
        // Password decryption stays outside the orchestrator boundary.
        await this.adapter.login(account.eplusEmail, account.encryptedEplusPassword);
        challenge = await this.adapter.detectChallenge();
      }
      if (challenge === "EmailCode") return this.pause(this.requireRun(input.run.id), "Verification code requires manual attribution.");
      if (challenge === "CaptchaSliderDevice" || challenge === "CheckboxGate" || challenge === "Unknown") return this.pause(this.requireRun(input.run.id), "Manual browser takeover required.");
      this.update(this.requireRun(input.run.id), "FillingForm");
      await this.adapter.readAvailableOptions();
      await this.adapter.applyPreference(this.effectivePreference(input.task.preference, input.run.accountId));
      const review = await this.adapter.readReviewPage();
      if (digest(review) !== input.authorization.reviewDigest) return this.pause(this.requireRun(input.run.id), "Review payload changed; submission blocked.");
      if (input.policy === "required") return this.pause(this.requireRun(input.run.id), "Awaiting final user confirmation.", "AwaitingSubmitConfirmation");
      const intent: SubmissionIntent = { taskId: input.task.id, runId: input.run.id, status: "Prepared", idempotencyKey: input.authorization.idempotencyKey, preferenceDigest: input.authorization.effectivePreferenceDigest, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
      this.db.saveSubmissionIntent(intent);
      if (!this.db.consumeSubmissionAuthorization(input.run.id)) throw new Error("Submission authorization is expired or already consumed.");
      this.db.updateSubmissionIntent(input.run.id, "Dispatching");
      this.update(this.requireRun(input.run.id), "Submitting");
      const receipt = await this.adapter.submitApplication();
      return this.acknowledge(this.requireRun(input.run.id), receipt);
    } catch (error) {
      if (error instanceof BrowserEngineFailure && error.code === "ManualTakeoverRequired") return this.pause(this.requireRun(input.run.id), error.message);
      if (this.db.getSubmissionIntent(input.run.id)?.status === "Dispatching") return this.unknown(this.requireRun(input.run.id), "Submission outcome is ambiguous; reconcile read-only.");
      throw error;
    } finally { await this.engine.close(); }
  }

  async reconcile(input: { run: AccountRun; task: LotteryTask }): Promise<"Submitted" | "AlreadyApplied" | "Failed"> {
    const intent = this.db.getSubmissionIntent(input.run.id);
    if (intent?.receiptApplicationId) { this.db.updateSubmissionIntent(input.run.id, "Acknowledged", intent.receiptApplicationId); this.db.updateRun({ id: input.run.id, status: "Submitted", externalApplicationId: intent.receiptApplicationId }); return "Submitted"; }
    const event = this.db.getEvent(input.task.eventSnapshotId);
    if (event && this.hasExistingApplication(input.run.accountId, event)) { this.db.updateSubmissionIntent(input.run.id, "Failed"); this.db.updateRun({ id: input.run.id, status: "AlreadyApplied" }); return "AlreadyApplied"; }
    this.db.updateSubmissionIntent(input.run.id, "Failed");
    this.db.updateRun({ id: input.run.id, status: "Failed", errorDetailRedacted: "No receipt or application history found during read-only reconciliation." });
    return "Failed";
  }

  private effectivePreference(preference: LotteryPreference, accountId: string): LotteryPreference { return { ...preference, serialCode: preference.serialCodesByAccountId?.[accountId] ?? preference.serialCode, daySelectionByAccountId: preference.daySelectionByAccountId ? { [accountId]: preference.daySelectionByAccountId[accountId] ?? [] } : undefined }; }
  private assertAuthorization(input: { run: AccountRun; task: LotteryTask; authorization: SubmissionAuthorization }): void { const authorization = input.authorization; if (authorization.taskId !== input.task.id || authorization.runId !== input.run.id || authorization.accountId !== input.run.accountId) throw new Error("Submission authorization does not match this run."); if (authorization.consumed || Date.parse(authorization.expiresAt) <= Date.now()) throw new Error("Submission authorization is expired or consumed."); const saved = this.db.getSubmissionAuthorization(input.run.id); if (!saved || saved.idempotencyKey !== authorization.idempotencyKey || saved.consumed) throw new Error("Submission authorization was not issued for this run or was consumed."); }
  private hasExistingApplication(accountId: string, event: EventSnapshot): boolean { return this.db.listApplicationRecords(accountId).some((record) => record.eventTitle === event.title); }
  private acknowledge(run: AccountRun, receipt: ReceiptData): AccountRun { const applicationId = extractReceiptId(receipt.receiptText); if (!applicationId) return this.unknown(run, "Receipt lacks a verifiable application number."); this.db.updateSubmissionIntent(run.id, "Acknowledged", applicationId); this.db.updateRun({ id: run.id, status: "Submitted", externalApplicationId: applicationId, resumeCheckpoint: { receiptUrl: receipt.url, receiptVerified: true } }); return this.requireRun(run.id); }
  private finishAlreadyApplied(run: AccountRun): AccountRun { this.db.updateRun({ id: run.id, status: "AlreadyApplied", errorDetailRedacted: "Existing application history found." }); return this.requireRun(run.id); }
  private unknown(run: AccountRun, note: string): AccountRun { this.db.updateSubmissionIntent(run.id, "Unknown"); this.db.updateRun({ id: run.id, status: "UnknownSubmissionState", errorDetailRedacted: note }); return this.requireRun(run.id); }
  private pause(run: AccountRun, note: string, status: "AwaitingManualAction" | "AwaitingSubmitConfirmation" = "AwaitingManualAction"): AccountRun { this.db.updateRun({ id: run.id, status, errorDetailRedacted: note }); return this.requireRun(run.id); }
  private update(run: AccountRun, status: AccountRun["status"]): void { this.db.updateRun({ id: run.id, status }); }
  private requireRun(runId: string): AccountRun { const run = this.db.listRuns().find((candidate) => candidate.id === runId); if (!run) throw new Error("Account run not found."); return run; }
}

function digest(value: unknown): string { return createHash("sha256").update(stableJson(value)).digest("hex"); }
function extractReceiptId(text: string): string | undefined { return text.match(/(?:受付番号|application\s*number)\s*[:：]?\s*([A-Za-z0-9-]{6,})/iu)?.[1]; }
