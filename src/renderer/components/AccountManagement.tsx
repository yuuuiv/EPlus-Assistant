import { FileUp, Trash2, Users } from "lucide-react";
import { useRef } from "react";
import type { Account, ImportHarvestResult } from "../../shared/ipc.js";
import { formatDateTime } from "../format.js";

interface AccountManagementProps {
  readonly accounts: readonly Account[];
  readonly harvestReport: ImportHarvestResult | undefined;
  readonly importingHarvest: boolean;
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
    <div className="workspace-heading"><div><p className="section-kicker">账号管理</p><h1 id="accounts-title">账号与身份</h1><p>导入浏览器采集脚本导出的资料文件即可添加或更新账号；文件里的账号若还没添加过会自动新建。</p></div><span className="badge badge-teal">{enabled} 个已启用</span></div>
    <section className="panel-card panel-card-hero"><div className="panel-head"><h2><FileUp size={16} />导入采集文件</h2><span className="muted">用「Eplus 会员信息采集器」用户脚本在浏览器里导出的 JSON</span></div><p className="muted">按文件内的邮箱自动匹配账号，首次导入会自动新建；采集拿不到真实登录密码，需要的话可以在账号详情里手动补充。</p><div className="actions"><input ref={fileInputRef} type="file" accept=".json,application/json" style={{ display: "none" }} onChange={handleHarvestFile} /><button className="primary" disabled={props.importingHarvest} onClick={() => fileInputRef.current?.click()}><FileUp size={16} />{props.importingHarvest ? "正在导入" : "选择采集文件"}</button>{props.harvestReport ? <span className="muted">{props.harvestReport.accountCreated ? "已自动新建账号，" : "已匹配到现有账号，"}导入抽选记录 {props.harvestReport.report.inserted} 条</span> : null}</div></section>
    <section className="panel-card"><div className="panel-head"><h2><Users size={16} />账号列表</h2><span className="muted">点击查看资料、同行者、信用卡和抽选记录</span></div><div className="table-wrap"><table><thead><tr><th>标签</th><th>邮箱</th><th>适配器</th><th className="th-nowrap">状态</th><th>资料最后更新</th><th aria-label="操作" /></tr></thead><tbody>{props.accounts.map((account) => <tr key={account.id}><td>{account.label}</td><td>{account.eplusEmail}</td><td>{account.mailProviderId}</td><td className="td-nowrap"><span className={account.enabled ? "badge badge-green" : "badge badge-gray"}>{account.enabled ? "启用" : "停用"}</span></td><td className="td-nowrap muted">{formatDateTime(account.profileUpdatedAt)}</td><td className="row-actions"><button className="icon-button" onClick={() => props.onSelect(account.id)} title="查看账号详情">详情</button><button className="icon-button danger" onClick={() => props.onDelete(account.id)} title="删除账号" aria-label={`删除 ${account.label || account.eplusEmail}`}><Trash2 size={15} /></button></td></tr>)}</tbody></table></div>{props.accounts.length === 0 ? <p className="empty-state">尚未添加账号。先导入采集文件。</p> : null}</section>
  </section>;
}
