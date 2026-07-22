import { Eye, EyeOff, RefreshCw } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { Account, AccountProfile, ApplicationRecord, LotteryResultRecord } from "../../shared/ipc.js";
import { ProgressBar } from "./ProgressBar.js";

interface AccountDetailProps {
  readonly account: Account | undefined;
  readonly onClose: () => void;
  readonly onMessage: (message: string) => void;
}

function maskPhone(phone: string | undefined): string {
  if (!phone) return "暂无资料";
  return phone.replace(/(\d{2,3})\d+(\d{2})$/, "$1***$2");
}

function dateInRange(value: string | undefined, from: string, to: string): boolean {
  if (!value) return !from && !to;
  return (!from || value >= from) && (!to || value <= to);
}

export function AccountDetail(props: AccountDetailProps) {
  const [profile, setProfile] = useState<AccountProfile>();
  const [records, setRecords] = useState<readonly ApplicationRecord[]>([]);
  const [results, setResults] = useState<readonly LotteryResultRecord[]>([]);
  const [password, setPassword] = useState<string>();
  const [recordQuery, setRecordQuery] = useState("");
  const [recordFrom, setRecordFrom] = useState("");
  const [recordTo, setRecordTo] = useState("");
  const [recordDay, setRecordDay] = useState("all");
  const [resultQuery, setResultQuery] = useState("");
  const [resultFrom, setResultFrom] = useState("");
  const [resultTo, setResultTo] = useState("");
  const [resultKind, setResultKind] = useState("all");
  const [refreshingProfile, setRefreshingProfile] = useState(false);
  const [refreshingResults, setRefreshingResults] = useState(false);

  useEffect(() => {
    const account = props.account;
    if (!account) return;
    const accountId = account.id;
    let active = true;
    async function load(): Promise<void> {
      const [nextProfile, nextRecords, nextResults] = await Promise.all([
        window.eplusApi.listProfiles(accountId),
        window.eplusApi.listApplicationRecords(accountId),
        window.eplusApi.listLotteryResults(accountId)
      ]);
      if (active) {
        setProfile(nextProfile);
        setRecords(nextRecords);
        setResults(nextResults);
        setPassword(undefined);
      }
    }
    void load();
    return () => { active = false; };
  }, [props.account]);

  useEffect(() => {
    if (!password) return;
    const timeout = window.setTimeout(() => setPassword(undefined), 5_000);
    return () => window.clearTimeout(timeout);
  }, [password]);

  const filteredRecords = useMemo(() => records.filter((record) => record.eventTitle.toLowerCase().includes(recordQuery.toLowerCase()) && dateInRange(record.appliedAt, recordFrom, recordTo) && (recordDay === "all" || record.sessionOrDay?.toLowerCase().includes(recordDay))), [recordDay, recordFrom, recordQuery, recordTo, records]);
  const filteredResults = useMemo(() => results.filter((result) => result.eventTitle.toLowerCase().includes(resultQuery.toLowerCase()) && dateInRange(result.decidedAt, resultFrom, resultTo) && (resultKind === "all" || result.resultKind === resultKind)), [resultFrom, resultKind, resultQuery, resultTo, results]);

  if (!props.account) return null;

  async function showPassword(): Promise<void> {
    const accountId = props.account?.id;
    if (!accountId) return;
    const revealed = await window.eplusApi.revealPassword(accountId);
    setPassword(revealed.plaintext);
  }

  async function refreshResults(): Promise<void> {
    const accountId = props.account?.id;
    if (!accountId) return;
    setRefreshingResults(true);
    try {
      const refreshed = await window.eplusApi.refreshLotteryResults(accountId);
      setResults(refreshed);
      props.onMessage("抽选结果已刷新。");
    } finally {
      setRefreshingResults(false);
    }
  }

  async function refreshProfile(): Promise<void> {
    const accountId = props.account?.id;
    if (!accountId) return;
    setRefreshingProfile(true);
    try {
      const refreshed = await window.eplusApi.refreshProfile(accountId);
      if (refreshed.profile) setProfile((current) => ({ ...current, ...refreshed.profile } as AccountProfile));
      const [nextRecords, nextResults] = await Promise.all([window.eplusApi.listApplicationRecords(accountId), window.eplusApi.listLotteryResults(accountId)]);
      setRecords(nextRecords);
      setResults(nextResults);
      if (refreshed.status === "Ok") props.onMessage("账号资料已更新。");
      else if (refreshed.status === "Partial") props.onMessage(`账号资料部分更新：以下字段未获取到 - ${refreshed.failedFields.join("、") || "未知"}`);
      else props.onMessage(`账号资料更新失败（${refreshed.status}）：${refreshed.errorDetail ?? "未知原因"}`);
    } finally {
      setRefreshingProfile(false);
    }
  }

  return (
    <section className="panel-card account-detail" aria-label="账号详情">
      <div className="panel-head"><h2>{props.account.label || props.account.eplusEmail}</h2><div className="actions"><button type="button" className="icon-button" disabled={refreshingProfile} onClick={() => { void refreshProfile(); }}><RefreshCw size={15} />{refreshingProfile ? "正在刷新" : "刷新账号资料"}</button><button type="button" className="icon-button" onClick={props.onClose}>关闭详情</button></div></div>
      {refreshingProfile ? <ProgressBar compact label="正在刷新账号资料" /> : null}
      <div className="detail-grid">
        <article className="detail-block"><h3>个人资料</h3><dl className="profile-list"><div><dt>姓名</dt><dd>{profile?.name || props.account.label}</dd></div><div><dt>邮箱</dt><dd>{profile?.eplusEmail || props.account.eplusEmail}</dd></div><div><dt>电话</dt><dd>{maskPhone(profile?.phone)}</dd></div><div><dt>性别</dt><dd>{profile?.gender || "暂无资料"}</dd></div><div><dt>生日</dt><dd>{profile?.birthday || "暂无资料"}</dd></div><div><dt>地址</dt><dd>{profile?.address || "暂无资料"}</dd></div></dl><div className="password-row"><code>{password || "••••••••••••"}</code><button type="button" className="icon-button" onClick={() => { void showPassword(); }}>{password ? <><EyeOff size={15} />将在 5 秒后隐藏</> : <><Eye size={15} />显示密码</>}</button></div></article>
        <article className="detail-block"><h3>同行者</h3><div className="companion-groups"><div><strong>当前同行者</strong>{(profile?.companions ?? []).length > 0 ? (profile?.companions ?? []).map((companion) => <p key={`${companion.name}-${companion.memberId}`}>{companion.name}{companion.relationship ? ` · ${companion.relationship}` : ""}</p>) : <p className="muted">暂无当前同行者。</p>}</div><div><strong>历史同行者</strong>{(profile?.pastCompanions ?? []).length > 0 ? (profile?.pastCompanions ?? []).map((companion) => <p key={`${companion.name}-${companion.unboundAt}`}>{companion.name}{companion.unboundAt ? ` · ${companion.unboundAt}` : ""}</p>) : <p className="muted">暂无历史同行者。</p>}</div></div><div className="card-summary"><strong>已绑定信用卡</strong>{(profile?.creditCards ?? []).length > 0 ? (profile?.creditCards ?? []).map((card) => <p key={`${card.brand}-${card.last4}`}>{card.brand || "Card"} ···· {card.last4}</p>) : <p className="muted">暂无可用卡片摘要。卡号、CVV 和有效期不会保存。</p>}</div></article>
      </div>
      <article className="detail-block"><div className="panel-head"><h3>申込记录</h3></div><div className="filter-grid"><label>演出搜索<input value={recordQuery} onChange={(event) => setRecordQuery(event.target.value)} /></label><label>开始日期<input type="date" value={recordFrom} onChange={(event) => setRecordFrom(event.target.value)} /></label><label>结束日期<input type="date" value={recordTo} onChange={(event) => setRecordTo(event.target.value)} /></label><label>场次<select value={recordDay} onChange={(event) => setRecordDay(event.target.value)}><option value="all">全部场次</option><option value="day1">Day 1</option><option value="day2">Day 2</option></select></label></div><RecordTable records={filteredRecords} /></article>
      <article className="detail-block"><div className="panel-head"><h3>抽选结果</h3><button type="button" className="icon-button" disabled={refreshingResults} onClick={() => { void refreshResults(); }}><RefreshCw size={15} />{refreshingResults ? "正在刷新" : "刷新结果"}</button></div>{refreshingResults ? <ProgressBar compact label="正在刷新抽选结果" /> : null}<div className="filter-grid"><label>结果类型<select value={resultKind} onChange={(event) => setResultKind(event.target.value)}><option value="all">全部结果</option><option value="中選">中选</option><option value="落選">落选</option><option value="待通知">待通知</option><option value="取消">取消</option></select></label><label>演出搜索<input value={resultQuery} onChange={(event) => setResultQuery(event.target.value)} /></label><label>开始日期<input type="date" value={resultFrom} onChange={(event) => setResultFrom(event.target.value)} /></label><label>结束日期<input type="date" value={resultTo} onChange={(event) => setResultTo(event.target.value)} /></label></div><ResultTable results={filteredResults} /></article>
    </section>
  );
}

function RecordTable({ records }: { readonly records: readonly ApplicationRecord[] }) {
  return <div className="table-wrap"><table><thead><tr><th>演出</th><th>申请时间</th><th>场次</th><th>票种</th><th>状态</th></tr></thead><tbody>{records.map((record) => <tr key={record.id}><td>{record.eventTitle}</td><td>{record.appliedAt}</td><td>{record.sessionOrDay || "-"}</td><td>{record.ticketType} × {record.quantity}</td><td>{record.status}</td></tr>)}</tbody></table>{records.length === 0 ? <p className="empty-state">没有符合筛选条件的申込记录。</p> : null}</div>;
}

function ResultTable({ results }: { readonly results: readonly LotteryResultRecord[] }) {
  return <div className="table-wrap"><table><thead><tr><th>演出</th><th>结果</th><th>公布时间</th><th>付款截止</th></tr></thead><tbody>{results.map((result) => <tr key={result.id}><td>{result.eventTitle}</td><td>{result.resultKind}</td><td>{result.decidedAt || "-"}</td><td>{result.paymentDeadline || "-"}</td></tr>)}</tbody></table>{results.length === 0 ? <p className="empty-state">没有符合筛选条件的抽选结果。</p> : null}</div>;
}
