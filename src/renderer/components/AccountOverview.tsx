import { BarChart3, Download, Flame, History, ImageDown, PercentCircle, PieChart, Ticket, Trophy, Users } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import type { AccountOverviewEntry, AccountsOverview, LotteryOutcome, LotteryRecord, PerformanceHistory, TopPerformanceEntry } from "../../shared/ipc.js";
import { csvCell, downloadSvgAsPng, downloadTextFile, formatDateTime, formatPercent } from "../format.js";
import { useThemeColors } from "../useThemeColors.js";
import { DonutChart, RankedBarChart, SegmentBarChart, type RankedItem, type Segment } from "./Charts.js";
import { Modal } from "./Modal.js";
import { SortableFilterableTable, type Column } from "./SortableFilterableTable.js";

type SegmentChartMode = "bar" | "pie";

function SegmentChartModeToggle(props: { readonly mode: SegmentChartMode; readonly onChange: (mode: SegmentChartMode) => void }) {
  return <div className="segmented" role="group" aria-label="切换图表类型">
    <button className={props.mode === "bar" ? "seg active" : "seg"} onClick={() => props.onChange("bar")} title="条形图"><BarChart3 size={14} /></button>
    <button className={props.mode === "pie" ? "seg active" : "seg"} onClick={() => props.onChange("pie")} title="饼图"><PieChart size={14} /></button>
  </div>;
}

interface AccountOverviewProps {
  readonly overview: AccountsOverview | undefined;
  readonly loading: boolean;
}

function outcomeBadgeClass(outcome: LotteryOutcome): string {
  if (outcome === "won") return "badge badge-green";
  if (outcome === "lost") return "badge badge-red";
  return "badge badge-gray";
}

function outcomeLabel(status: string, outcome: LotteryOutcome): string {
  return status || (outcome === "pending" ? "未知" : outcome);
}

const OUTCOME_LABEL: Record<LotteryOutcome, string> = { won: "当选", lost: "落选", pending: "其他/待定" };

