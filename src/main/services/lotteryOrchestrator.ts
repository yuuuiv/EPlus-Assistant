import { createHash } from "node:crypto";
import { makeIdempotencyKey, stableJson } from "../../core/digest.js";
import type { AccountRun, DeviceProfileKey, LotteryPreference, LotteryTask, PaymentDiscoveryCheckpoint, SubmissionAuthorization, SubmissionDispatchInput, SubmissionIntent } from "../../shared/types.js";
import type { EplusBrowserAdapter, ReceiptData } from "../adapters/eplusAdapter.js";
import { BrowserEngineFailure, type BrowserSessionEngine } from "../engines/browserSessionEngine.js";
import { translateNetworkFailureReason, type NetworkService } from "./networkService.js";
import type { AppDatabase } from "../storage/database.js";
import type { EventSnapshot } from "../../shared/types.js";
import { SubmissionGuard } from "./submissionGuard.js";
import { DecisionTemplateStore } from "./decisionTemplateStore.js";

type SubmissionAdapter = Pick<EplusBrowserAdapter, "openEvent" | "detectChallenge" | "login" | "enterEmailCode" | "discoverPaymentOptions" | "applyPreference" | "readReviewPage" | "submitApplication" | "readReceipt"> & Partial<Pick<EplusBrowserAdapter, "enterSerialCode" | "selectSerialDay" | "acknowledgeInterstitial" | "discoverConsentControls" | "applyConsentSelections" | "confirmConsentChecked">>;
type SessionEngine = Pick<BrowserSessionEngine, "startNetworkSession" | "reuseSession" | "manualTakeover" | "close">;
type SessionEngineWithManualBridge = SessionEngine & Partial<Pick<BrowserSessionEngine, "isSessionActive" | "resumeManualTakeover" | "captureManualSnapshot" | "currentOwnership" | "lastNetworkFailureReason">>;
type TemplateStore = Pick<DecisionTemplateStore, "match" | "save">;
export interface MailAttributionService {
  readCode?(input: { accountId: string; startedAt: string }): Promise<{ code?: string; manualActionRequired: boolean }>;
  waitForApplicationConfirmation?(input: { accountId: string; startedAt: string; timeoutMs?: number }): Promise<{ confirmed: boolean; receivedAt?: string; reason: string }>;
}

export class LotteryOrchestrator {
  constructor(
    private readonly engine: SessionEngineWithManualBridge,
    private readonly adapter: SubmissionAdapter,
    private readonly network: NetworkService,
    private readonly db: AppDatabase,
    private readonly mailAttribution: MailAttributionService,
    private readonly decryptSecret: (cipherText: string) => string,
    private readonly submissionGuard: SubmissionGuard,
    private readonly decisionTemplates: TemplateStore = new DecisionTemplateStore(db)
  ) {}

  async resumeManualTakeover(runId: string): Promise<void> {
    const active = this.engine.isSessionActive?.() ?? false;
    if (!active) return;
    await this.tryCaptureConsentTemplate(runId);
    await this.engine.captureManualSnapshot?.();
    this.engine.resumeManualTakeover?.();
  }

  private async tryCaptureConsentTemplate(runId: string): Promise<void> {
    const run = this.db.listRuns().find((candidate) => candidate.id === runId);
    const candidates = run?.resumeCheckpoint?.consentCandidates;
    if (run?.resumeCheckpoint?.manualReason !== "checkbox-gate" || !Array.isArray(candidates) || candidates.length === 0 || !this.adapter.confirmConsentChecked) return;
    const confirmed = await this.adapter.confirmConsentChecked(candidates as { groupKey: string; domValue: string; label: string }[]);
    if (confirmed.length === candidates.length) {
      const templateKey = typeof run.resumeCheckpoint.templateKey === "string" ? run.resumeCheckpoint.templateKey : this.templateKeyFor(run);
      this.decisionTemplates.save(run.taskId, templateKey, confirmed);
    }
  }

  private templateKeyFor(run: AccountRun): string {
    return run.serialPlan?.applicationLinkId ?? run.serialPlan?.daySelection?.[0] ?? "default";
  }

  async enterVerificationCode(runId: string, code: string): Promise<void> {
    if (!code.trim()) throw new Error("验证码不能为空。");
    if (!(this.engine.isSessionActive?.() ?? false)) throw new Error("验证码会话已关闭，请重新运行该账号。");
    await this.adapter.enterEmailCode(code.trim());
  }

