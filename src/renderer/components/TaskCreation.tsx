import { CreditCard, ListTodo, MonitorSmartphone, Ticket, UsersRound } from "lucide-react";
import type { Account, CreateTaskInputV2, EventOption, EventSnapshot, LotteryPreference } from "../../shared/ipc.js";
import type { DeviceProfileKey } from "../../shared/types.js";
import { PerAccountReview, PreviewDigest, TaskPolicyControls, type TaskDraft } from "./TaskWorkflow.js";
import { SerialCodeAssignment } from "./SerialCodeAssignment.js";

export const DEVICE_PROFILE_OPTIONS: ReadonlyArray<{ readonly key: DeviceProfileKey; readonly label: string; readonly hint: string }> = [
  { key: "desktop-chrome", label: "桌面 Chrome", hint: "1920×1080 桌面视口" },
  { key: "desktop-edge", label: "桌面 Edge", hint: "1920×1080 桌面视口" },
  { key: "iphone-13", label: "iPhone 13", hint: "390×844 移动视口" },
  { key: "iphone-15", label: "iPhone 15", hint: "393×852 移动视口" },
  { key: "iphone-se", label: "iPhone SE", hint: "375×667 移动视口" },
  { key: "pixel-7", label: "Pixel 7", hint: "412×915 移动视口" },
  { key: "pixel-8", label: "Pixel 8", hint: "412×915 移动视口" },
  { key: "galaxy-s24", label: "Galaxy S24", hint: "384×832 移动视口" },
  { key: "ipad-gen7", label: "iPad (第 7 代)", hint: "810×1080 平板视口" }
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
  readonly creating: boolean;
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
  const enabledAccountCount = props.accounts.filter((account) => account.enabled).length;
  return (
    <section className="workspace-panel" aria-labelledby="task-title">
      <div className="workspace-heading">
        <div>
          <p className="section-kicker">演出与任务</p>
          <h1 id="task-title">创建任务</h1>
          <p>选择演出、偏好、设备档案和账号。付款等运行时选项在浏览器实际打开后发现，人工确认一次后同一入口的其余运行会自动复用。</p>
        </div>
        <span className="badge badge-yellow">{props.form.accountIds.length} 个账号待审阅</span>
      </div>

      <section className="panel-card">
        <div className="panel-head">
          <h2><Ticket size={16} />演出与申请入口</h2>
          <span className="muted">选择已保存的演出快照与解析出的申请入口</span>
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
              : serialCode?.required
                ? <input value="シリアルコード（抽选码）直接入口，无需单独选择" disabled readOnly />
                : <input value={firstEntry.ticketTypeId} placeholder="申请入口标识" onChange={(event) => changePreference({ ...props.form.preference, entries: [{ ...firstEntry, ticketTypeId: event.target.value }] })} />}
          </label>
          <label>票数
            {quantity
              ? <select value={String(firstEntry.quantity)} onChange={(event) => changePreference({ ...props.form.preference, entries: [{ ...firstEntry, quantity: Number(event.target.value) }] })}>
                  {quantity.values.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
                </select>
              : <input type="number" min="1" value={firstEntry.quantity} onChange={(event) => changePreference({ ...props.form.preference, entries: [{ ...firstEntry, quantity: Number(event.target.value) }] })} />}
          </label>
        </div>
      </section>

      <section className="panel-card">
        <div className="panel-head">
          <h2><MonitorSmartphone size={16} />设备与提交策略</h2>
          <span className="muted">创建后对本任务运行不可更改</span>
        </div>
        <div className="form-grid">
          <label className="full">设备档案
            <select aria-label="设备档案" value={props.form.deviceProfileKey} onChange={(event) => props.onFormChange({ ...props.form, deviceProfileKey: normalizeDeviceProfileKey(event.target.value) })}>
              {DEVICE_PROFILE_OPTIONS.map((option) => <option key={option.key} value={option.key}>{option.label}（{option.hint}）</option>)}
            </select>
          </label>
        </div>
        <p className="muted"><MonitorSmartphone size={14} aria-hidden="true" /> 该任务将使用「{deviceProfileLabel(props.form.deviceProfileKey)}」设备档案。</p>
        <TaskPolicyControls automated={true} policy={props.form.confirmationPolicy} acknowledged={props.form.riskAcknowledged} onPolicyChange={(confirmationPolicy) => props.onFormChange({ ...props.form, confirmationPolicy })} onAcknowledgedChange={(riskAcknowledged) => props.onFormChange({ ...props.form, riskAcknowledged })} />
      </section>

      <section className="panel-card">
        <div className="panel-head">
          <h2><CreditCard size={16} />付款偏好（可选）</h2>
          <span className="muted">首次由人工在浏览器中选择后，后续同一入口的运行会自动复用该选择</span>
        </div>
        <div className="form-grid">
          <label className="full">付款偏好
            {payment
              ? <select aria-label="付款偏好" value={props.form.preference.paymentPreference?.value ?? ""} onChange={(event) => changePaymentPreference(event.target.value)}>
                  <option value="">运行时发现后自动应用或在监控中选择</option>
                  {payment.values.map((item) => <option key={item.id} value={item.id} disabled={item.disabled}>{item.label}</option>)}
                </select>
              : <input aria-label="付款偏好" value="" placeholder="运行时发现付款方式" disabled readOnly />}
          </label>
        </div>
      </section>

      {serialCode?.required ? <SerialCodeAssignment accounts={props.accounts} selectedAccountIds={props.form.accountIds} plans={props.form.preference.serialCodeAllocations ?? {}} batchText={props.form.serialCodeBatchText} applicationChoices={ticket?.values.map((value) => ({ id: value.id, label: value.label })) ?? []} availableDays={serialCode.availableDays ?? []} defaultApplicationLinkId={props.form.preference.applicationLinkId} onBatchTextChange={(serialCodeBatchText) => props.onFormChange({ ...props.form, serialCodeBatchText })} onPlansChange={(serialCodeAllocations) => changePreference({ ...props.form.preference, serialCodeAllocations })} /> : null}

      <section className="panel-card">
        <div className="panel-head">
          <h2><UsersRound size={16} />参与账号</h2>
          <span className="muted">{props.form.accountIds.length} / {enabledAccountCount} 个已启用账号已选中</span>
        </div>
        <fieldset className="account-picker">
          <legend className="sr-only">参与账号（可多选）</legend>
          <div className="account-picker-actions">
            <button type="button" className="icon-button" onClick={() => props.onFormChange({ ...props.form, accountIds: props.accounts.filter((account) => account.enabled).map((account) => account.id) })}>全选启用账号</button>
            <button type="button" className="icon-button" onClick={() => props.onFormChange({ ...props.form, accountIds: [] })}>清空</button>
          </div>
          <div className="account-picker-grid">
            {props.accounts.map((account) => (
              <label key={account.id} className={`account-picker-item${account.enabled ? "" : " disabled"}`}>
                <input type="checkbox" disabled={!account.enabled} checked={props.form.accountIds.includes(account.id)} onChange={(event) => { const next = new Set(props.form.accountIds); if (event.target.checked) next.add(account.id); else next.delete(account.id); props.onFormChange({ ...props.form, accountIds: [...next] }); }} />
                <span>{account.label || account.eplusEmail}</span>
                {account.enabled ? null : <small>已停用</small>}
              </label>
            ))}
          </div>
          {props.accounts.length === 0 ? <p className="empty-state">尚未添加账号，请先在“账号列表”中添加。</p> : null}
        </fieldset>
      </section>

      <section className="panel-card">
        <div className="panel-head">
          <h2><ListTodo size={16} />预览与确认</h2>
          <span className="muted">创建前确认每个账号的场次与抽选码</span>
        </div>
        <PerAccountReview accounts={props.accounts} event={props.selectedEvent} draft={taskDraft} onDraftChange={changeDraft} />
        <PreviewDigest event={props.selectedEvent} draft={taskDraft} accounts={props.accounts} />
        <div className="actions">
          <button className="primary" disabled={!props.form.riskAcknowledged || props.form.accountIds.length === 0 || props.creating} onClick={props.onCreate}><ListTodo size={16} />{props.creating ? "正在创建" : "创建任务"}</button>
        </div>
      </section>
    </section>
  );
}