export function AccountOverview(props: AccountOverviewProps) {
  const [modalAccount, setModalAccount] = useState<AccountOverviewEntry>();
  const [genderChartMode, setGenderChartMode] = useState<SegmentChartMode>("bar");
  const [outcomeChartMode, setOutcomeChartMode] = useState<SegmentChartMode>("bar");
  const colors = useThemeColors();
  const genderChartRef = useRef<SVGSVGElement>(null);
  const outcomeChartRef = useRef<SVGSVGElement>(null);
  const winRateChartRef = useRef<SVGSVGElement>(null);

  if (props.loading || !props.overview) {
    return <section className="workspace-panel" aria-labelledby="overview-title">
      <div className="workspace-heading"><div><p className="section-kicker">账号总览</p><h1 id="overview-title">统计与中选情况</h1></div></div>
      <p className="empty-state">正在加载统计数据…</p>
    </section>;
  }

  const overview = props.overview;
  const accountLabelById = new Map(overview.accounts.map((entry) => [entry.account.id, entry.account.label || entry.account.eplusEmail]));

  const genderEntries = Object.entries(overview.genderBreakdown).sort(([a], [b]) => (a === "未知" ? 1 : b === "未知" ? -1 : 0));
  const genderPalette = [colors.primary, colors.info, colors.warning, colors.success];
  let genderColorIndex = 0;
  const genderSegments: Segment[] = genderEntries.map(([gender, count]) => ({
    key: gender,
    label: gender,
    value: count,
    color: gender === "未知" ? colors.muted : genderPalette[genderColorIndex++ % genderPalette.length]
  }));

  const outcomeSegments: Segment[] = [
    { key: "won", label: OUTCOME_LABEL.won, value: overview.recordOutcomeBreakdown.won, color: colors.success },
    { key: "lost", label: OUTCOME_LABEL.lost, value: overview.recordOutcomeBreakdown.lost, color: colors.danger },
    { key: "pending", label: OUTCOME_LABEL.pending, value: overview.recordOutcomeBreakdown.pending, color: colors.muted }
  ];
  const totalRecords = overview.recordOutcomeBreakdown.won + overview.recordOutcomeBreakdown.lost + overview.recordOutcomeBreakdown.pending;

  const winRateItems: RankedItem[] = overview.accounts
    .filter((entry) => entry.stats.distinctPerformanceCount > 0)
    .map((entry) => ({
      key: entry.account.id,
      label: entry.account.label || entry.account.eplusEmail,
      value: Math.round((entry.stats.winRate ?? 0) * 100),
      displayValue: formatPercent(entry.stats.winRate)
    }))
    .sort((a, b) => b.value - a.value)
    .slice(0, 15);

  function exportOverviewCsv(): void {
    const header = ["账号", "邮箱", "性别", "中选次数", "抽过公演数", "中选公演数", "中率(%)", "资料最后更新"];
    const rows = overview.accounts.map((entry) => [
      entry.account.label,
      entry.account.eplusEmail,
      entry.gender ?? "未知",
      entry.stats.winCount,
      entry.stats.distinctPerformanceCount,
      entry.stats.wonPerformanceCount,
      entry.stats.winRate === null ? "" : Math.round(entry.stats.winRate * 100),
      entry.account.profileUpdatedAt ?? ""
    ]);
    const csv = [header, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n");
    downloadTextFile(`eplus-账号总览-${new Date().toISOString().slice(0, 10)}.csv`, `﻿${csv}`, "text/csv;charset=utf-8");
  }

  async function exportChart(ref: React.RefObject<SVGSVGElement | null>, name: string): Promise<void> {
    if (!ref.current) return;
    await downloadSvgAsPng(ref.current, `eplus-${name}-${new Date().toISOString().slice(0, 10)}.png`, colors.surfaceSolid);
  }

  const accountColumns: Column<AccountOverviewEntry>[] = [
    { key: "account", label: "账号", render: (entry) => entry.account.label || entry.account.eplusEmail, sortValue: (entry) => entry.account.label || entry.account.eplusEmail, filter: { type: "text", value: (entry) => `${entry.account.label} ${entry.account.eplusEmail}` } },
    { key: "gender", label: "性别", render: (entry) => entry.gender || "未知", sortValue: (entry) => entry.gender || "未知", filter: { type: "select", value: (entry) => entry.gender || "未知" }, noWrap: true },
    { key: "winCount", label: "中选次数", render: (entry) => entry.stats.winCount, sortValue: (entry) => entry.stats.winCount, filter: { type: "min", value: (entry) => entry.stats.winCount }, noWrap: true, align: "right" },
    { key: "performances", label: "抽过公演数", render: (entry) => entry.stats.distinctPerformanceCount, sortValue: (entry) => entry.stats.distinctPerformanceCount, filter: { type: "min", value: (entry) => entry.stats.distinctPerformanceCount }, noWrap: true, align: "right" },
    { key: "wonPerformances", label: "中选公演数", render: (entry) => entry.stats.wonPerformanceCount, sortValue: (entry) => entry.stats.wonPerformanceCount, filter: { type: "min", value: (entry) => entry.stats.wonPerformanceCount }, noWrap: true, align: "right" },
    { key: "winRate", label: "中率", render: (entry) => formatPercent(entry.stats.winRate), sortValue: (entry) => entry.stats.winRate ?? -1, filter: { type: "min", value: (entry) => (entry.stats.winRate ?? -1) * 100, placeholder: "≥%" }, noWrap: true, align: "right" },
    { key: "updated", label: "资料最后更新", render: (entry) => formatDateTime(entry.account.profileUpdatedAt), sortValue: (entry) => entry.account.profileUpdatedAt ?? "", noWrap: true },
    { key: "actions", label: "", render: (entry) => <button className="icon-button" onClick={() => setModalAccount(entry)}>查看公演</button>, noWrap: true }
  ];

  return <section className="workspace-panel" aria-labelledby="overview-title">
    <div className="workspace-heading">
      <div><p className="section-kicker">账号总览</p><h1 id="overview-title">统计与中选情况</h1><p>中选次数按抽选记录条数统计；抽过的公演数与中率按不同公演去重（同一公演的两天算两场，同一公演的多次抽选记录只算一场）。</p></div>
      <button className="icon-button" onClick={exportOverviewCsv}><Download size={15} />导出数据 CSV</button>
    </div>

    <section className="panel-card stat-hero">
      <div className="stat-tile-row">
        <StatTile icon={<Users size={20} />} label="账号总数" value={String(overview.totalAccounts)} accent={colors.primary} />
        <StatTile icon={<Trophy size={20} />} label="中选次数合计" value={String(overview.totalWinCount)} accent={colors.success} />
        <StatTile icon={<Ticket size={20} />} label="抽过公演数合计" value={String(overview.totalDistinctPerformances)} accent={colors.info} />
        <StatTile icon={<PercentCircle size={20} />} label="整体中率" value={formatPercent(overview.overallWinRate)} accent={colors.warning} />
      </div>
    </section>

    <div className="panel-layout-two">
      <section className="panel-card">
        <div className="panel-head"><h2><PieChart size={16} />性别分布</h2><div className="actions"><SegmentChartModeToggle mode={genderChartMode} onChange={setGenderChartMode} /><button className="icon-button" onClick={() => void exportChart(genderChartRef, "性别分布")}><ImageDown size={14} />导出图片</button></div></div>
        {genderChartMode === "bar"
          ? <SegmentBarChart ref={genderChartRef} segments={genderSegments} total={overview.totalAccounts} trackColor={colors.surfaceC} textColor={colors.text} mutedColor={colors.textMuted} />
          : <DonutChart ref={genderChartRef} segments={genderSegments} total={overview.totalAccounts} totalLabel="账号总数" trackColor={colors.surfaceC} textColor={colors.text} mutedColor={colors.textMuted} />}
      </section>
      <section className="panel-card">
        <div className="panel-head"><h2><Trophy size={16} />抽选记录结果分布</h2><div className="actions"><SegmentChartModeToggle mode={outcomeChartMode} onChange={setOutcomeChartMode} /><button className="icon-button" onClick={() => void exportChart(outcomeChartRef, "抽选结果分布")}><ImageDown size={14} />导出图片</button></div></div>
        {outcomeChartMode === "bar"
          ? <SegmentBarChart ref={outcomeChartRef} segments={outcomeSegments} total={totalRecords} trackColor={colors.surfaceC} textColor={colors.text} mutedColor={colors.textMuted} />
          : <DonutChart ref={outcomeChartRef} segments={outcomeSegments} total={totalRecords} totalLabel="抽选记录数" trackColor={colors.surfaceC} textColor={colors.text} mutedColor={colors.textMuted} />}
      </section>
    </div>

    <section className="panel-card">
      <div className="panel-head"><h2><PercentCircle size={16} />中率排行榜</h2><button className="icon-button" onClick={() => void exportChart(winRateChartRef, "中率排行榜")}><ImageDown size={14} />导出图片</button></div>
      <RankedBarChart ref={winRateChartRef} items={winRateItems} barColor={colors.primary} trackColor={colors.surfaceC} labelColor={colors.textMuted} valueColor={colors.text} maxValue={100} />
    </section>

    <div className="panel-layout-two">
      <section className="panel-card">
        <div className="panel-head"><h2><History size={16} />最近抽选动态</h2></div>
        <RecentActivityList records={overview.recentActivity} accountLabelById={accountLabelById} />
      </section>
      <section className="panel-card">
        <div className="panel-head"><h2><Flame size={16} />最多人抽的公演</h2></div>
        <TopPerformancesList performances={overview.topPerformances} />
      </section>
    </div>

    <section className="panel-card">
      <div className="panel-head"><h2><Users size={16} />各账号中选情况</h2><span className="muted">点击表头排序，表头下方可筛选；点击账号查看具体公演的抽选记录</span></div>
      <SortableFilterableTable columns={accountColumns} rows={overview.accounts} rowKey={(entry) => entry.account.id} emptyMessage="尚未添加账号。" />
    </section>

    <Modal open={!!modalAccount} title={modalAccount?.account.label || modalAccount?.account.eplusEmail} subtitle="公演抽选记录" onClose={() => setModalAccount(undefined)} wide>
      {modalAccount ? <PerformanceModalBody entry={modalAccount} /> : null}
    </Modal>
  </section>;
}

function StatTile(props: { readonly icon: React.ReactNode; readonly label: string; readonly value: string; readonly accent: string }) {
  return <div className="stat-tile">
    <div className="stat-tile-icon" style={{ color: props.accent, background: `color-mix(in srgb, ${props.accent} 16%, transparent)` }}>{props.icon}</div>
    <div className="stat-tile-text"><span className="stat-tile-label">{props.label}</span><strong className="stat-tile-value">{props.value}</strong></div>
  </div>;
}

function RecentActivityList(props: { readonly records: readonly LotteryRecord[]; readonly accountLabelById: ReadonlyMap<string, string> }) {
  if (props.records.length === 0) return <p className="empty-state">暂无抽选记录。</p>;
  return <ul className="activity-list">
    {props.records.map((record) => {
      const outcome: LotteryOutcome = record.status.includes("当選") ? "won" : record.status.includes("落選") ? "lost" : "pending";
      return <li key={record.id} className="activity-item">
        <span className={outcomeBadgeClass(outcome)}>{outcomeLabel(record.status, outcome)}</span>
        <div className="activity-item-text">
          <strong>{record.tourName}</strong>
          <span className="muted">{props.accountLabelById.get(record.accountId) ?? "未知账号"} · {record.orderDatetime || record.eventDatetime || "-"}</span>
        </div>
      </li>;
    })}
  </ul>;
}

function TopPerformancesList(props: { readonly performances: readonly TopPerformanceEntry[] }) {
  if (props.performances.length === 0) return <p className="empty-state">暂无抽选记录。</p>;
  return <ol className="ranking-list">
    {props.performances.map((performance, index) => <li key={performance.performanceKey} className="ranking-item">
      <span className="ranking-index">{index + 1}</span>
      <div className="activity-item-text">
        <strong>{performance.tourName}</strong>
        <span className="muted">{performance.eventDatetime || "-"} · {performance.accountCount} 个账号抽过</span>
      </div>
      <span className="badge badge-teal">{performance.totalDraws} 次抽选</span>
    </li>)}
  </ol>;
}

function PerformanceModalBody(props: { readonly entry: AccountOverviewEntry }) {
  const { stats } = props.entry;
  const columns = useMemo((): Column<PerformanceHistory>[] => [
    { key: "tour", label: "公演", render: (performance) => performance.tourName, sortValue: (performance) => performance.tourName, filter: { type: "text", value: (performance) => performance.tourName } },
    { key: "session", label: "场次/受付", render: (performance) => performance.eventDatetime || performance.receptionName || performance.venueName || "-", sortValue: (performance) => performance.eventDatetime || performance.receptionName || performance.venueName || "", noWrap: true },
    { key: "draws", label: "抽选次数", render: (performance) => performance.records.length, sortValue: (performance) => performance.records.length, filter: { type: "min", value: (performance) => performance.records.length }, noWrap: true, align: "right" },
    { key: "status", label: "最后状态", render: (performance) => <span className={outcomeBadgeClass(performance.lastOutcome)}>{outcomeLabel(performance.lastRecord.status, performance.lastOutcome)}</span>, sortValue: (performance) => performance.lastOutcome, filter: { type: "select", value: (performance) => outcomeLabel(performance.lastRecord.status, performance.lastOutcome) }, noWrap: true }
  ], []);

  return <div className="stack">
    <div className="summary-grid">
      <div><span>中选次数</span><strong>{stats.winCount}</strong></div>
      <div><span>抽过公演数</span><strong>{stats.distinctPerformanceCount}</strong></div>
      <div><span>中选公演数</span><strong>{stats.wonPerformanceCount}</strong></div>
      <div><span>中率</span><strong>{formatPercent(stats.winRate)}</strong></div>
    </div>
    <SortableFilterableTable columns={columns} rows={stats.performances} rowKey={(performance) => performance.performanceKey} emptyMessage="该账号还没有抽选记录。" />
  </div>;
}
