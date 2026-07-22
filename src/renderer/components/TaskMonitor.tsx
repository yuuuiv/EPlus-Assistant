import { AlertTriangle, CheckCircle2, CirclePause, Play, RefreshCw, ShieldCheck, XCircle } from "lucide-react";
import { useState } from "react";
import type { Account, AccountRun, DashboardState, PaymentSelectionInput } from "../../shared/ipc.js";
import type { LotteryTask, PaymentDiscoveryCheckpoint, PaymentOptionGroup, RuntimePaymentOption } from "../../shared/types.js";
import { ProgressBar, type ProgressTone } from "./ProgressBar.js";
import { deviceProfileLabel } from "./TaskCreation.js";

const statusText: Record<string, string> = { Pending: "待处理", Queued: "已排队", LoggingIn: "正在登录", FillingForm: "正在填写", AwaitingConfirmation: "等待确认", AwaitingEmailCode: "等待验证码", AwaitingCompletionEmail: "等待申请完成邮件", AwaitingManualAction: "等待人工接管", UnknownSubmissionState: "提交状态未知", AwaitingSubmitConfirmation: "等待最终确认", Submitting: "正在提交", Running: "运行中", Paused: "已暂停", Submitted: "已提交", Completed: "已完成", Failed: "失败", Cancelled: "已取消" };
const statusTone: Record<string, string> = { Pending: "gray", Queued: "blue", LoggingIn: "blue", FillingForm: "blue", AwaitingConfirmation: "yellow", AwaitingEmailCode: "yellow", AwaitingCompletionEmail: "yellow", AwaitingManualAction: "yellow", UnknownSubmissionState: "yellow", AwaitingSubmitConfirmation: "yellow", Submitting: "teal", Running: "teal", Paused: "yellow", Submitted: "green", Completed: "green", Failed: "red", Cancelled: "gray" };

// Ordered pipeline used only to derive a rough "how far along" percentage for the progress bar.
const runStageOrder = ["Pending", "Queued", "LoggingIn", "FillingForm", "AwaitingConfirmation", "AwaitingEmailCode", "AwaitingManualAction", "UnknownSubmissionState", "AwaitingSubmitConfirmation", "Submitting"] as const;
const runActiveStages = new Set(["LoggingIn", "FillingForm", "Submitting"]);
const runWaitingStages = new Set(["AwaitingConfirmation", "AwaitingEmailCode", "AwaitingCompletionEmail", "AwaitingManualAction", "UnknownSubmissionState", "AwaitingSubmitConfirmation"]);

interface RunProgressMeta { readonly value: number | undefined; readonly tone: ProgressTone; }

function runProgressMeta(status: string): RunProgressMeta {
  if (status === "Submitted" || status === "Completed") return { value: 100, tone: "success" };
  if (status === "Failed") return { value: 100, tone: "danger" };
  if (status === "Cancelled") return { value: 100, tone: "neutral" };
  if (runActiveStages.has(status)) return { value: undefined, tone: "primary" };
  const stageIndex = runStageOrder.indexOf(status as (typeof runStageOrder)[number]);
  const value = stageIndex === -1 ? 8 : Math.round((stageIndex / (runStageOrder.length - 1)) * 100);
  return { value, tone: runWaitingStages.has(status) ? "warning" : "primary" };
}

function taskProgressMeta(runs: readonly AccountRun[]): RunProgressMeta {
  if (runs.length === 0) return { value: 0, tone: "primary" };
  const failed = runs.some((run) => run.status === "Failed");
  const settled = runs.filter((run) => ["Submitted", "Completed", "Failed", "Cancelled"].includes(run.status)).length;
  return { value: Math.round((settled / runs.length) * 100), tone: failed ? "danger" : settled === runs.length ? "success" : "primary" };
}

export type RunControlMode = "payment-selection" | "final-confirm" | "completion-email" | "reconcile" | "manual-takeover" | "none";

export function runControlMode(run: AccountRun): RunControlMode {
  if (run.status === "AwaitingManualAction" && run.paymentState === "PaymentSelectionPending" && run.paymentCheckpoint !== undefined) return "payment-selection";
  if (run.status === "AwaitingSubmitConfirmation") return "final-confirm";
  if (run.status === "AwaitingCompletionEmail") return "completion-email";
  if (run.status === "UnknownSubmissionState") return "reconcile";
  if (run.status === "AwaitingManualAction") return "manual-takeover";
  return "none";
}

