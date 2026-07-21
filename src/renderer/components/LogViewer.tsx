import { CircleAlert } from "lucide-react";
import { useMemo, useState } from "react";
import type { AuditLog } from "../../shared/ipc.js";

interface LogViewerProps {
  readonly logs: readonly AuditLog[];
}

export function LogViewer(props: LogViewerProps) {
  const [level, setLevel] = useState<"all" | "info" | "warn" | "error">("all");
  const logs = useMemo(() => level === "all" ? props.logs : props.logs.filter((item) => item.level === level), [level, props.logs]);
  return <section className="workspace-panel" aria-labelledby="logs-title">
    <div className="workspace-heading"><div><p className="section-kicker">审计轨迹</p><h1 id="logs-title">日志</h1><p>查看工作台中的操作记录和错误摘要。</p></div><span className="badge badge-gray">{logs.length} 条</span></div>
    <div className="panel-card log-viewer">
      <div className="panel-head"><h2><CircleAlert size={16} />日志筛选</h2><select aria-label="按级别筛选日志" value={level} onChange={(event) => setLevel(event.target.value as typeof level)}><option value="all">全部级别</option><option value="info">信息</option><option value="warn">提示</option><option value="error">错误</option></select></div>
      <div className="stack log-stack">{logs.map((log) => <div key={log.id} className={`log ${log.level}`}><span>{log.createdAt}</span><strong>{log.message}</strong></div>)}</div>
      {logs.length === 0 ? <p className="empty-state">当前筛选条件下没有日志。</p> : null}
    </div>
  </section>;
}
