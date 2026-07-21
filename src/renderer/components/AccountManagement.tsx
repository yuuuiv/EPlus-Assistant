import { BadgePlus, FileDown, Trash2, Upload, Users } from "lucide-react";
import type { Account, ImportReport } from "../../shared/ipc.js";

export interface AccountForm { label: string; eplusEmail: string; password: string; mailProviderId: string; tags: string; enabled: boolean; mailConfig: string; }
interface AccountManagementProps {
  readonly accounts: readonly Account[];
  readonly form: AccountForm;
  readonly importKind: "csv" | "json";
  readonly importText: string;
  readonly report: ImportReport | undefined;
  readonly onFormChange: (form: AccountForm) => void;
  readonly onImportKindChange: (kind: "csv" | "json") => void;
  readonly onImportTextChange: (value: string) => void;
  readonly onAdd: () => void;
  readonly onImport: () => void;
  readonly onSelect: (accountId: string) => void;
  readonly onDelete: (accountId: string) => void;
}

export function AccountManagement(props: AccountManagementProps) {
  const enabled = props.accounts.filter((account) => account.enabled).length;
  return <section className="workspace-panel" aria-labelledby="accounts-title">
    <div className="workspace-heading"><div><p className="section-kicker">账号管理</p><h1 id="accounts-title">账号与身份</h1><p>添加、导入和审阅所有参与抽选的 Eplus 账号。</p></div><span className="badge badge-teal">{enabled} 个已启用</span></div>
    <div className="panel-layout-two">
      <section className="panel-card"><div className="panel-head"><h2><BadgePlus size={16} />新增账号</h2><span className="muted">密码仅在本机加密保存</span></div><div className="form-grid"><label>显示名称<input value={props.form.label} placeholder="例如：东京场-01" onChange={(event) => props.onFormChange({ ...props.form, label: event.target.value })} /></label><label>Eplus 邮箱<input value={props.form.eplusEmail} placeholder="name@example.com" onChange={(event) => props.onFormChange({ ...props.form, eplusEmail: event.target.value })} /></label><label>密码<input type="password" value={props.form.password} placeholder="输入登录密码" onChange={(event) => props.onFormChange({ ...props.form, password: event.target.value })} /></label><label>邮件适配器标识<input value={props.form.mailProviderId} placeholder="global-verification-mailbox" onChange={(event) => props.onFormChange({ ...props.form, mailProviderId: event.target.value })} /></label><label className="full">标签<input value={props.form.tags} placeholder="用逗号分隔，例如：东京, 第一天" onChange={(event) => props.onFormChange({ ...props.form, tags: event.target.value })} /></label><label className="full">邮件配置 JSON<textarea rows={3} value={props.form.mailConfig} onChange={(event) => props.onFormChange({ ...props.form, mailConfig: event.target.value })} /></label></div><div className="actions"><button className="primary" onClick={props.onAdd}><BadgePlus size={16} />添加账号</button></div></section>
      <section className="panel-card"><div className="panel-head"><h2><Upload size={16} />批量导入</h2><div className="segmented"><button className={props.importKind === "csv" ? "seg active" : "seg"} onClick={() => props.onImportKindChange("csv")}>CSV</button><button className={props.importKind === "json" ? "seg active" : "seg"} onClick={() => props.onImportKindChange("json")}>JSON</button></div></div><label>导入内容<textarea rows={9} value={props.importText} placeholder="粘贴 CSV 或 JSON 内容" onChange={(event) => props.onImportTextChange(event.target.value)} /></label><div className="actions"><button className="primary" onClick={props.onImport}><FileDown size={16} />导入账号</button>{props.report ? <span className="muted">新增 {props.report.inserted}，更新 {props.report.updated}，错误 {props.report.errors.length}</span> : null}</div>{props.report?.errors.length ? <div className="inline-list">{props.report.errors.map((item) => <div key={`${item.row}-${item.message}`} className="inline-error">第 {item.row} 行：{item.message}</div>)}</div> : null}</section>
    </div>
    <section className="panel-card"><div className="panel-head"><h2><Users size={16} />账号列表</h2><span className="muted">点击查看资料、同行者、申込记录和结果</span></div><div className="table-wrap"><table><thead><tr><th>标签</th><th>邮箱</th><th>适配器</th><th>状态</th><th aria-label="操作" /></tr></thead><tbody>{props.accounts.map((account) => <tr key={account.id}><td>{account.label}</td><td>{account.eplusEmail}</td><td>{account.mailProviderId}</td><td><span className={account.enabled ? "badge badge-green" : "badge badge-gray"}>{account.enabled ? "启用" : "停用"}</span></td><td className="row-actions"><button className="icon-button" onClick={() => props.onSelect(account.id)} title="查看账号详情">详情</button><button className="icon-button danger" onClick={() => props.onDelete(account.id)} title="删除账号" aria-label={`删除 ${account.label || account.eplusEmail}`}><Trash2 size={15} /></button></td></tr>)}</tbody></table></div>{props.accounts.length === 0 ? <p className="empty-state">尚未添加账号。先新增一个账号或导入名单。</p> : null}</section>
  </section>;
}