export function selectableCandidateGroups(checkpoint: PaymentDiscoveryCheckpoint): PaymentOptionGroup[] {
  return checkpoint.groups.filter((group) => group.options.some(isSelectableOption));
}

export function isSelectableOption(option: RuntimePaymentOption): boolean {
  return option.enabled && option.supported && !option.ambiguous;
}

export function paymentSelectionPayload(checkpoint: PaymentDiscoveryCheckpoint, choicesByGroup: Record<string, string>): PaymentSelectionInput {
  const candidateIds = selectableCandidateGroups(checkpoint)
    .map((group) => choicesByGroup[group.groupKey])
    .filter((candidateId): candidateId is string => typeof candidateId === "string" && candidateId.length > 0);
  return {
    taskId: checkpoint.taskId,
    runId: checkpoint.runId,
    checkpointId: checkpoint.checkpointId,
    checkpointRevision: checkpoint.checkpointRevision,
    candidateIds,
    expectedControlFingerprint: checkpoint.controlFingerprint
  };
}

function unavailableReason(option: RuntimePaymentOption): string {
  if (!option.enabled) return "不可用";
  if (option.ambiguous) return "存在歧义";
  if (!option.supported) return "不支持";
  return "";
}

interface TaskMonitorProps {
  readonly state: DashboardState;
  readonly onEnqueue: (taskId: string) => void;
  readonly onPause: () => void;
  readonly onResume: () => void;
  readonly onCancelTask: (taskId: string) => void;
  readonly onCancelRun: (runId: string) => void;
  readonly onManualAction: (run: AccountRun, action: "continue" | "cancel-account" | "cancel-task" | "reconcile-unknown", verificationCode?: string) => void;
  readonly onSelectPayment: (input: PaymentSelectionInput) => void;
  readonly onConfirmSubmit: (taskId: string, runId: string) => void;
  readonly onAwaitCompletionEmail: (runId: string) => void;
  readonly onRetryEmailCode: (runId: string) => void;
}

function StatusBadge({ status }: { readonly status: string }) {
  return <span className={`badge badge-${statusTone[status] ?? "gray"}`}>{statusText[status] ?? status}</span>;
}

function DeviceProfileBadge({ task }: { readonly task: LotteryTask | undefined }) {
  return <span className="badge badge-blue" title="本任务运行使用的设备档案，创建后不可更改">设备档案：{deviceProfileLabel(task?.deviceProfileKey)}</span>;
}

function PaymentSelectionCard(props: { readonly run: AccountRun; readonly task: LotteryTask | undefined; readonly accountName: string; readonly onSelectPayment: (input: PaymentSelectionInput) => void; readonly onCancelRun: (runId: string) => void }) {
  const checkpoint = props.run.paymentCheckpoint;
  const [choices, setChoices] = useState<Record<string, string>>({});
  if (!checkpoint) return null;
  const groups = selectableCandidateGroups(checkpoint);
  const canSubmit = groups.length > 0 && groups.every((group) => Boolean(choices[group.groupKey]));
  const submit = () => props.onSelectPayment(paymentSelectionPayload(checkpoint, choices));
  return (
    <article className="takeover-row">
      <div>
        <strong>{props.accountName}</strong>
        <span>已在浏览器中发现付款方式，请选择候选项后继续</span>
        <div className="item-meta">
          <DeviceProfileBadge task={props.task} />
          <span className="muted">校验指纹 {checkpoint.controlFingerprint.slice(0, 12)}…</span>
        </div>
        {checkpoint.groups.map((group) => (
          <div key={group.groupKey} className="stack" role="radiogroup" aria-label={`付款分组 ${group.groupKey}`}>
            <p className="muted">付款分组：{group.groupKey}</p>
            {group.options.map((option) => {
              const selectable = isSelectableOption(option);
              return (
                <label key={option.candidateId} className="check-row">
                  <input type="radio" name={`${props.run.id}:${group.groupKey}`} value={option.candidateId} disabled={!selectable} checked={choices[group.groupKey] === option.candidateId} onChange={() => setChoices((current) => ({ ...current, [group.groupKey]: option.candidateId }))} />
                  {option.label}
                  {selectable ? null : <span className="badge badge-gray">{unavailableReason(option)}</span>}
                </label>
              );
            })}
          </div>
        ))}
      </div>
      <div className="row-actions">
        <button type="button" className="primary" disabled={!canSubmit} onClick={submit}><CheckCircle2 size={15} />提交所选付款</button>
        <button type="button" className="icon-button danger" onClick={() => props.onCancelRun(props.run.id)}><XCircle size={15} />取消运行</button>
      </div>
    </article>
  );
}