  createAuthorization(input: { taskId: string; runId: string; accountId: string; preference: LotteryPreference; reviewDigest: string; policy: "required" | "disabled"; acknowledgementVersion: number }): SubmissionAuthorization {
    const createdAt = new Date().toISOString();
    return { taskId: input.taskId, runId: input.runId, accountId: input.accountId, effectivePreferenceDigest: digest(input.preference), reviewDigest: input.reviewDigest, idempotencyKey: makeIdempotencyKey({ accountId: input.accountId, canonicalUrl: input.taskId, preference: input.preference }), policy: input.policy, acknowledgementVersion: input.acknowledgementVersion, checkpointVersion: 1, createdAt, expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(), consumed: false };
  }

  async runSingleAccount(input: { run: AccountRun; task: LotteryTask; event: EventSnapshot; authorization?: SubmissionAuthorization }): Promise<AccountRun> {
    if (input.authorization) this.assertAuthorization({ ...input, authorization: input.authorization });
    const prior = this.db.getSubmissionIntent(input.run.id);
    if (prior?.status === "Acknowledged") return this.requireRun(input.run.id);
    if (prior?.status === "Dispatching" || prior?.status === "Unknown" || input.run.status === "UnknownSubmissionState") throw new Error("Unknown submission state must be reconciled; it is never resubmitted.");
    // A serial-code task may intentionally submit the same event twice for
    // Day1 and Day2 (or use multiple codes). Account-level history alone is
    // not enough to suppress such a run.
    if (this.hasExistingApplication(input.run.accountId, input.event, input.run)) return this.finishAlreadyApplied(input.run);
    const deviceProfileKey = input.task.deviceProfileKey ?? "desktop-chrome";
    this.guardAction(input.task.id, input.run.id, deviceProfileKey);
    const active = this.engine.isSessionActive?.() ?? false;
    const owner = this.engine.currentOwnership?.();
    const resumingSameRun = active && owner?.runId === input.run.id;
    if (active && !resumingSameRun) await this.engine.close();
    const started = resumingSameRun || await this.engine.startNetworkSession({ accountId: input.run.accountId, runId: input.run.id, contextId: input.run.id, taskId: input.task.id, deviceProfileKey, launchGuard: () => this.guardAction(input.task.id, input.run.id, deviceProfileKey) });
    this.guardAction(input.task.id, input.run.id, deviceProfileKey);
    if (!started) return this.pause(input.run, translateNetworkFailureReason(this.engine.lastNetworkFailureReason?.()), "AwaitingManualAction", { manualReason: "network" });
    try {
      this.update(input.run, resumingSameRun ? input.run.status : "LoggingIn");
      if (!resumingSameRun) await this.guardedAction(input.task.id, input.run.id, deviceProfileKey, () => this.adapter.openEvent(this.resolveEntryUrl(input.event, input.run)));
      let challenge = await this.guardedAction(input.task.id, input.run.id, deviceProfileKey, () => this.adapter.detectChallenge());
      let verificationStartedAt = new Date().toISOString();
      if (challenge === "Login") {
        const account = this.db.getStoredAccount(input.run.accountId);
        if (!account) throw new Error("Account not found.");
        // Password decryption stays outside the orchestrator boundary.
        await this.guardedAction(input.task.id, input.run.id, deviceProfileKey, () => this.adapter.login(account.eplusEmail, this.decryptSecret(account.encryptedEplusPassword)));
        verificationStartedAt = new Date().toISOString();
        challenge = await this.guardedAction(input.task.id, input.run.id, deviceProfileKey, () => this.adapter.detectChallenge());
      }
      if (challenge === "SerialCode") {
        const serialCode = input.run.serialCode ?? input.task.preference.serialCodesByAccountId?.[input.run.accountId] ?? input.task.preference.serialCode;
        if (!serialCode?.trim()) throw new Error("当前任务需要抽选码，但该账号运行没有分配抽选码。");
        if (!this.adapter.enterSerialCode) throw new Error("当前浏览器适配器不支持抽选码提交。");
        await this.guardedAction(input.task.id, input.run.id, deviceProfileKey, () => this.adapter.enterSerialCode?.(serialCode) ?? Promise.resolve());
        challenge = await this.guardedAction(input.task.id, input.run.id, deviceProfileKey, () => this.adapter.detectChallenge());
        const selectedDay = input.run.serialPlan?.daySelection?.[0];
        if (challenge === "DaySelection" && selectedDay && this.adapter.selectSerialDay) {
          await this.guardedAction(input.task.id, input.run.id, deviceProfileKey, () => this.adapter.selectSerialDay?.(selectedDay) ?? Promise.resolve());
          challenge = await this.guardedAction(input.task.id, input.run.id, deviceProfileKey, () => this.adapter.detectChallenge());
        }
      }
      if (challenge === "Login") {
        const account = this.db.getStoredAccount(input.run.accountId);
        if (!account) throw new Error("Account not found.");
        await this.guardedAction(input.task.id, input.run.id, deviceProfileKey, () => this.adapter.login(account.eplusEmail, this.decryptSecret(account.encryptedEplusPassword)));
        verificationStartedAt = new Date().toISOString();
        challenge = await this.guardedAction(input.task.id, input.run.id, deviceProfileKey, () => this.adapter.detectChallenge());
      }
      if (challenge === "EmailCode") {
        const result = await this.mailAttribution.readCode?.({ accountId: input.run.accountId, startedAt: verificationStartedAt });
        if (!result?.code || result.manualActionRequired) return this.pause(this.requireRun(input.run.id), result?.manualActionRequired ? "验证码邮件无法安全归属，请人工确认。" : "等待读取验证码邮件。", "AwaitingEmailCode");
        await this.guardedAction(input.task.id, input.run.id, deviceProfileKey, () => this.adapter.enterEmailCode(result.code as string));
        challenge = await this.guardedAction(input.task.id, input.run.id, deviceProfileKey, () => this.adapter.detectChallenge());
      }
      if (challenge === "InterstitialConsent" && this.adapter.acknowledgeInterstitial) {
        await this.guardedAction(input.task.id, input.run.id, deviceProfileKey, () => this.adapter.acknowledgeInterstitial?.() ?? Promise.resolve());
        challenge = await this.guardedAction(input.task.id, input.run.id, deviceProfileKey, () => this.adapter.detectChallenge());
      }
      if (challenge === "CheckboxGate") {
        const outcome = await this.resolveConsentGate(input.task.id, input.run, deviceProfileKey);
        if (outcome.status === "manual") return this.pause(this.requireRun(input.run.id), "Manual browser takeover required.", "AwaitingManualAction", outcome.resumeCheckpoint);
        challenge = await this.guardedAction(input.task.id, input.run.id, deviceProfileKey, () => this.adapter.detectChallenge());
      }
      if (challenge === "CaptchaSliderDevice" || challenge === "CheckboxGate" || challenge === "Unknown") return this.pause(this.requireRun(input.run.id), "Manual browser takeover required.");
      this.update(this.requireRun(input.run.id), "FillingForm");
      if (!input.authorization) {
        const discovery = await this.guardedAction(input.task.id, input.run.id, deviceProfileKey, () => this.adapter.discoverPaymentOptions());
        const checkpoint = this.discoveryCheckpoint(input.task.id, input.run.id, input.event.pageFingerprint, deviceProfileKey, discovery.groups);
        this.submissionGuard.saveDiscovery(checkpoint);
        const templateKey = this.templateKeyFor(input.run);
        const matched = this.decisionTemplates.match(input.task.id, templateKey, checkpoint.groups);
        if (!matched) return this.pause(this.requireRun(input.run.id), "Select discovered payment options.");
        this.submissionGuard.select({ taskId: input.task.id, runId: input.run.id, checkpointId: checkpoint.checkpointId, checkpointRevision: checkpoint.checkpointRevision, candidateIds: [...matched], expectedControlFingerprint: checkpoint.controlFingerprint }, 1);
        this.db.addLog({ taskId: input.task.id, accountRunId: input.run.id, level: "info", message: "decision-template.auto-applied", metadata: { templateKey } });
      }
      this.submissionGuard.assertPersistedSelection(input.run.id, input.task.id);
      await this.guardedAction(input.task.id, input.run.id, deviceProfileKey, () => this.adapter.applyPreference(this.db.getPaymentSelections(input.run.id) ?? []));
      const review = await this.guardedAction(input.task.id, input.run.id, deviceProfileKey, () => this.adapter.readReviewPage());
      if (!this.submissionGuard.bindReview(input.run.id, input.task.id, review)) return this.requireRun(input.run.id);
      return this.pause(this.requireRun(input.run.id), "Awaiting final user confirmation.", "AwaitingSubmitConfirmation");
    } catch (error) {
      if (error instanceof BrowserEngineFailure && error.code === "ManualTakeoverRequired") return this.pause(this.requireRun(input.run.id), error.message);
      if (this.db.getSubmissionIntent(input.run.id)?.status === "Dispatching") return this.unknown(this.requireRun(input.run.id), "Submission outcome is ambiguous; reconcile read-only.");
      throw error;
    } finally {
      const current = this.db.listRuns().find((run) => run.id === input.run.id);
      if (!current || !["AwaitingManualAction", "AwaitingEmailCode", "AwaitingSubmitConfirmation"].includes(current.status)) await this.engine.close();
    }
  }

