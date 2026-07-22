import { ListTodo, MonitorSmartphone } from "lucide-react";
import type { Account, CreateTaskInputV2, EventOption, EventSnapshot, LotteryPreference } from "../../shared/ipc.js";
import type { DeviceProfileKey } from "../../shared/types.js";
import { PerAccountReview, PreviewDigest, TaskPolicyControls, type TaskDraft } from "./TaskWorkflow.js";
import { SerialCodeAssignment } from "./SerialCodeAssignment.js";

export const DEVICE_PROFILE_OPTIONS: ReadonlyArray<{ readonly key: DeviceProfileKey; readonly label: string; readonly hint: string }> = [
  { key: "desktop-chrome", label: "桌面 Chrome", hint: "1920×1080 桌面视口" },
  { key: "iphone-13", label: "iPhone 13", hint: "390×844 移动视口" },
  { key: "pixel-7", label: "Pixel 7", hint: "412×915 移动视口" }
];

export function deviceProfileLabel(key: DeviceProfileKey | undefined): string {
  return DEVICE_PROFILE_OPTIONS.find((option) => option.key === (key ?? "desktop-chrome"))?.label ?? "桌面 Chrome";
}

function normalizeDeviceProfileKey(value: string): DeviceProfileKey {
  return DEVICE_PROFILE_OPTIONS.some((option) => option.key === value) ? (value as DeviceProfileKey) : "desktop-chrome";
}

export interface TaskForm {
  eventSnapshotId: string;
  accountIds: string[];
  preference: LotteryPreference;
  perAccountSerialCodes: string;
  serialCodeBatchText: string;
  confirmationPolicy: CreateTaskInputV2["confirmationPolicy"];
  riskAcknowledged: boolean;
  deviceProfileKey: DeviceProfileKey;
}

interface TaskCreationProps {
  readonly events: readonly EventSnapshot[];
  readonly accounts: readonly Account[];
  readonly form: TaskForm;
  readonly selectedEvent: EventSnapshot | undefined;
  readonly onFormChange: (form: TaskForm) => void;
  readonly onCreate: () => void;
}

function optionFor(event: EventSnapshot | undefined, kind: EventOption["kind"]): EventOption | undefined {
  return event?.rawFormSchema.options.find((option) => option.kind === kind);
}