function ManualTakeoverCard(props: { readonly run: AccountRun; readonly accountName: string; readonly onManualAction: TaskMonitorProps["onManualAction"]; readonly onCancelRun: (runId: string) => void; readonly onCancelTask: (taskId: string) => void }) {
  const [verificationCode, setVerificationCode] = useState("");
  const needsCode = props.run.status === "AwaitingEmailCode";
  return <article className="takeover-row"><div><strong>{props.accountName}</strong><span>{needsCode ? "验证码已发送，浏览器窗口保持打开" : "需要在真实浏览器中人工处理"}</span><p>{props.run.errorDetailRedacted || "请在已自动打开的浏览器中完成验证码、滑块或设备验证。完成后回到这里继续。"}</p>{needsCode ? <label>验证码<input inputMode="numeric" autoComplete="one-time-code" value={verificationCode} onChange={(event) => setVerificationCode(event.target.value)} placeholder="输入 4–8 位验证码" /></label> : null}</div><div className="row-actions"><button type="button" className="primary" disabled={needsCode && verificationCode.trim().length < 4} onClick={() => props.onManualAction(props.run, "continue", verificationCode)}><Play size={15} />{needsCode ? "填入验证码并继续" : "已处理，继续"}</button><button type="button" className="icon-button danger" onClick={() => props.onCancelRun(props.run.id)}><XCircle size={15} />取消运行</button><button type="button" className="icon-button danger" onClick={() => props.onCancelTask(props.run.taskId)}><AlertTriangle size={15} />取消任务</button></div></article>;
}

