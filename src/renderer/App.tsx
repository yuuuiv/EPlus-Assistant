import React, { useEffect, useMemo, useState } from "react";
import {
  BadgePlus,
  CircleAlert,
  FileDown,
  FolderOpen,
  ListTodo,
  Plus,
  RefreshCw,
  ShieldCheck,
  Trash2,
  Upload,
  Users,
  Waypoints
} from "lucide-react";
import type {
  Account,
  AccountRun,
  DashboardState,
  EventSnapshot,
  ImportReport,
  LotteryPreference
} from "../shared/ipc.js";

const emptyState: DashboardState = {
  accounts: [],
  events: [],
  tasks: [],
  runs: [],
  logs: [],
  dataDir: ""
};

const defaultPreference: LotteryPreference = {
  entries: [{ rank: 1, ticketTypeId: "", quantity: 1 }],
  paymentMethodId: "",
  consentFlags: {}
};

function toLines(value: string): string[] {
  return value
    .split(/[\n,;]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function RunRow(props: {
  run: AccountRun;
  accounts: Account[];
  onStatus: (status: string) => Promise<void>;
}) {
  const account = props.accounts.find((item) => item.id === props.run.accountId);
  const actions =
    props.run.status === "Pending"
      ? [{ label: "登录", status: "LoggingIn" }]
      : props.run.status === "LoggingIn"
        ? [
            { label: "等验证码", status: "AwaitingEmailCode" },
            { label: "人工接管", status: "AwaitingManualAction" },
            { label: "填表", status: "FillingForm" },
            { label: "失败", status: "Failed" }
          ]
        : props.run.status === "AwaitingEmailCode"
          ? [
              { label: "填表", status: "FillingForm" },
              { label: "人工接管", status: "AwaitingManualAction" }
            ]
          : props.run.status === "FillingForm"
            ? [
                { label: "提交确认", status: "AwaitingSubmitConfirmation" },
                { label: "人工接管", status: "AwaitingManualAction" }
              ]
            : props.run.status === "AwaitingSubmitConfirmation"
              ? [
                  { label: "提交", status: "Submitting" },
                  { label: "人工接管", status: "AwaitingManualAction" }
                ]
              : props.run.status === "Submitting"
                ? [
                    { label: "已提交", status: "Submitted" },
                    { label: "未知", status: "UnknownSubmissionState" },
                    { label: "失败", status: "Failed" }
                  ]
                : props.run.status === "AwaitingManualAction"
                  ? [
                      { label: "继续登录", status: "LoggingIn" },
                      { label: "继续填表", status: "FillingForm" },
                      { label: "取消", status: "Cancelled" }
                    ]
                  : props.run.status === "UnknownSubmissionState"
                    ? [
                        { label: "查证已提交", status: "Submitted" },
                        { label: "人工查证", status: "AwaitingManualAction" },
                        { label: "失败", status: "Failed" }
                      ]
                    : [];
  return (
    <div className="run-row">
      <span>{account?.label ?? props.run.accountId}</span>
      <span>{props.run.status}</span>
      <div className="row-actions">
        {actions.map((action) => (
          <button
            key={action.status}
            className={action.status === "Failed" || action.status === "Cancelled" ? "icon-button danger" : "icon-button"}
            onClick={() => props.onStatus(action.status)}
          >
            {action.label}
          </button>
        ))}
      </div>
    </div>
  );
}

export function App() {
  const [state, setState] = useState<DashboardState>(emptyState);
  const [accountForm, setAccountForm] = useState({
    label: "",
    eplusEmail: "",
    password: "",
    mailProviderId: "manual",
    tags: "",
    enabled: true,
    mailConfig: "{}"
  });
  const [importKind, setImportKind] = useState<"csv" | "json">("csv");
  const [importText, setImportText] = useState("eplusEmail,password,label,tags,enabled\n");
  const [eventForm, setEventForm] = useState({
    sourceUrl: "https://www.eplus.jp/",
    title: "",
    venue: "",
    scheduleText: "",
    applicationDeadline: "",
    rawFormSchemaJson: JSON.stringify(
      {
        options: [],
        requiresManualInspection: true,
        notes: ["Fill these from the real Eplus page or keep as a manual draft."]
      },
      null,
      2
    )
  });
  const [taskForm, setTaskForm] = useState({
    eventSnapshotId: "",
    accountIds: [] as string[],
    preference: defaultPreference
  });
  const [message, setMessage] = useState<string>("");
  const [report, setReport] = useState<ImportReport | undefined>();

  async function refresh() {
    const snapshot = await window.eplusApi.getState();
    setState(snapshot);
    setTaskForm((current) => ({
      ...current,
      eventSnapshotId: current.eventSnapshotId || snapshot.events[0]?.id || "",
      accountIds: current.accountIds.length ? current.accountIds : snapshot.accounts.filter((item) => item.enabled).map((item) => item.id)
    }));
  }

  useEffect(() => {
    void refresh();
  }, []);

  async function runAction(action: () => Promise<void>) {
    try {
      await action();
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      setMessage(`操作失败：${text}`);
      await window.eplusApi.addLog(text, "error");
    }
  }

  const selectedEvent = useMemo(
    () => state.events.find((item) => item.id === taskForm.eventSnapshotId) ?? state.events[0],
    [state.events, taskForm.eventSnapshotId]
  );

  async function handleAddAccount() {
    const created = await window.eplusApi.addAccount({
      ...accountForm,
      tags: toLines(accountForm.tags),
      mailConfig: JSON.parse(accountForm.mailConfig || "{}")
    });
    setMessage(`已新增账号 ${created.eplusEmail}`);
    setAccountForm((current) => ({ ...current, label: "", eplusEmail: "", password: "", tags: "", mailConfig: "{}" }));
    await refresh();
  }

  async function handleImport() {
    const result = await window.eplusApi.importAccounts({ kind: importKind, text: importText });
    setReport(result);
    setMessage(`导入完成：${result.inserted} 新增，${result.updated} 更新，${result.errors.length} 个错误`);
    await refresh();
  }

  async function handleSaveEvent() {
    const created = await window.eplusApi.saveEventSnapshot(eventForm);
    setTaskForm((current) => ({ ...current, eventSnapshotId: created.id }));
    setMessage(`已保存抽选快照：${created.title}`);
    await refresh();
  }

  async function handleCreateTask() {
    if (!selectedEvent) {
      throw new Error("请先保存一个演出快照。");
    }
    const created = await window.eplusApi.createTask({
      eventSnapshotId: selectedEvent.id,
      preference: taskForm.preference,
      accountIds: taskForm.accountIds
    });
    setMessage(`任务已创建：${created.taskId}`);
    await refresh();
  }

  async function handleTaskStatus(taskId: string, status: string) {
    await window.eplusApi.updateTaskStatus(taskId, status);
    await refresh();
  }

  async function handleRunStatus(runId: string, status: string) {
    await window.eplusApi.updateRunStatus(runId, status);
    await refresh();
  }

  return (
    <div className="shell">
      <header className="topbar">
        <div>
          <div className="eyebrow">Eplus 本地工作台</div>
          <h1>账号、抽选和证据一起管住</h1>
        </div>
        <div className="topbar-actions">
          <button className="icon-button" onClick={refresh}><RefreshCw size={16} />刷新</button>
          <button className="icon-button" onClick={() => window.eplusApi.openDataFolder()}><FolderOpen size={16} />数据目录</button>
        </div>
      </header>

      <div className="status-strip">
        <span><Users size={14} />{state.accounts.length} 个账号</span>
        <span><Waypoints size={14} />{state.events.length} 个快照</span>
        <span><ListTodo size={14} />{state.tasks.length} 个任务</span>
        <span><ShieldCheck size={14} />本机加密存储</span>
        {message ? <strong>{message}</strong> : null}
      </div>

      <main className="layout">
        <section className="panel wide">
          <div className="panel-head">
            <h2><Plus size={16} />新增账号</h2>
            <span className="muted">显式表单，密码只在本机加密入库</span>
          </div>
          <div className="form-grid account-grid">
            <label>显示名<input value={accountForm.label} onChange={(e) => setAccountForm({ ...accountForm, label: e.target.value })} /></label>
            <label>Eplus 邮箱<input value={accountForm.eplusEmail} onChange={(e) => setAccountForm({ ...accountForm, eplusEmail: e.target.value })} /></label>
            <label>密码<input type="password" value={accountForm.password} onChange={(e) => setAccountForm({ ...accountForm, password: e.target.value })} /></label>
            <label>邮件适配器 ID<input value={accountForm.mailProviderId} onChange={(e) => setAccountForm({ ...accountForm, mailProviderId: e.target.value })} /></label>
            <label className="full">标签<input value={accountForm.tags} onChange={(e) => setAccountForm({ ...accountForm, tags: e.target.value })} placeholder="逗号分隔" /></label>
            <label className="full">邮件配置 JSON<textarea rows={4} value={accountForm.mailConfig} onChange={(e) => setAccountForm({ ...accountForm, mailConfig: e.target.value })} /></label>
          </div>
          <div className="actions">
            <button className="primary" onClick={() => runAction(handleAddAccount)}><BadgePlus size={16} />添加账号</button>
          </div>
        </section>

        <section className="panel wide">
          <div className="panel-head">
            <h2><Upload size={16} />导入账号</h2>
            <div className="segmented">
              <button className={importKind === "csv" ? "seg active" : "seg"} onClick={() => setImportKind("csv")}>CSV</button>
              <button className={importKind === "json" ? "seg active" : "seg"} onClick={() => setImportKind("json")}>JSON</button>
            </div>
          </div>
          <textarea rows={8} value={importText} onChange={(e) => setImportText(e.target.value)} />
          <div className="actions">
            <button className="primary" onClick={() => runAction(handleImport)}><FileDown size={16} />导入</button>
            {report ? <span className="muted">新增 {report.inserted}，更新 {report.updated}，错误 {report.errors.length}</span> : null}
          </div>
          {report?.errors.length ? (
            <div className="inline-list">
              {report.errors.map((item) => (
                <div key={`${item.row}-${item.message}`} className="inline-error">
                  第 {item.row} 行：{item.message}
                </div>
              ))}
            </div>
          ) : null}
        </section>

        <section className="panel">
          <div className="panel-head">
            <h2><Users size={16} />账号列表</h2>
            <span className="muted">{state.accounts.filter((item) => item.enabled).length} 个启用</span>
          </div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr><th>标签</th><th>邮箱</th><th>适配器</th><th>状态</th><th /></tr>
              </thead>
              <tbody>
                {state.accounts.map((account) => (
                  <tr key={account.id}>
                    <td>{account.label}</td>
                    <td>{account.eplusEmail}</td>
                    <td>{account.mailProviderId}</td>
                    <td>{account.enabled ? "启用" : "停用"}</td>
                    <td className="row-actions">
                      <button className="icon-button danger" onClick={() => runAction(async () => { await window.eplusApi.deleteAccount(account.id); await refresh(); })}>
                        <Trash2 size={14} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section className="panel">
          <div className="panel-head">
            <h2><Waypoints size={16} />抽选快照</h2>
            <span className="muted">先保存页面信息，再创建任务</span>
          </div>
          <div className="form-grid">
            <label className="full">来源 URL<input value={eventForm.sourceUrl} onChange={(e) => setEventForm({ ...eventForm, sourceUrl: e.target.value })} /></label>
            <label className="full">标题<input value={eventForm.title} onChange={(e) => setEventForm({ ...eventForm, title: e.target.value })} /></label>
            <label>会场<input value={eventForm.venue} onChange={(e) => setEventForm({ ...eventForm, venue: e.target.value })} /></label>
            <label>截止时间<input value={eventForm.applicationDeadline} onChange={(e) => setEventForm({ ...eventForm, applicationDeadline: e.target.value })} /></label>
            <label className="full">场次说明<textarea rows={3} value={eventForm.scheduleText} onChange={(e) => setEventForm({ ...eventForm, scheduleText: e.target.value })} /></label>
            <label className="full">页面结构 JSON<textarea rows={8} value={eventForm.rawFormSchemaJson} onChange={(e) => setEventForm({ ...eventForm, rawFormSchemaJson: e.target.value })} /></label>
          </div>
          <div className="actions">
            <button className="primary" onClick={() => runAction(handleSaveEvent)}><Plus size={16} />保存快照</button>
          </div>
        </section>

        <section className="panel">
          <div className="panel-head">
            <h2><ListTodo size={16} />创建任务</h2>
            <span className="muted">确认后才会进入队列</span>
          </div>
          <div className="form-grid">
            <label className="full">快照
              <select value={taskForm.eventSnapshotId} onChange={(e) => setTaskForm({ ...taskForm, eventSnapshotId: e.target.value })}>
                {state.events.map((event) => <option key={event.id} value={event.id}>{event.title}</option>)}
              </select>
            </label>
            <label>票档 ID<input value={taskForm.preference.entries[0]?.ticketTypeId ?? ""} onChange={(e) => setTaskForm({ ...taskForm, preference: { ...taskForm.preference, entries: [{ ...taskForm.preference.entries[0], ticketTypeId: e.target.value, rank: 1, quantity: taskForm.preference.entries[0]?.quantity ?? 1 }] } })} /></label>
            <label>枚数<input type="number" min="1" value={taskForm.preference.entries[0]?.quantity ?? 1} onChange={(e) => setTaskForm({ ...taskForm, preference: { ...taskForm.preference, entries: [{ ...taskForm.preference.entries[0], ticketTypeId: taskForm.preference.entries[0]?.ticketTypeId ?? "", rank: 1, quantity: Number(e.target.value) }] } })} /></label>
            <label>付款方式 ID<input value={taskForm.preference.paymentMethodId} onChange={(e) => setTaskForm({ ...taskForm, preference: { ...taskForm.preference, paymentMethodId: e.target.value } })} /></label>
            <label className="full">账号选择
              <select multiple value={taskForm.accountIds} onChange={(e) => setTaskForm({ ...taskForm, accountIds: Array.from(e.currentTarget.selectedOptions).map((item) => item.value) })}>
                {state.accounts.map((account) => <option key={account.id} value={account.id}>{account.label || account.eplusEmail}</option>)}
              </select>
            </label>
          </div>
          <div className="actions">
            <button className="primary" onClick={() => runAction(handleCreateTask)}><ListTodo size={16} />创建任务</button>
          </div>
        </section>

        <section className="panel">
          <div className="panel-head">
            <h2><ListTodo size={16} />任务与运行</h2>
            <span className="muted">状态机保守，未知提交态不会自动重试</span>
          </div>
          <div className="stack">
            {state.tasks.map((task) => {
              const event = state.events.find((item) => item.id === task.eventSnapshotId);
              const runs = state.runs.filter((run) => run.taskId === task.id);
              const taskActions = task.status === "AwaitingConfirmation"
                ? [{ label: "排队", status: "Queued" }]
                : task.status === "Queued"
                  ? [{ label: "运行", status: "Running" }]
                  : task.status === "Running"
                    ? [{ label: "暂停", status: "Paused" }, { label: "完成", status: "Completed" }, { label: "失败", status: "Failed" }]
                    : task.status === "Paused"
                      ? [{ label: "继续", status: "Running" }, { label: "取消", status: "Cancelled" }]
                      : [];
              return (
                <div key={task.id} className="item-block">
                  <div className="item-head">
                    <div>
                      <strong>{event?.title ?? "未找到快照"}</strong>
                      <div className="muted">{task.status} · {task.accountIds.length} 账号</div>
                    </div>
                    <div className="row-actions">
                      {taskActions.map((action) => (
                        <button key={action.status} className="icon-button" onClick={() => runAction(() => handleTaskStatus(task.id, action.status))}>
                          {action.label}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div className="runs">
                    {runs.map((run) => <RunRow key={run.id} run={run} accounts={state.accounts} onStatus={(status) => runAction(() => handleRunStatus(run.id, status))} />)}
                  </div>
                </div>
              );
            })}
          </div>
        </section>

        <section className="panel">
          <div className="panel-head">
            <h2><CircleAlert size={16} />日志</h2>
            <span className="muted">{state.logs.length} 条</span>
          </div>
          <div className="stack log-stack">
            {state.logs.slice(0, 20).map((log) => (
              <div key={log.id} className={`log ${log.level}`}>
                <span>{log.createdAt}</span>
                <strong>{log.message}</strong>
              </div>
            ))}
          </div>
        </section>
      </main>
    </div>
  );
}