export function TaskCreation(props: TaskCreationProps) {
  const ticket = optionFor(props.selectedEvent, "ticket");
  const quantity = optionFor(props.selectedEvent, "quantity");
  const payment = optionFor(props.selectedEvent, "payment");
  const serialCode = props.selectedEvent?.rawFormSchema.serialCode;
  const firstEntry = props.form.preference.entries[0] ?? { rank: 1, ticketTypeId: "", quantity: 1 };
  const changePreference = (preference: LotteryPreference) => props.onFormChange({ ...props.form, preference });
  const changePaymentPreference = (value: string) => {
    const { paymentMethodId, paymentPreference, ...rest } = props.form.preference;
    void paymentMethodId;
    void paymentPreference;
    changePreference(value ? { ...rest, paymentPreference: { groupKey: "payment", value } } : { ...rest });
  };
  const taskDraft: TaskDraft = { accountIds: props.form.accountIds, confirmationPolicy: props.form.confirmationPolicy, preference: props.form.preference, riskAcknowledged: props.form.riskAcknowledged };
  const changeDraft = (draft: TaskDraft) => props.onFormChange({ ...props.form, ...draft });
  return (
    <section className="workspace-panel" aria-labelledby="task-title">
      <div className="workspace-heading">
        <div>
          <p className="section-kicker">演出与任务</p>
          <h1 id="task-title">创建任务</h1>
          <p>选择演出、偏好、设备档案和账号。付款方式在浏览器实际打开后发现，并在任务监控中确认，无需预先填写付款标识。</p>
        </div>
        <span className="badge badge-yellow">{props.form.accountIds.length} 个账号待审阅</span>
      </div>
      <section className="panel-card">
        <div className="panel-head">
          <h2><ListTodo size={16} />任务偏好</h2>
          <span className="muted">每个账号的实际偏好可在下方单独核对</span>
        </div>
        <div className="form-grid">
          <label className="full">演出快照
            <select value={props.form.eventSnapshotId} onChange={(event) => props.onFormChange({ ...props.form, eventSnapshotId: event.target.value })}>
              {props.events.map((event) => <option key={event.id} value={event.id}>{event.title}</option>)}
            </select>
          </label>
          <label>申请入口
            {ticket
              ? <select value={props.form.preference.applicationLinkId || firstEntry.ticketTypeId} onChange={(event) => changePreference({ ...props.form.preference, applicationLinkId: event.target.value, entries: [{ ...firstEntry, ticketTypeId: event.target.value }] })}>
                  <option value="">选择解析出的申请入口</option>
                  {ticket.values.map((item) => <option key={item.id} value={item.id} disabled={item.disabled}>{item.label}</option>)}
                </select>
              : <input value={firstEntry.ticketTypeId} placeholder="申请入口标识" onChange={(event) => changePreference({ ...props.form.preference, entries: [{ ...firstEntry, ticketTypeId: event.target.value }] })} />}
          </label>
          <label>票数
            {quantity
              ? <select value={String(firstEntry.quantity)} onChange={(event) => changePreference({ ...props.form.preference, entries: [{ ...firstEntry, quantity: Number(event.target.value) }] })}>
                  {quantity.values.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
                </select>
              : <input type="number" min="1" value={firstEntry.quantity} onChange={(event) => changePreference({ ...props.form.preference, entries: [{ ...firstEntry, quantity: Number(event.target.value) }] })} />}
          </label>
          <label>设备档案
            <select aria-label="设备档案" value={props.form.deviceProfileKey} onChange={(event) => props.onFormChange({ ...props.form, deviceProfileKey: normalizeDeviceProfileKey(event.target.value) })}>
              {DEVICE_PROFILE_OPTIONS.map((option) => <option key={option.key} value={option.key}>{option.label}（{option.hint}）</option>)}
            </select>
          </label>
          <label>付款偏好（可选）
            {payment
              ? <select aria-label="付款偏好" value={props.form.preference.paymentPreference?.value ?? ""} onChange={(event) => changePaymentPreference(event.target.value)}>
                  <option value="">运行时发现后在监控中选择</option>
                  {payment.values.map((item) => <option key={item.id} value={item.id} disabled={item.disabled}>{item.label}</option>)}
                </select>
              : <input aria-label="付款偏好" value="" placeholder="运行时发现付款方式" disabled readOnly />}
          </label>
          {serialCode?.required
            ? <>
                <label>公共抽选码
                  <input value={props.form.preference.serialCode ?? ""} placeholder={serialCode.placeholder ?? "输入抽选码"} onChange={(event) => changePreference({ ...props.form.preference, serialCode: event.target.value })} />
                </label>
                <label className="full">账号专用抽选码（兼容旧格式）
                  <textarea rows={3} value={props.form.perAccountSerialCodes} placeholder="邮箱=抽选码；批量多码请使用下面的分配器" onChange={(event) => props.onFormChange({ ...props.form, perAccountSerialCodes: event.target.value })} />
                </label>
              </>
            : null}
          <fieldset className="full account-picker"><legend>参与账号（可多选）</legend><div className="account-picker-actions"><button type="button" className="icon-button" onClick={() => props.onFormChange({ ...props.form, accountIds: props.accounts.filter((account) => account.enabled).map((account) => account.id) })}>全选启用账号</button><button type="button" className="icon-button" onClick={() => props.onFormChange({ ...props.form, accountIds: [] })}>清空</button></div><div className="account-picker-grid">{props.accounts.map((account) => <label key={account.id} className={`account-picker-item${account.enabled ? "" : " disabled"}`}><input type="checkbox" disabled={!account.enabled} checked={props.form.accountIds.includes(account.id)} onChange={(event) => { const next = new Set(props.form.accountIds); if (event.target.checked) next.add(account.id); else next.delete(account.id); props.onFormChange({ ...props.form, accountIds: [...next] }); }} /><span>{account.label || account.eplusEmail}</span>{account.enabled ? null : <small>已停用</small>}</label>)}</div></fieldset>
        </div>
        {serialCode?.required ? <SerialCodeAssignment accounts={props.accounts} selectedAccountIds={props.form.accountIds} plans={props.form.preference.serialCodeAllocations ?? {}} batchText={props.form.serialCodeBatchText} applicationChoices={ticket?.values.map((value) => ({ id: value.id, label: value.label })) ?? []} availableDays={serialCode.availableDays ?? []} defaultApplicationLinkId={props.form.preference.applicationLinkId} onBatchTextChange={(serialCodeBatchText) => props.onFormChange({ ...props.form, serialCodeBatchText })} onPlansChange={(serialCodeAllocations) => changePreference({ ...props.form.preference, serialCodeAllocations })} /> : null}
        <p className="muted"><MonitorSmartphone size={14} aria-hidden="true" /> 该任务将使用「{deviceProfileLabel(props.form.deviceProfileKey)}」设备档案，创建后对本任务运行不可更改。</p>
        <TaskPolicyControls automated={true} policy={props.form.confirmationPolicy} acknowledged={props.form.riskAcknowledged} onPolicyChange={(confirmationPolicy) => props.onFormChange({ ...props.form, confirmationPolicy })} onAcknowledgedChange={(riskAcknowledged) => props.onFormChange({ ...props.form, riskAcknowledged })} />
        <div className="panel-head subsection-head">
          <h3>每账号偏好预览</h3>
          <span className="muted">创建前确认每个账号的场次与抽选码</span>
        </div>
        <PerAccountReview accounts={props.accounts} event={props.selectedEvent} draft={taskDraft} onDraftChange={changeDraft} />
        <PreviewDigest event={props.selectedEvent} draft={taskDraft} accounts={props.accounts} />
        <div className="actions">
          <button className="primary" disabled={!props.form.riskAcknowledged || props.form.accountIds.length === 0} onClick={props.onCreate}><ListTodo size={16} />创建任务</button>
        </div>
      </section>
    </section>
  );
}
