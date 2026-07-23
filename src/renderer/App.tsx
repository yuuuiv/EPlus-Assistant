import { FolderOpen, RefreshCw, ShieldCheck, UsersRound } from "lucide-react";
import { useState, useEffect } from "react";
import type { AccountsOverview, DashboardState, ImportHarvestResult, ImportReport } from "../shared/ipc.js";
import { AccountDetail } from "./components/AccountDetail.js";
import { AccountManagement, type AccountForm } from "./components/AccountManagement.js";
import { AccountOverview } from "./components/AccountOverview.js";
import { LogViewer } from "./components/LogViewer.js";
import { Modal } from "./components/Modal.js";
import { Sidebar, type PanelId } from "./components/Sidebar.js";
import { StatusBanner } from "./components/StatusBanner.js";
import { ThemeToggle } from "./components/ThemeToggle.js";

const emptyState: DashboardState = { accounts: [], logs: [], dataDir: "" };
const defaultAccountForm: AccountForm = { label: "", eplusEmail: "", password: "", mailProviderId: "manual", tags: "", enabled: true, mailConfig: "{}" };

function lines(value: string): string[] { return value.split(/[\n,;]/).map((item) => item.trim()).filter(Boolean); }

export function App() {
  const [state, setState] = useState<DashboardState>(emptyState);
  const [overview, setOverview] = useState<AccountsOverview>();
  const [overviewLoading, setOverviewLoading] = useState(true);
  const [panel, setPanel] = useState<PanelId>("accounts");
  const [message, setMessage] = useState("");
  const [accountForm, setAccountForm] = useState<AccountForm>(defaultAccountForm);
  const [importKind, setImportKind] = useState<"csv" | "json">("csv");
  const [importText, setImportText] = useState("eplusEmail,password,label,tags,enabled\n");
  const [report, setReport] = useState<ImportReport>();
  const [harvestReport, setHarvestReport] = useState<ImportHarvestResult>();
  const [selectedAccountId, setSelectedAccountId] = useState<string>();
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());
  const selectedAccount = state.accounts.find((account) => account.id === selectedAccountId);

  async function refresh(): Promise<void> {
    const [snapshot, nextOverview] = await Promise.all([window.eplusApi.getState(), window.eplusApi.getAccountsOverview()]);
    setState(snapshot);
    setOverview(nextOverview);
    setOverviewLoading(false);
  }
  useEffect(() => { void refresh(); }, []);

  async function runAction(action: () => Promise<void>): Promise<void> {
    try {
      await action();
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      setMessage(`操作失败：${text}`);
    }
  }
  function withPending<Args extends unknown[]>(key: string, action: (...args: Args) => Promise<void>): (...args: Args) => void {
    return (...args: Args) => {
      if (pending.has(key)) return;
      setPending((current) => new Set(current).add(key));
      void runAction(() => action(...args)).finally(() => setPending((current) => { const next = new Set(current); next.delete(key); return next; }));
    };
  }

  const addAccount = withPending("addAccount", async () => {
    const created = await window.eplusApi.addAccount({ ...accountForm, tags: lines(accountForm.tags), mailConfig: JSON.parse(accountForm.mailConfig || "{}") });
    setAccountForm(defaultAccountForm);
    setMessage(`已添加账号：${created.eplusEmail}`);
    await refresh();
  });
  const importAccounts = withPending("importAccounts", async () => {
    const result = await window.eplusApi.importAccounts({ kind: importKind, text: importText });
    setReport(result);
    setMessage(`导入完成：新增 ${result.inserted}，更新 ${result.updated}`);
    await refresh();
  });
  const importHarvestText = withPending<[string]>("importHarvest", async (text) => {
    const payload = JSON.parse(text);
    const result = await window.eplusApi.importHarvest({ payload });
    setHarvestReport(result);
    setMessage(`采集文件导入完成：${result.accountCreated ? "已新建账号" : "已匹配现有账号"}`);
    setSelectedAccountId(result.accountId);
    await refresh();
  });

  let content: React.ReactNode;
  switch (panel) {
    case "accounts":
      content = <AccountManagement
        accounts={state.accounts}
        form={accountForm}
        importKind={importKind}
        importText={importText}
        report={report}
        harvestReport={harvestReport}
        adding={pending.has("addAccount")}
        importing={pending.has("importAccounts")}
        importingHarvest={pending.has("importHarvest")}
        onFormChange={setAccountForm}
        onImportKindChange={setImportKind}
        onImportTextChange={setImportText}
        onAdd={addAccount}
        onImport={importAccounts}
        onImportHarvestText={importHarvestText}
        onSelect={setSelectedAccountId}
        onDelete={(id) => runAction(async () => { await window.eplusApi.deleteAccount(id); await refresh(); })}
      />;
      break;
    case "overview":
      content = <AccountOverview overview={overview} loading={overviewLoading} />;
      break;
    case "logs":
      content = <LogViewer logs={state.logs} />;
      break;
  }

  return <div className="app-shell">
    <header className="topbar">
      <div><p className="eyebrow">Eplus 账号管理器</p><h1>本地账号管理器</h1></div>
      <div className="topbar-actions">
        <ThemeToggle />
        <button className="icon-button" onClick={() => { void refresh(); }} title="重新读取本地数据"><RefreshCw size={16} />刷新</button>
        <button className="icon-button" onClick={() => { void window.eplusApi.openDataFolder(); }} title="打开本地数据目录"><FolderOpen size={16} />数据目录</button>
      </div>
    </header>
    <div className="workbench">
      <Sidebar activePanel={panel} onPanelChange={setPanel} />
      <main className="workspace" id="main-content">
        <StatusBanner message={message} onDismiss={() => setMessage("")} />
        {content}
      </main>
      {selectedAccount ? <Modal title={selectedAccount.label || selectedAccount.eplusEmail} subtitle="账号详情" onClose={() => setSelectedAccountId(undefined)} wide><AccountDetail account={selectedAccount} /></Modal> : null}
    </div>
    <footer className="status-bar">
      <span><UsersRound size={14} />账号 {state.accounts.length}</span>
      <span><ShieldCheck size={14} />本机加密存储</span>
    </footer>
  </div>;
}
