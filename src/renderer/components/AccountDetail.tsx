import { Eye, EyeOff } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { Account, AccountProfile, LotteryRecord } from "../../shared/ipc.js";

interface AccountDetailProps {
  readonly account: Account | undefined;
  readonly onClose: () => void;
  readonly onMessage: (message: string) => void;
}

function maskPhone(phone: string | undefined): string {
  if (!phone) return "暂无资料";
  return phone.replace(/(\d{2,3})\d+(\d{2})$/, "$1***$2");
}

export function AccountDetail(props: AccountDetailProps) {
  const [profile, setProfile] = useState<AccountProfile>();
  const [records, setRecords] = useState<readonly LotteryRecord[]>([]);
  const [password, setPassword] = useState<string>();
  const [recordQuery, setRecordQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");

  useEffect(() => {
    const account = props.account;
    if (!account) return;
    const accountId = account.id;
    let active = true;
    async function load(): Promise<void> {
      const [nextProfile, nextRecords] = await Promise.all([
        window.eplusApi.listProfiles(accountId),
        window.eplusApi.listLotteryRecords(accountId)
      ]);
      if (active) {
        setProfile(nextProfile);
        setRecords(nextRecords);
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

  const statusOptions = useMemo(() => Array.from(new Set(records.map((record) => record.status).filter(Boolean))), [records]);
  const filteredRecords = useMemo(
    () => records.filter((record) => record.tourName.toLowerCase().includes(recordQuery.toLowerCase()) && (statusFilter === "all" || record.status === statusFilter)),
    [recordQuery, records, statusFilter]
  );

  if (!props.account) return null;

  async function showPassword(): Promise<void> {
    const accountId = props.account?.id;
    if (!accountId) return;
    const revealed = await window.eplusApi.revealPassword(accountId);
    setPassword(revealed.plaintext);
  }

  return (
    <section className="panel-card account-detail" aria-label="账号详情">
      <div className="panel-head"><h2>{props.account.label || props.account.eplusEmail}</h2><div className="actions"><button type="button" className="icon-button" onClick={props.onClose}>关闭详情</button></div></div>
      <div className="detail-grid">
        <article className="detail-block"><h3>个人资料</h3><dl className="profile-list"><div><dt>姓名</dt><dd>{profile?.name || "暂无资料"}{profile?.nameKana ? ` （${profile.nameKana}）` : ""}</dd></div><div><dt>邮箱</dt><dd>{profile?.eplusEmail || props.account.eplusEmail}</dd></div><div><dt>电话</dt><dd>{maskPhone(profile?.phone)}</dd></div><div><dt>性别</dt><dd>{profile?.gender || "暂无资料"}</dd></div><div><dt>出生年份</dt><dd>{profile?.birthYear || "暂无资料"}</dd></div><div><dt>地址</dt><dd>{profile?.address || "暂无资料"}</dd></div>{profile?.harvestedAt ? <div><dt>采集时间</dt><dd>{profile.harvestedAt}</dd></div> : null}</dl><div className="password-row"><code>{password || "••••••••••••"}</code><button type="button" className="icon-button" onClick={() => { void showPassword(); }}>{password ? <><EyeOff size={15} />将在 5 秒后隐藏</> : <><Eye size={15} />显示密码</>}</button></div></article>
        <article className="detail-block"><h3>同行者</h3><div className="companion-groups"><div><strong>当前同行者</strong>{(profile?.companions ?? []).length > 0 ? (profile?.companions ?? []).map((companion) => <p key={`${companion.companionId ?? companion.name}`}>{companion.name}{companion.maskedEmail ? ` · ${companion.maskedEmail}` : ""}{companion.approvedAt ? ` · ${companion.approvedAt}` : ""}</p>) : <p className="muted">暂无当前同行者。</p>}</div></div><div className="card-summary"><strong>已绑定信用卡</strong>{(profile?.creditCards ?? []).length > 0 ? (profile?.creditCards ?? []).map((card) => <p key={`${card.creditCardId ?? `${card.brand}-${card.last4}`}`}>{card.brand || "Card"} ···· {card.last4}{card.expireMonth && card.expireYear ? ` · 有效期 ${card.expireMonth}/${card.expireYear}` : ""}</p>) : <p className="muted">暂无可用卡片摘要。卡号、CVV 和有效期不会保存。</p>}</div></article>
      </div>
      <article className="detail-block"><div className="panel-head"><h3>抽选记录</h3></div><div className="filter-grid"><label>演出搜索<input value={recordQuery} onChange={(event) => setRecordQuery(event.target.value)} /></label><label>状态<select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}><option value="all">全部状态</option>{statusOptions.map((status) => <option key={status} value={status}>{status}</option>)}</select></label></div><RecordTable records={filteredRecords} /></article>
    </section>
  );
}

function RecordTable({ records }: { readonly records: readonly LotteryRecord[] }) {
  return <div className="table-wrap"><table><thead><tr><th>演出</th><th>受付</th><th>申込时间</th><th>状态</th><th>说明</th></tr></thead><tbody>{records.map((record) => <tr key={record.id}><td>{record.tourName}</td><td>{record.receptionName || "-"}</td><td>{record.orderDatetime || record.eventDatetime || "-"}</td><td>{record.status}</td><td>{record.statusDetail || "-"}</td></tr>)}</tbody></table>{records.length === 0 ? <p className="empty-state">没有符合筛选条件的抽选记录。</p> : null}</div>;
}