  async reconcile(input: { run: AccountRun; task: LotteryTask }): Promise<"Submitted" | "AlreadyApplied" | "Failed"> {
    const intent = this.db.getSubmissionIntent(input.run.id);
    if (intent?.receiptApplicationId) { this.db.updateSubmissionIntent(input.run.id, "Acknowledged", intent.receiptApplicationId); this.db.updateRun({ id: input.run.id, status: "Submitted", externalApplicationId: intent.receiptApplicationId }); return "Submitted"; }
    const event = this.db.getEvent(input.task.eventSnapshotId);
    if (event && this.hasExistingApplication(input.run.accountId, event, input.run)) { this.db.updateSubmissionIntent(input.run.id, "Failed"); this.db.updateRun({ id: input.run.id, status: "AlreadyApplied" }); return "AlreadyApplied"; }
    this.db.updateSubmissionIntent(input.run.id, "Failed");
    this.db.updateRun({ id: input.run.id, status: "Failed", errorDetailRedacted: "No receipt or application history found during read-only reconciliation." });
    return "Failed";
  }

  async dispatchFinal(input: SubmissionDispatchInput): Promise<AccountRun> {
    const run = this.requireRun(input.runId);
    const task = this.requireTask(input.taskId);
    if (run.taskId !== task.id) throw new Error("Submission run does not belong to task.");
    const lease = this.submissionGuard.dispatch({ ...input, contextOwnerToken: `${process.pid}:${process.uptime()}`, workerPid: process.pid, workerProcessStartTime: String(process.uptime()) });
    const authorization = this.db.getSubmissionAuthorization(run.id);
    if (!authorization) throw new Error("Submission authorization is missing.");
    const intent: SubmissionIntent = { taskId: task.id, runId: run.id, status: "Prepared", idempotencyKey: authorization.idempotencyKey, preferenceDigest: authorization.effectivePreferenceDigest, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    this.db.saveSubmissionIntent(intent);
    this.db.updateSubmissionIntent(run.id, "Dispatching");
    try {
      this.submissionGuard.assertLiveLease({ runId: run.id, lease });
      const completionStartedAt = new Date().toISOString();
      const receipt = await this.adapter.submitApplication(() => { this.submissionGuard.assertLiveLease({ runId: run.id, lease }); });
      this.submissionGuard.assertLiveLease({ runId: run.id, lease });
      const applicationId = extractReceiptId(receipt.receiptText);
      if (!applicationId) return this.unknown(this.requireRun(run.id), "Receipt lacks a verifiable application number.");
      const confirmation = await this.mailAttribution.waitForApplicationConfirmation?.({ accountId: run.accountId, startedAt: completionStartedAt });
      if (this.mailAttribution.waitForApplicationConfirmation && !confirmation?.confirmed) {
        this.submissionGuard.recover(run.id);
        this.db.updateRun({
          id: run.id,
          status: "AwaitingCompletionEmail",
          paymentState: "Submitting",
          externalApplicationId: applicationId,
          resumeCheckpoint: { receiptUrl: receipt.url, receiptApplicationId: applicationId, completionStartedAt },
          errorDetailRedacted: confirmation?.reason ?? "等待 info@eplus.co.jp 的申请完成邮件。"
        });
        return this.requireRun(run.id);
      }
      return this.acknowledge(this.requireRun(run.id), receipt);
    } catch (error) {
      this.submissionGuard.recover(run.id);
      throw error;
    }
  }

  async retryEmailCode(runId: string): Promise<AccountRun> {
    const run = this.requireRun(runId);
    if (run.status !== "AwaitingEmailCode") throw new Error("该运行当前不在等待邮箱验证码状态。");
    const result = await this.mailAttribution.readCode?.({ accountId: run.accountId, startedAt: run.updatedAt });
    if (!result?.code || result.manualActionRequired) {
      this.db.updateRun({ id: run.id, status: "AwaitingEmailCode", errorDetailRedacted: result?.manualActionRequired ? "验证码邮件无法安全归属，程序未填写。" : "仍未收到符合时间和账号来源的验证码邮件。" });
      return this.requireRun(run.id);
    }
    await this.adapter.enterEmailCode(result.code);
    const state = await this.adapter.detectChallenge();
    if (state === "EmailCode") return this.requireRun(run.id);
    this.db.updateRun({ id: run.id, status: "LoggingIn", errorDetailRedacted: undefined });
    return this.requireRun(run.id);
  }

  async awaitCompletionEmail(runId: string): Promise<AccountRun> {
    const run = this.requireRun(runId);
    if (run.status !== "AwaitingCompletionEmail") throw new Error("该运行当前不在等待抽选完成邮件状态。");
    const startedAt = typeof run.resumeCheckpoint.completionStartedAt === "string" ? run.resumeCheckpoint.completionStartedAt : run.updatedAt;
    const confirmation = await this.mailAttribution.waitForApplicationConfirmation?.({ accountId: run.accountId, startedAt });
    if (!confirmation?.confirmed) {
      this.db.updateRun({ id: run.id, status: "AwaitingCompletionEmail", paymentState: "Submitting", errorDetailRedacted: confirmation?.reason ?? "仍未收到符合条件的申请完成邮件。" });
      return this.requireRun(run.id);
    }
    const applicationId = run.externalApplicationId ?? (typeof run.resumeCheckpoint.receiptApplicationId === "string" ? run.resumeCheckpoint.receiptApplicationId : undefined);
    if (!applicationId) return this.unknown(run, "申请完成邮件已收到，但缺少可核验的申请编号。");
    this.db.updateSubmissionIntent(run.id, "Acknowledged", applicationId);
    this.db.updateRun({ id: run.id, status: "Submitted", externalApplicationId: applicationId, resumeCheckpoint: { ...run.resumeCheckpoint, completionMailConfirmedAt: confirmation.receivedAt ?? new Date().toISOString() } });
    return this.requireRun(run.id);
  }

  recoverSubmittingRun(runId: string): void {
    this.submissionGuard.recover(runId);
  }

  private resolveEntryUrl(event: EventSnapshot, run: AccountRun): string {
    const linkId = run.serialPlan?.applicationLinkId;
    const link = linkId ? event.rawFormSchema.applicationLinks.find((candidate) => candidate.id === linkId) : undefined;
    return link?.href ?? event.canonicalUrl;
  }

  private async resolveConsentGate(taskId: string, run: AccountRun, deviceProfileKey: DeviceProfileKey): Promise<{ status: "resolved" } | { status: "manual"; resumeCheckpoint: Record<string, unknown> }> {
    if (!this.adapter.discoverConsentControls || !this.adapter.applyConsentSelections) return { status: "manual", resumeCheckpoint: {} };
    const templateKey = `consent:${this.templateKeyFor(run)}`;
    const groups = await this.guardedAction(taskId, run.id, deviceProfileKey, () => this.adapter.discoverConsentControls!());
    const candidates = groups.map((group) => ({ groupKey: group.groupKey, domValue: group.options[0]?.domValue ?? "", label: group.options[0]?.label ?? "" }));
    const matched = groups.length > 0 ? this.decisionTemplates.match(taskId, templateKey, groups) : undefined;
    if (matched && matched.length === groups.length) {
      await this.guardedAction(taskId, run.id, deviceProfileKey, () => this.adapter.applyConsentSelections!(matched));
      this.db.addLog({ taskId, accountRunId: run.id, level: "info", message: "decision-template.auto-applied", metadata: { templateKey } });
      return { status: "resolved" };
    }
    return { status: "manual", resumeCheckpoint: { manualReason: "checkbox-gate", templateKey, consentCandidates: candidates } };
  }

  private guardAction(taskId: string, runId: string, deviceProfileKey: DeviceProfileKey): void { this.submissionGuard.assertActionAllowed({ taskId, runId, deviceProfileKey }); }
  private async guardedAction<T>(taskId: string, runId: string, deviceProfileKey: DeviceProfileKey, action: () => Promise<T>): Promise<T> { this.guardAction(taskId, runId, deviceProfileKey); const result = await action(); this.guardAction(taskId, runId, deviceProfileKey); return result; }
  private discoveryCheckpoint(taskId: string, runId: string, pageFingerprint: string, deviceProfileKey: DeviceProfileKey, groups: readonly PaymentDiscoveryCheckpoint["groups"][number][]): PaymentDiscoveryCheckpoint {
    const boundGroups = groups.map((group) => ({
      ...group,
      selectorEvidence: { ...group.selectorEvidence, contextGeneration: runId },
      options: group.options.map((option) => ({ ...option, selectorEvidence: { ...option.selectorEvidence, contextGeneration: runId } }))
    }));
    const candidates = boundGroups.flatMap((group) => group.options).filter((option) => option.enabled && option.supported && !option.ambiguous);
    const controlFingerprint = createHash("sha256").update(stableJson(boundGroups)).digest("hex");
    return { taskId, runId, checkpointId: `${runId}-payment-1`, checkpointRevision: 1, pageFingerprint, controlFingerprint, contextGeneration: runId, deviceProfileKey, discoveredAt: new Date().toISOString(), candidateIds: candidates.map((option) => option.candidateId), groupKeys: Object.fromEntries(boundGroups.map((group) => [group.groupKey, group.options.filter((option) => option.enabled && option.supported && !option.ambiguous).map((option) => option.candidateId)])), groups: boundGroups };
  }
  private assertAuthorization(input: { run: AccountRun; task: LotteryTask; authorization: SubmissionAuthorization }): void { const authorization = input.authorization; if (authorization.taskId !== input.task.id || authorization.runId !== input.run.id || authorization.accountId !== input.run.accountId) throw new Error("Submission authorization does not match this run."); if (authorization.consumed || Date.parse(authorization.expiresAt) <= Date.now()) throw new Error("Submission authorization is expired or consumed."); const saved = this.db.getSubmissionAuthorization(input.run.id); if (!saved || saved.idempotencyKey !== authorization.idempotencyKey || saved.consumed) throw new Error("Submission authorization was not issued for this run or was consumed."); }
  private hasExistingApplication(accountId: string, event: EventSnapshot, run?: AccountRun): boolean { if (run?.serialCode || run?.serialPlan) return false; return this.db.listApplicationRecords(accountId).some((record) => record.eventTitle === event.title); }
  private acknowledge(run: AccountRun, receipt: ReceiptData): AccountRun { const applicationId = extractReceiptId(receipt.receiptText); if (!applicationId) return this.unknown(run, "Receipt lacks a verifiable application number."); this.db.updateSubmissionIntent(run.id, "Acknowledged", applicationId); this.db.updateRun({ id: run.id, status: "Submitted", externalApplicationId: applicationId, resumeCheckpoint: { receiptUrl: receipt.url, receiptVerified: true } }); return this.requireRun(run.id); }
  private finishAlreadyApplied(run: AccountRun): AccountRun { this.db.updateRun({ id: run.id, status: "AlreadyApplied", errorDetailRedacted: "Existing application history found." }); return this.requireRun(run.id); }
  private unknown(run: AccountRun, note: string): AccountRun { this.db.updateSubmissionIntent(run.id, "Unknown"); this.db.updateRun({ id: run.id, status: "UnknownSubmissionState", errorDetailRedacted: note }); return this.requireRun(run.id); }
  private pause(run: AccountRun, note: string, status: "AwaitingManualAction" | "AwaitingEmailCode" | "AwaitingSubmitConfirmation" = "AwaitingManualAction", resumeCheckpoint: Record<string, unknown> = {}): AccountRun { this.db.updateRun({ id: run.id, status, errorDetailRedacted: note, resumeCheckpoint }); return this.requireRun(run.id); }
  private update(run: AccountRun, status: AccountRun["status"]): void { this.db.updateRun({ id: run.id, status }); }
  private requireRun(runId: string): AccountRun { const run = this.db.listRuns().find((candidate) => candidate.id === runId); if (!run) throw new Error("Account run not found."); return run; }
  private requireTask(taskId: string): LotteryTask { const task = this.db.listTasks().find((candidate) => candidate.id === taskId); if (!task) throw new Error("Lottery task not found."); return task; }
}

export function recoverSubmittingRuns(db: AppDatabase, submissionGuard: SubmissionGuard): number {
  const submittingRuns = db.listRuns().filter((run) => run.status === "Submitting");
  for (const run of submittingRuns) submissionGuard.recover(run.id);
  return submittingRuns.length;
}

function digest(value: unknown): string { return createHash("sha256").update(stableJson(value)).digest("hex"); }
function extractReceiptId(text: string): string | undefined { return text.match(/(?:受付番号|application\s*number)\s*[:：]?\s*([A-Za-z0-9-]{6,})/iu)?.[1]; }
