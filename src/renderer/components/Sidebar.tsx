import { Activity, BookOpenText, MailCheck, Network, ScrollText, Settings2, Tickets, UsersRound } from "lucide-react";

const navigationGroups = [
  { label: "账号管理", items: [{ id: "accounts", label: "账号列表", icon: UsersRound }] },
  { label: "演出与任务", items: [{ id: "events", label: "演出快照", icon: Tickets }, { id: "tasks", label: "创建任务", icon: BookOpenText }, { id: "monitor", label: "任务监控", icon: Activity }] },
  { label: "设置", items: [{ id: "mailbox", label: "邮箱验证码", icon: MailCheck }, { id: "network", label: "网络设置", icon: Network }, { id: "logs", label: "日志", icon: ScrollText }] }
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
