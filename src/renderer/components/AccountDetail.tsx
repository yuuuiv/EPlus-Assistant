import { CreditCard, Eye, EyeOff, KeyRound } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { Account, AccountProfile, LotteryRecord } from "../../shared/ipc.js";
import { CopyButton } from "./CopyButton.js";
import { formatDateTime, toHalfWidth } from "../format.js";

interface AccountDetailProps {
  readonly account: Account | undefined;
}

/** eplus addresses read as "〒postal prefecture rest" - broken onto three lines (postal /
 *  prefecture / the rest) rather than one long wrapping run, per how a Japanese address is
 *  actually read. Falls back to one line if the string doesn't have the expected shape. */
function addressLines(address: string): string[] {
  const [postal, prefecture, ...rest] = address.split(" ");
  if (!prefecture) return [address];
  const remainder = rest.join(" ");
  return remainder ? [postal, prefecture, remainder] : [postal, prefecture];
}

/** Not the card networks' real marks (no logo assets are bundled, and reproducing them would be
 *  a trademark risk) - just a colour-coded generic-card badge so the brand reads at a glance
 *  instead of as a wall of plain text. */
function cardBrandAccent(brand: string): string {
  const normalized = brand.toLowerCase();
  if (normalized.includes("visa")) return "#2f5fc4";
  if (normalized.includes("master")) return "#d9822b";
  if (normalized.includes("jcb")) return "#1f8a4c";
  if (normalized.includes("amex") || normalized.includes("american")) return "#2f95b4";
  if (normalized.includes("diners")) return "#8a5fc4";
  return "#5b6472";
}

