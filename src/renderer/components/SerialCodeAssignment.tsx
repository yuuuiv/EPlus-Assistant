import { ArrowRight, ClipboardList, RotateCcw, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { Account, SerialCodePlan } from "../../shared/types.js";

interface ApplicationChoice {
  readonly id: string;
  readonly label: string;
}

interface SerialCodeAssignmentProps {
  readonly accounts: readonly Account[];
  readonly selectedAccountIds: readonly string[];
  readonly plans: Record<string, SerialCodePlan[]>;
  readonly batchText: string;
  readonly applicationChoices: readonly ApplicationChoice[];
  readonly availableDays: readonly ("day1" | "day2")[];
  readonly defaultApplicationLinkId?: string;
  readonly onBatchTextChange: (value: string) => void;
  readonly onPlansChange: (plans: Record<string, SerialCodePlan[]>) => void;
}

const dayOptions = [
  { value: "day1" as const, label: "第一天" },
  { value: "day2" as const, label: "第二天" }
];

function parseCodes(value: string): string[] {
  return Array.from(new Set(value.split(/[\s,，;；]+/u).map((code) => code.trim()).filter(Boolean)));
}

function accountLabel(account: Account): string {
  return account.label || account.eplusEmail;
}

export function SerialCodeAssignment(props: SerialCodeAssignmentProps) {
  const [parsedCodes, setParsedCodes] = useState<string[]>(() => parseCodes(props.batchText));
  const [selectedCodes, setSelectedCodes] = useState<Set<string>>(new Set());
  const [accountId, setAccountId] = useState(props.selectedAccountIds[0] ?? "");
  const [days, setDays] = useState<Array<"day1" | "day2">>(() => props.availableDays.length > 0 ? [...props.availableDays] : ["day1", "day2"]);
  const [applicationLinkId, setApplicationLinkId] = useState(props.defaultApplicationLinkId ?? "");
  useEffect(() => {
    if (!props.selectedAccountIds.includes(accountId)) setAccountId(props.selectedAccountIds[0] ?? "");
  }, [accountId, props.selectedAccountIds]);
  useEffect(() => setParsedCodes(parseCodes(props.batchText)), [props.batchText]);
  const selectedAccounts = useMemo(() => props.accounts.filter((account) => props.selectedAccountIds.includes(account.id)), [props.accounts, props.selectedAccountIds]);
  const assignedCodes = useMemo(() => new Set(Object.values(props.plans).flat().map((plan) => plan.code)), [props.plans]);
  const pendingCodes = parsedCodes.filter((code) => !assignedCodes.has(code));
  const currentPlan = { daySelection: days.length > 0 ? days : undefined, applicationLinkId: applicationLinkId || undefined };

  const parseBatch = () => {
    const parsed = parseCodes(props.batchText);
    setParsedCodes(parsed);
    setSelectedCodes(new Set(parsed.filter((code) => !assignedCodes.has(code))));
  };

  const assign = (codes: readonly string[]) => {
    if (!accountId || codes.length === 0) return;
    const next: Record<string, SerialCodePlan[]> = Object.fromEntries(Object.entries(props.plans).map(([id, values]) => [id, [...values]]));
    for (const [id, values] of Object.entries(next)) next[id] = values.filter((plan) => !codes.includes(plan.code));
    next[accountId] = [...(next[accountId] ?? []), ...codes.map((code) => ({ code, ...currentPlan }))];
    setSelectedCodes(new Set());
    props.onPlansChange(next);
  };

  const distributeEvenly = () => {
    if (selectedAccounts.length === 0 || pendingCodes.length === 0) return;
    const next: Record<string, SerialCodePlan[]> = Object.fromEntries(Object.entries(props.plans).map(([id, values]) => [id, [...values]]));
    pendingCodes.forEach((code, index) => {
      const target = selectedAccounts[index % selectedAccounts.length];
      if (target) next[target.id] = [...(next[target.id] ?? []), { code, ...currentPlan }];
    });
    setSelectedCodes(new Set());
    props.onPlansChange(next);
  };

  const remove = (targetAccountId: string, code: string) => {
    props.onPlansChange({ ...props.plans, [targetAccountId]: (props.plans[targetAccountId] ?? []).filter((plan) => plan.code !== code) });
  };

  const clear = () => props.onPlansChange({});

  return (
    <section className="serial-assignment" aria-label="抽选码批量分配">
      <div className="panel-head subsection-head">
        <h3><ClipboardList size={16} />批量抽选码与方案分配</h3>
        <span className="muted">一个抽选码对应一次独立运行，可单独选择一天或两天</span>
      </div>
      <label className="full">抽选码批量输入
        <textarea rows={5} value={props.batchText} placeholder="每行一个抽选码，也支持空格、逗号分隔" onChange={(event) => props.onBatchTextChange(event.target.value)} />
      </label>
      <div className="serial-assignment-toolbar">
        <button type="button" className="icon-button" onClick={parseBatch}><ClipboardList size={15} />解析抽选码（{parseCodes(props.batchText).length}）</button>
        <span className="muted">待分配 {pendingCodes.length} 个 · 已分配 {assignedCodes.size} 个</span>
      </div>
      <div className="serial-plan-controls">
        <label>分配账号
          <select value={accountId} onChange={(event) => setAccountId(event.target.value)}>
            <option value="">选择账号</option>
            {selectedAccounts.map((account) => <option key={account.id} value={account.id}>{accountLabel(account)}</option>)}
          </select>
        </label>
        <fieldset>
          <legend>本次场次方案</legend>
          <div className="check-row">
            {dayOptions.filter((day) => props.availableDays.length === 0 || props.availableDays.includes(day.value)).map((day) => <label key={day.value}><input type="checkbox" checked={days.includes(day.value)} onChange={() => setDays((current) => current.includes(day.value) ? current.filter((item) => item !== day.value) : [...current, day.value])} />{day.label}</label>)}
          </div>
        </fieldset>
        {props.applicationChoices.length > 0 ? <label>申请入口
          <select value={applicationLinkId} onChange={(event) => setApplicationLinkId(event.target.value)}>
            <option value="">使用任务默认入口</option>
            {props.applicationChoices.map((choice) => <option key={choice.id} value={choice.id}>{choice.label}</option>)}
          </select>
        </label> : null}
      </div>
      <div className="serial-code-picker">
        {pendingCodes.map((code) => <label key={code} className="check-row"><input type="checkbox" checked={selectedCodes.has(code)} onChange={() => setSelectedCodes((current) => { const next = new Set(current); if (next.has(code)) next.delete(code); else next.add(code); return next; })} /><code>{code}</code></label>)}
        {pendingCodes.length === 0 ? <p className="muted">先解析批量输入；已分配的码会从待分配列表中移除。</p> : null}
      </div>
      <div className="actions">
        <button type="button" className="primary" disabled={!accountId || selectedCodes.size === 0 || days.length === 0} onClick={() => assign(Array.from(selectedCodes))}><ArrowRight size={15} />分配所选抽选码</button>
        <button type="button" className="icon-button" disabled={selectedAccounts.length === 0 || pendingCodes.length === 0 || days.length === 0} onClick={distributeEvenly}><RotateCcw size={15} />按账号平均生成方案</button>
        <button type="button" className="icon-button danger" disabled={assignedCodes.size === 0} onClick={clear}><Trash2 size={15} />清空分配</button>
      </div>
      <div className="serial-plan-list">
        {selectedAccounts.map((account) => { const plans = props.plans[account.id] ?? []; const runCount = plans.reduce((total, plan) => total + Math.max(plan.daySelection?.length ?? 1, 1), 0); return <article key={account.id} className="serial-plan-card"><div><strong>{accountLabel(account)}</strong><span>{plans.length} 个码 · {runCount} 次浏览器运行</span></div><div className="serial-plan-items">{plans.map((plan) => <span key={plan.code} className="serial-plan-item"><code>{plan.code}</code><small>{plan.daySelection?.length === 2 ? "两天 → 2 次" : plan.daySelection?.[0] === "day2" ? "第二天" : "第一天"}</small><button type="button" className="icon-button" aria-label={`移除 ${plan.code}`} onClick={() => remove(account.id, plan.code)}><Trash2 size={13} /></button></span>)}{plans.length === 0 ? <span className="muted">未分配</span> : null}</div></article>; })}
      </div>
    </section>
  );
}
