import { BadgePlus, FileDown, FileUp, Trash2, Upload, Users } from "lucide-react";
import { useRef } from "react";
import type { Account, ImportHarvestResult, ImportReport } from "../../shared/ipc.js";

export interface AccountForm { label: string; eplusEmail: string; password: string; mailProviderId: string; tags: string; enabled: boolean; mailConfig: string; }
interface AccountManagementProps {
  readonly accounts: readonly Account[];
  readonly form: AccountForm;
  readonly importKind: "csv" | "json";
  readonly importText: string;
  readonly report: ImportReport | undefined;
  readonly harvestReport: ImportHarvestResult | undefined;
  readonly adding: boolean;
  readonly importing: boolean;
  readonly importingHarvest: boolean;
  readonly onFormChange: (form: AccountForm) => void;
  readonly onImportKindChange: (kind: "csv" | "json") => void;
  readonly onImportTextChange: (value: string) => void;
  readonly onAdd: () => void;
  readonly onImport: () => void;
  readonly onImportHarvestText: (text: string) => void;
  readonly onSelect: (accountId: string) => void;
  readonly onDelete: (accountId: string) => void;
}

export function AccountManagement(props: AccountManagementProps) {
  const enabled = props.accounts.filter((account) => account.enabled).length;
  const fileInputRef = useRef<HTMLInputElement>(null);

  function handleHarvestFile(event: React.ChangeEvent<HTMLInputElement>): void {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string") props.onImportHarvestText(reader.result);
    };
    reader.readAsText(file);
  }

  return <section className="workspace-panel" aria-labelledby="accounts-title">
    <div className="workspace-heading"><div><p className="section-kicker">账号管理</p><h1 id="accounts-title">账号与身份</h1><p>添加账号、导入登录名单，或导入浏览器采集脚本导出的资料文件。</p></div><span className="badge badge-teal">{enabled} 个已启用</span></div>
    <div className="panel-layout-two">
      <section className="panel-card"><div className="panel-head"><h2><BadgePlus size={16} />新增账号</h2><span className="muted">密码仅在本机加密保存</span></div><div className="form-grid"><label>显示名称<input value={props.form.label} placeholder="例如：东京场-01" onChange={(event) => props.onFormChange({ ...props.form, label: event.target.value })} /></label><label>Eplus 邮箱<input value={props.form.eplusEmail} placeholder="name@example.com" onChange={(event) => props.onFormChange({ ...props.form, eplusEmail: event.target.value })} /></label><label>密码<input type="password" value={props.form.password} placeholder="输入登录密码" onChange={(event) => props.onFormChange({ ...props.form, password: event.target.value })} /></label><label>邮件适配器标识<input value={props.form.mailProviderId} placeholder="manual" onChange={(event) => props.onFormChange({ ...props.form, mailProviderId: event.target.value })} /></label><label className="full">标签<input value={props.form.tags} placeholder="用逗号分隔，例如：东京, 第一天" onChange={(event) => props.onFormChange({ ...props.form, tags: event.target.value })} /></label></div><div className="actions"><button className="primary" disabled={props.adding} onClick={props.onAdd}><BadgePlus size={16} />{props.adding ? "正在添加" : "添加账号"}</button></div></section>
      <section className="panel-card"><div className="panel-head"><h2><Upload size={16} />批量导入登录名单</h2><div className="segmented"><button className={props.importKind === "csv" ? "seg active" : "seg"} onClick={() => props.onImportKindChange("csv")}>CSV</button><button className={props.importKind === "json" ? "seg active" : "seg"} onClick={() => props.onImportKindChange("json")}>JSON</button></div></div><label>导入内容<textarea rows={6} value={props.importText} placeholder="粘贴 CSV 或 JSON 内容" onChange={(event) => props.onImportTextChange(event.target.value)} /></label><div className="actions"><button className="primary" disabled={props.importing} onClick={props.onImport}><FileDown size={16} />{props.importing ? "正在导入" : "导入账号"}</button>{props.report ? <span className="muted">新增 {props.report.inserted}，更新 {props.report.updated}，错误 {props.report.errors.length}</span> : null}</div>{props.report?.errors.length ? <div className="inline-list">{props.report.errors.map((item) => <div key={`${item.row}-${item.message}`} className="inline-error">第 {item.row} 行：{item.message}</div>)}</div> : null}</section>
    </div>
    <section className="panel-card"><div className="panel-head"><h2><FileUp size={16} />导入采集文件</h2><span className="muted">用「Eplus 会员信息采集器」用户脚本在浏览器里导出的 JSON</span></div><p className="muted">按文件内的邮箱自动匹配账号；若账号不存在会新建一个仅用于查看资料的账号（不含真实登录密码）。</p><div className="actions"><input ref={fileInputRef} type="file" accept=".json,application/json" style={{ display: "none" }} onChange={handleHarvestFile} /><button className="primary" disabled={props.importingHarvest} onClick={() => fileInputRef.current?.click()}><FileUp size={16} />{props.importingHarvest ? "正在导入" : "选择采集文件"}</button>{props.harvestReport ? <span className="muted">{props.harvestReport.accountCreated ? "已新建账号，" : "已匹配到现有账号，"}导入抽选记录 {props.harvestReport.report.inserted} 条</span> : null}</div></section>
    <section className="panel-card"><div className="panel-head"><h2><Users size={16} />账号列表</h2><span className="muted">点击查看资料、同行者、信用卡和抽选记录</span></div><div className="table-wrap"><table><thead><tr><th>标签</th><th>邮箱</th><th>适配器</th><th>状态</th><th aria-label="操作" /></tr></thead><tbody>{props.accounts.map((account) => <tr key={account.id}><td>{account.label}</td><td>{account.eplusEmail}</td><td>{account.mailProviderId}</td><td><span className={account.enabled ? "badge badge-green" : "badge badge-gray"}>{account.enabled ? "启用" : "停用"}</span></td><td className="row-actions"><button className="icon-button" onClick={() => props.onSelect(account.id)} title="查看账号详情">详情</button><button className="icon-button danger" onClick={() => props.onDelete(account.id)} title="删除账号" aria-label={`删除 ${account.label || account.eplusEmail}`}><Trash2 size={15} /></button></td></tr>)}</tbody></table></div>{props.accounts.length === 0 ? <p className="empty-state">尚未添加账号。先新增一个账号，或直接导入采集文件。</p> : null}</section>
  </section>;
}