export function AccountDetail(props: AccountDetailProps) {
  const [profile, setProfile] = useState<AccountProfile>();
  const [records, setRecords] = useState<readonly LotteryRecord[]>([]);
  const [password, setPassword] = useState<string>();
  const [recordQuery, setRecordQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [editingPassword, setEditingPassword] = useState(false);
  const [passwordInput, setPasswordInput] = useState("");
  const [savingPassword, setSavingPassword] = useState(false);

  useEffect(() => {
    const account = props.account;
    setEditingPassword(false);
    setPasswordInput("");
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

  const statusOptions = useMemo(() => Array.from(new Set(records.map((record) => record.status).filter(Boolean))), [records]);
  const filteredRecords = useMemo(
    () => records.filter((record) => record.tourName.toLowerCase().includes(recordQuery.toLowerCase()) && (statusFilter === "all" || record.status === statusFilter)),
    [recordQuery, records, statusFilter]
  );

  if (!props.account) return null;
  const email = profile?.eplusEmail || props.account.eplusEmail;

  async function showPassword(): Promise<void> {
    const accountId = props.account?.id;
    if (!accountId) return;
    const revealed = await window.eplusApi.revealPassword(accountId);
    setPassword(revealed.plaintext);
  }

  async function savePassword(): Promise<void> {
    const accountId = props.account?.id;
    if (!accountId || !passwordInput) return;
    setSavingPassword(true);
    try {
      await window.eplusApi.setAccountPassword({ accountId, password: passwordInput });
      setEditingPassword(false);
      setPasswordInput("");
    } finally {
      setSavingPassword(false);
    }
  }

  return (
    <div className="account-detail">
      <div className="detail-grid">
        <article className="detail-block">
          <h3>个人资料</h3>
          <dl className="profile-list">
            <div><dt>姓名</dt><dd>{profile?.name ? (profile.nameKana ? <ruby className="name-ruby">{profile.name}<rt>{profile.nameKana}</rt></ruby> : profile.name) : "暂无资料"}</dd></div>
            <div><dt>邮箱</dt><dd className="value-with-copy"><span>{email}</span><CopyButton value={email} label="邮箱" /></dd></div>
            <div><dt>电话</dt><dd className="value-with-copy"><span>{profile?.phone || "暂无资料"}</span><CopyButton value={profile?.phone ?? ""} label="电话" disabled={!profile?.phone} /></dd></div>
            <div><dt>性别</dt><dd>{profile?.gender || "暂无资料"}</dd></div>
            <div><dt>出生年份</dt><dd>{profile?.birthYear || "暂无资料"}</dd></div>
            <div><dt>地址</dt><dd>{profile?.address ? <span className="address-lines">{addressLines(profile.address).map((line, index) => <span key={index}>{line}</span>)}</span> : "暂无资料"}</dd></div>
            {profile?.harvestedAt ? <div><dt>资料最后更新</dt><dd>{formatDateTime(profile.harvestedAt)}</dd></div> : null}
          </dl>
          <div className="password-panel">
            <div className="password-panel-row">
              <div className="password-value">
                <span className="password-panel-label">登录密码</span>
                <code>{password || "••••••••••••"}</code>
              </div>
              <div className="password-actions">
                <CopyButton value={password ?? ""} label="密码" disabled={!password} />
                <button type="button" className="icon-button" onClick={() => { if (password) setPassword(undefined); else void showPassword(); }}>{password ? <><EyeOff size={15} />隐藏密码</> : <><Eye size={15} />显示密码</>}</button>
                <button type="button" className={editingPassword ? "icon-button active" : "icon-button"} onClick={() => { setEditingPassword((current) => !current); setPasswordInput(""); }}><KeyRound size={15} />编辑密码</button>
              </div>
            </div>
            <div className={editingPassword ? "password-edit-form open" : "password-edit-form"}>
              <div>
                <div className="password-edit-form-inner">
                  <input type="password" value={passwordInput} placeholder="输入真实登录密码" onChange={(event) => setPasswordInput(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void savePassword(); }} />
                  <button type="button" className="primary" disabled={savingPassword || !passwordInput} onClick={() => { void savePassword(); }}>{savingPassword ? "正在保存" : "保存"}</button>
                  <button type="button" className="icon-button" onClick={() => { setEditingPassword(false); setPasswordInput(""); }}>取消</button>
                </div>
              </div>
            </div>
          </div>
        </article>
        <article className="detail-block"><h3>同行者</h3><div className="companion-groups"><div><strong>当前同行者</strong>{(profile?.companions ?? []).length > 0 ? (profile?.companions ?? []).map((companion, index) => <div key={`${companion.companionId ?? companion.name}`} className="companion-card">
              <span className="ranking-index">{index + 1}</span>
              <div className="companion-info">
                <strong>{companion.name}</strong>
                {companion.maskedEmail ? <span className="companion-email">{companion.maskedEmail}</span> : null}
                {companion.approvedAt ? <span className="companion-time">绑定于 {companion.approvedAt}</span> : null}
              </div>
            </div>) : <p className="muted">暂无当前同行者。</p>}</div></div><div className="card-summary"><strong>已绑定信用卡</strong>{(profile?.creditCards ?? []).length > 0 ? (profile?.creditCards ?? []).map((card) => {
              const brand = toHalfWidth(card.brand || "Card");
              const accent = cardBrandAccent(brand);
              return <p key={`${card.creditCardId ?? `${card.brand}-${card.last4}`}`} className="card-row">
                <span className="card-brand-badge" style={{ color: accent, background: `color-mix(in srgb, ${accent} 16%, transparent)` }}><CreditCard size={13} />{brand}</span>
                <span>···· {card.last4}{card.expireMonth && card.expireYear ? ` · 有效期 ${card.expireMonth}/${card.expireYear}` : ""}</span>
              </p>;
            }) : <p className="muted">暂无可用卡片摘要。卡号、CVV 和有效期不会保存。</p>}</div></article>
      </div>
      <article className="detail-block"><div className="panel-head"><h3>抽选记录</h3></div><div className="filter-grid"><label>演出搜索<input value={recordQuery} onChange={(event) => setRecordQuery(event.target.value)} /></label><label>状态<select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}><option value="all">全部状态</option>{statusOptions.map((status) => <option key={status} value={status}>{status}</option>)}</select></label></div><RecordTable records={filteredRecords} /></article>
    </div>
  );
}

function RecordTable({ records }: { readonly records: readonly LotteryRecord[] }) {
  return <div className="table-wrap"><table><thead><tr><th>演出</th><th>受付</th><th>申込时间</th><th className="th-nowrap">状态</th><th>说明</th></tr></thead><tbody>{records.map((record) => <tr key={record.id}><td>{record.tourName}</td><td className="td-nowrap">{record.receptionName || "-"}</td><td className="td-nowrap">{record.orderDatetime || record.eventDatetime || "-"}</td><td className="td-nowrap">{record.status}</td><td>{record.statusDetail || "-"}</td></tr>)}</tbody></table>{records.length === 0 ? <p className="empty-state">没有符合筛选条件的抽选记录。</p> : null}</div>;
}
