import { PieChart, ScrollText, Settings2, TrendingUp, UsersRound } from "lucide-react";

const navigationGroups = [
  { label: "账号管理", items: [
    { id: "accounts", label: "账号列表", icon: UsersRound },
    { id: "overview", label: "账号总览", icon: PieChart },
    { id: "analytics", label: "深度分析", icon: TrendingUp }
  ] },
  { label: "设置", items: [{ id: "logs", label: "日志", icon: ScrollText }] }
] as const;

export type PanelId = (typeof navigationGroups)[number]["items"][number]["id"];

interface SidebarProps {
  readonly activePanel: PanelId;
  readonly onPanelChange: (panel: PanelId) => void;
}

export function Sidebar(props: SidebarProps) {
  return <aside className="sidebar" aria-label="工作台导航">
    <nav className="sidebar-nav">
      {navigationGroups.map((group) => <section key={group.label} className="sidebar-group" aria-label={group.label}>
        <h2>{group.label}</h2>
        {group.items.map((item) => {
          const Icon = item.icon;
          const active = item.id === props.activePanel;
          return <button key={item.id} className={active ? "sidebar-item active" : "sidebar-item"} onClick={() => props.onPanelChange(item.id)} aria-current={active ? "page" : undefined} title={`打开${item.label}`}><Icon size={17} aria-hidden="true" />{item.label}</button>;
        })}
      </section>)}
    </nav>
    <div className="sidebar-foot"><Settings2 size={15} aria-hidden="true" /><span>本机加密存储</span></div>
  </aside>;
}