function DecisionCenter(props: TaskMonitorProps) {
  const accountName = (accountId: string) => { const account = props.state.accounts.find((item) => item.id === accountId); return account?.label || account?.eplusEmail || accountId; };
  const taskFor = (run: AccountRun) => props.state.tasks.find((task) => task.id === run.taskId);
  const paymentRuns = props.state.runs.filter((run) => runControlMode(run) === "payment-selection");
  const confirmRuns = props.state.runs.filter((run) => runControlMode(run) === "final-confirm");
  const completionRuns = props.state.runs.filter((run) => runControlMode(run) === "completion-email");
  const manualRuns = props.state.runs.filter((run) => runControlMode(run) === "manual-takeover");
  const unknownRuns = props.state.runs.filter((run) => runControlMode(run) === "reconcile");
  if (paymentRuns.length + confirmRuns.length + completionRuns.length + manualRuns.length + unknownRuns.length === 0) return null;
  return (
    <section className="panel-card manual-takeover" aria-label="待处理决策">
      <div className="panel-head"><h2><CirclePause size={16} />待处理决策</h2><span className="badge badge-yellow">需要处理</span></div>
      <div className="stack">
        {paymentRuns.map((run) => <PaymentSelectionCard key={run.id} run={run} task={taskFor(run)} accountName={accountName(run.accountId)} onSelectPayment={props.onSelectPayment} onCancelRun={props.onCancelRun} />)}
        {confirmRuns.map((run) => (
          <article key={run.id} className="takeover-row">
            <div>
              <strong>{accountName(run.accountId)}</strong>
              <span>已完成付款选择与复核，等待最终确认提交</span>
              <p>{run.errorDetailRedacted || "确认后将提交本次抽选申请。此为唯一的提交入口。"}</p>
              <div className="item-meta"><DeviceProfileBadge task={taskFor(run)} /></div>
            </div>
            <div className="row-actions">
              <button type="button" className="primary" onClick={() => props.onConfirmSubmit(run.taskId, run.id)}><ShieldCheck size={15} />确认并提交</button>
              <button type="button" className="icon-button danger" onClick={() => props.onCancelRun(run.id)}><XCircle size={15} />取消运行</button>
            </div>
          </article>
        ))}
        {completionRuns.map((run) => <article key={run.id} className="takeover-row"><div><strong>{accountName(run.accountId)}</strong><span>已提交，等待严格匹配的申请完成邮件</span><p>{run.errorDetailRedacted || "只接受当前账号转发来源、发件人 info@eplus.co.jp 且正文符合申请完成模板的邮件。"}</p></div><div className="row-actions"><button type="button" className="primary" onClick={() => props.onAwaitCompletionEmail(run.id)}><Play size={15} />继续等待邮件</button><button type="button" className="icon-button danger" onClick={() => props.onCancelRun(run.id)}><XCircle size={15} />取消运行</button></div></article>)}
        {manualRuns.map((run) => <ManualTakeoverCard key={run.id} run={run} accountName={accountName(run.accountId)} onManualAction={props.onManualAction} onCancelRun={props.onCancelRun} onCancelTask={props.onCancelTask} />)}
        {unknownRuns.map((run) => (
          <article key={run.id} className="takeover-row">
            <div>
              <strong>{accountName(run.accountId)}</strong>
              <span>提交状态未知</span>
              <p>{run.errorDetailRedacted || "提交状态不明确，请只读查证，切勿再次提交。"}</p>
            </div>
            <div className="row-actions">
              <button type="button" className="icon-button" onClick={() => props.onManualAction(run, "reconcile-unknown")}><CheckCircle2 size={15} />查证提交状态</button>
              <button type="button" className="icon-button danger" onClick={() => props.onCancelRun(run.id)}><XCircle size={15} />取消运行</button>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}

export function TaskMonitor(props: TaskMonitorProps) {
  return (
    <section className="workspace-panel" aria-labelledby="monitor-title">
      <div className="workspace-heading">
        <div>
          <p className="section-kicker">演出与任务</p>
          <h1 id="monitor-title">任务监控</h1>
          <p>保守处理队列、运行状态和人工决策。付款方式在运行时发现后由此选择，未知提交状态不会自动重试。</p>
        </div>
        <div className="cluster">
          <button className="icon-button" onClick={props.onPause}><CirclePause size={16} />暂停队列</button>
          <button className="icon-button" onClick={props.onResume}><Play size={16} />恢复队列</button>
        </div>
      </div>
      <DecisionCenter {...props} />
      <section className="panel-card">
        <div className="panel-head"><h2>任务与运行</h2><span className="muted">{props.state.tasks.length} 个任务</span></div>
        <div className="stack">
          {props.state.tasks.map((task) => {
            const event = props.state.events.find((item) => item.id === task.eventSnapshotId);
            const runs = props.state.runs.filter((item) => item.taskId === task.id);
            const taskProgress = taskProgressMeta(runs);
            return (
              <article key={task.id} className="item-block">
                <div className="item-head">
                  <div>
                    <strong>{event?.title ?? "未找到演出快照"}</strong>
                    <div className="item-meta">
                      <StatusBadge status={task.status} />
                      <DeviceProfileBadge task={task} />
                      <span className="muted">{task.accountIds.length} 个账号</span>
                    </div>
                  </div>
                  <div className="row-actions">
                    {task.status === "AwaitingConfirmation" ? <button className="icon-button" onClick={() => props.onEnqueue(task.id)}><Play size={15} />加入队列</button> : null}
                    <button className="icon-button danger" onClick={() => props.onCancelTask(task.id)}><XCircle size={15} />取消任务</button>
                  </div>
                </div>
                <ProgressBar value={taskProgress.value} tone={taskProgress.tone} label={`任务完成度 ${taskProgress.value ?? 0}%`} />
                <div className="runs">
                  {runs.map((run) => {
                    const progress = runProgressMeta(run.status);
                    return (
                      <div key={run.id} className="run-row">
                        <span>{props.state.accounts.find((account) => account.id === run.accountId)?.label || run.accountId}</span>
                        <StatusBadge status={run.status} />
                        {run.status === "AwaitingEmailCode" ? <button className="icon-button" onClick={() => props.onRetryEmailCode(run.id)}><RefreshCw size={15} />自动重读验证码</button> : null}
                        <button className="icon-button danger" onClick={() => props.onCancelRun(run.id)} title="取消该账号运行"><XCircle size={15} />取消运行</button>
                        <div className="run-progress"><ProgressBar value={progress.value} tone={progress.tone} compact label={`运行状态 ${statusText[run.status] ?? run.status}`} /></div>
                      </div>
                    );
                  })}
                </div>
              </article>
            );
          })}
        </div>
        {props.state.tasks.length === 0 ? <p className="empty-state">尚未创建任务。请在“创建任务”中开始配置。</p> : null}
      </section>
    </section>
  );
}
