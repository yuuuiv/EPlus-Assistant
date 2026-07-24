import { FolderOpen, RefreshCw, ShieldCheck, UsersRound } from "lucide-react";
import { useState, useEffect } from "react";
import { Toaster, toast } from "sonner";
import type { AccountsOverview, DashboardState } from "../shared/ipc.js";
import { AccountDetail } from "./components/AccountDetail.js";
import { AccountManagement } from "./components/AccountManagement.js";
import { AccountOverview } from "./components/AccountOverview.js";
import { AdvancedAnalytics } from "./components/AdvancedAnalytics.js";
import { LogViewer } from "./components/LogViewer.js";
import { Modal } from "./components/Modal.js";
import { Sidebar, type PanelId } from "./components/Sidebar.js";
import { ThemeToggle } from "./components/ThemeToggle.js";
import { useThemeMode } from "./theme.js";

const emptyState: DashboardState = { accounts: [], logs: [], dataDir: "" };

/** Same fixed categorical order used elsewhere in the app (e.g. the overview's gender chart) -
 *  a stable per-account accent so the detail drawer's header has one deliberate splash of
 *  color instead of reading as flat as the rest of the (intentionally quiet) UI. */
const AVATAR_ACCENTS = ["--primary", "--info", "--warning", "--success"] as const;
function avatarAccent(seed: string): string {
  let hash = 0;
  for (let index = 0; index < seed.length; index += 1) hash = (hash * 31 + seed.charCodeAt(index)) >>> 0;
  return AVATAR_ACCENTS[hash % AVATAR_ACCENTS.length];
}

export function App() {
  const [state, setState] = useState<DashboardState>(emptyState);
  const [overview, setOverview] = useState<AccountsOverview>();
  const [overviewLoading, setOverviewLoading] = useState(true);
  const [panel, setPanel] = useState<PanelId>("accounts");
  const [selectedAccountId, setSelectedAccountId] = useState<string>();
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());
  const selectedAccount = state.accounts.find((account) => account.id === selectedAccountId);
  const themeMode = useThemeMode();

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
      toast.error(`操作失败：${text}`);
    }
  }
  function withPending<Args extends unknown[]>(key: string, action: (...args: Args) => Promise<void>): (...args: Args) => void {
    return (...args: Args) => {
      if (pending.has(key)) return;
      setPending((current) => new Set(current).add(key));
      void runAction(() => action(...args)).finally(() => setPending((current) => { const next = new Set(current); next.delete(key); return next; }));
    };
  }

  const importHarvestTexts = withPending<[string[]]>("importHarvest", async (texts) => {
    let accountsCreated = 0;
    let recordsInserted = 0;
    let lastAccountId: string | undefined;
    for (const text of texts) {
      const payload = JSON.parse(text);
      const result = await window.eplusApi.importHarvest({ payload });
      if (result.accountCreated) accountsCreated += 1;
      recordsInserted += result.report.inserted;
      lastAccountId = result.accountId;
    }
    toast.success(texts.length === 1
      ? `采集文件导入完成：${accountsCreated > 0 ? "已新建账号" : "已匹配现有账号"}，导入抽选记录 ${recordsInserted} 条`
      : `采集文件导入完成：共 ${texts.length} 个文件，新建 ${accountsCreated} 个账号，导入抽选记录 ${recordsInserted} 条`);
    if (texts.length === 1) setSelectedAccountId(lastAccountId);
    await refresh();
  });

  let content: React.ReactNode;
  switch (panel) {
    case "accounts":
      content = <AccountManagement
        accounts={state.accounts}
        importingHarvest={pending.has("importHarvest")}
        onImportHarvestTexts={importHarvestTexts}
        onSelect={setSelectedAccountId}
        onDelete={(id) => runAction(async () => { await window.eplusApi.deleteAccount(id); await refresh(); })}
      />;
      break;
    case "overview":
      content = <AccountOverview overview={overview} loading={overviewLoading} />;
      break;
    case "analytics":
      content = <AdvancedAnalytics overview={overview} loading={overviewLoading} />;
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
        {content}
      </main>
      <Modal
        open={!!selectedAccount}
        title={selectedAccount ? <span className="account-title">
          <span className="account-avatar" style={{ background: `var(${avatarAccent(selectedAccount.id)})`, color: "var(--primary-text)" }}>
            {(selectedAccount.label || selectedAccount.eplusEmail).slice(0, 1).toUpperCase()}
          </span>
          <span>{selectedAccount.label || selectedAccount.eplusEmail}</span>
        </span> : undefined}
        subtitle="账号详情"
        onClose={() => setSelectedAccountId(undefined)}
        wide
      ><AccountDetail account={selectedAccount} /></Modal>
    </div>
    <footer className="status-bar">
      <span><UsersRound size={14} />账号 {state.accounts.length}</span>
      <span><ShieldCheck size={14} />本机加密存储</span>
    </footer>
    <Toaster theme={themeMode} position="top-center" richColors closeButton />
  </div>;
}
