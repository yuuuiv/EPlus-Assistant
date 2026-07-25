import { BarChart3, Download, Flame, History, ImageDown, PercentCircle, PieChart, Ticket, Trophy, Users } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { AccountOverviewEntry, AccountsOverview, LotteryOutcome, LotteryRecord, PerformanceHistory, TopPerformanceAccountEntry, TopPerformanceEntry } from "../../shared/ipc.js";
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

/** Which of a TopPerformanceEntry's two counts currently drives the ranking - a performance
 *  drawn by many accounts and one drawn many times by few accounts are both "hot" in a different
 *  sense, so the reader picks which sense they mean instead of one metric silently winning. */
type TopPerformanceSortMode = "accounts" | "draws";

function TopPerformanceSortToggle(props: { readonly mode: TopPerformanceSortMode; readonly onChange: (mode: TopPerformanceSortMode) => void }) {
  return <div className="segmented" role="group" aria-label="切换排序指标">
    <button className={props.mode === "accounts" ? "seg active" : "seg"} onClick={() => props.onChange("accounts")} title="按参与账号数排序"><Users size={14} /></button>
    <button className={props.mode === "draws" ? "seg active" : "seg"} onClick={() => props.onChange("draws")} title="按抽选总次数排序"><Ticket size={14} /></button>
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

/** Matches how many records the cross-account feed already shows, so switching to a single
 *  account doesn't suddenly show a much longer or shorter list. */
const RECENT_ACTIVITY_DISPLAY_LIMIT = 8;

/** Mirrors statsService.ts's private byRecency/parseEventDatetime - can't import a main-process
 *  helper into the renderer, so the same "order_datetime desc, falling back to event_datetime,
 *  falling back to string compare" rule is duplicated here for the one place the renderer needs
 *  to re-sort records itself. */
const EVENT_DATETIME_PATTERN = /^(\d{4})\/(\d{2})\/(\d{2}).*?(\d{1,2}):(\d{2})/;
function parseEventDatetime(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const match = EVENT_DATETIME_PATTERN.exec(value);
  if (match) {
    const [, year, month, day, hour, minute] = match;
    const time = new Date(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute)).getTime();
    return Number.isNaN(time) ? undefined : time;
  }
  const fallback = Date.parse(value);
  return Number.isNaN(fallback) ? undefined : fallback;
}

function compareByRecency(a: LotteryRecord, b: LotteryRecord): number {
  const aTime = Date.parse(a.orderDatetime ?? "");
  const bTime = Date.parse(b.orderDatetime ?? "");
  if (!Number.isNaN(aTime) && !Number.isNaN(bTime)) return bTime - aTime;
  if (!Number.isNaN(aTime)) return -1;
  if (!Number.isNaN(bTime)) return 1;
  const aEvent = parseEventDatetime(a.eventDatetime);
  const bEvent = parseEventDatetime(b.eventDatetime);
  if (aEvent !== undefined && bEvent !== undefined) return bEvent - aEvent;
  if (aEvent !== undefined) return -1;
  if (bEvent !== undefined) return 1;
  return (b.orderDatetime ?? "").localeCompare(a.orderDatetime ?? "");
}

export function AccountOverview(props: AccountOverviewProps) {
  const [modalAccount, setModalAccount] = useState<AccountOverviewEntry>();
  const [modalPerformance, setModalPerformance] = useState<TopPerformanceEntry>();
  const [genderChartMode, setGenderChartMode] = useState<SegmentChartMode>("bar");
  const [outcomeChartMode, setOutcomeChartMode] = useState<SegmentChartMode>("bar");
  const [topPerformanceSortMode, setTopPerformanceSortMode] = useState<TopPerformanceSortMode>("accounts");
  const [recentActivityAccountId, setRecentActivityAccountId] = useState("all");
  const [accountRecentRecords, setAccountRecentRecords] = useState<LotteryRecord[]>();
  const colors = useThemeColors();
  const genderChartRef = useRef<SVGSVGElement>(null);
  const outcomeChartRef = useRef<SVGSVGElement>(null);
  const winRateChartRef = useRef<SVGSVGElement>(null);

  useEffect(() => {
    if (recentActivityAccountId === "all") {
      setAccountRecentRecords(undefined);
      return;
    }
    let active = true;
    setAccountRecentRecords(undefined);
    void window.eplusApi.listLotteryRecords(recentActivityAccountId).then((records) => {
      if (!active) return;
      setAccountRecentRecords([...records].sort(compareByRecency).slice(0, RECENT_ACTIVITY_DISPLAY_LIMIT));
    });
    return () => { active = false; };
  }, [recentActivityAccountId]);

  if (props.loading || !props.overview) {
    return <section className="workspace-panel" aria-labelledby="overview-title">
      <div className="workspace-heading"><div><p className="section-kicker">账号总览</p><h1 id="overview-title">统计与中选情况</h1></div></div>
      <p className="empty-state">正在加载统计数据…</p>
    </section>;
  }

  const overview = props.overview;
  const accountLabelById = new Map(overview.accounts.map((entry) => [entry.account.id, entry.account.label || entry.account.eplusEmail]));

  // The server-side default (accountCount, then totalDraws as tiebreak) is just one of the two
  // orderings the reader might want - re-sort locally instead of round-tripping to main for a
  // toggle this cheap.
  const sortedTopPerformances = [...overview.topPerformances].sort((a, b) => (topPerformanceSortMode === "draws"
    ? b.totalDraws - a.totalDraws || b.accountCount - a.accountCount
    : b.accountCount - a.accountCount || b.totalDraws - a.totalDraws));

  const genderEntries = Object.entries(overview.genderBreakdown).sort(([a], [b]) => (a === "未知" ? 1 : b === "未知" ? -1 : 0));
  const genderPalette = [colors.chart1, colors.chart2, colors.chart3, colors.chart4];
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

  async function exportOverviewCsv(): Promise<void> {
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
    await downloadTextFile(`eplus-账号总览-${new Date().toISOString().slice(0, 10)}.csv`, `﻿${csv}`, "CSV 文件", ["csv"]);
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
      <button className="icon-button" onClick={() => void exportOverviewCsv()}><Download size={15} />导出数据 CSV</button>
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
        <div key={genderChartMode} className="chart-swap">
          {genderChartMode === "bar"
            ? <SegmentBarChart ref={genderChartRef} segments={genderSegments} total={overview.totalAccounts} trackColor={colors.surfaceC} textColor={colors.text} mutedColor={colors.textMuted} />
            : <DonutChart ref={genderChartRef} segments={genderSegments} total={overview.totalAccounts} totalLabel="账号总数" trackColor={colors.surfaceC} textColor={colors.text} mutedColor={colors.textMuted} />}
        </div>
      </section>
      <section className="panel-card">
        <div className="panel-head"><h2><Trophy size={16} />抽选记录结果分布</h2><div className="actions"><SegmentChartModeToggle mode={outcomeChartMode} onChange={setOutcomeChartMode} /><button className="icon-button" onClick={() => void exportChart(outcomeChartRef, "抽选结果分布")}><ImageDown size={14} />导出图片</button></div></div>
        <div key={outcomeChartMode} className="chart-swap">
          {outcomeChartMode === "bar"
            ? <SegmentBarChart ref={outcomeChartRef} segments={outcomeSegments} total={totalRecords} trackColor={colors.surfaceC} textColor={colors.text} mutedColor={colors.textMuted} />
            : <DonutChart ref={outcomeChartRef} segments={outcomeSegments} total={totalRecords} totalLabel="抽选记录数" trackColor={colors.surfaceC} textColor={colors.text} mutedColor={colors.textMuted} />}
        </div>
      </section>
    </div>

    <section className="panel-card">
      <div className="panel-head"><h2><PercentCircle size={16} />中率排行榜</h2><button className="icon-button" onClick={() => void exportChart(winRateChartRef, "中率排行榜")}><ImageDown size={14} />导出图片</button></div>
      <p className="muted">条形长度按中率排名；颜色按高于/低于 50% 中率深浅渐变，越暖代表越高于五成，越冷代表越低于五成。</p>
      <RankedBarChart
        ref={winRateChartRef}
        items={winRateItems}
        trackColor={colors.surfaceC}
        labelColor={colors.textMuted}
        valueColor={colors.text}
        maxValue={100}
        heat={{ cool: colors.chart1, warm: colors.chart3, neutral: colors.textMuted, midpoint: 50 }}
      />
    </section>

    <div className="panel-layout-two">
      <section className="panel-card">
        <div className="panel-head">
          <h2><History size={16} />最近抽选动态</h2>
          <div className="actions">
            <select className="select-inline" aria-label="按账号查看" value={recentActivityAccountId} onChange={(event) => setRecentActivityAccountId(event.target.value)}>
              <option value="all">全部账号</option>
              {overview.accounts.map((entry) => <option key={entry.account.id} value={entry.account.id}>{entry.account.label || entry.account.eplusEmail}</option>)}
            </select>
          </div>
        </div>
        <div key={recentActivityAccountId} className="chart-swap">
          {recentActivityAccountId !== "all" && !accountRecentRecords
            ? <p className="empty-state">正在加载…</p>
            : <RecentActivityList records={recentActivityAccountId === "all" ? overview.recentActivity : (accountRecentRecords ?? [])} accountLabelById={accountLabelById} />}
        </div>
      </section>
      <section className="panel-card">
        <div className="panel-head"><h2><Flame size={16} />最多账号抽的公演</h2><div className="actions"><TopPerformanceSortToggle mode={topPerformanceSortMode} onChange={setTopPerformanceSortMode} /></div></div>
        <p className="muted">{topPerformanceSortMode === "draws" ? "按抽选总次数排名（并列时看参与账号数）" : "按参与账号数排名（并列时看抽选总次数）"}；点击某场公演查看各账号分别抽了多少次、当选还是落选。</p>
        <TopPerformancesList performances={sortedTopPerformances} sortMode={topPerformanceSortMode} onSelect={setModalPerformance} />
      </section>
    </div>

    <section className="panel-card">
      <div className="panel-head"><h2><Users size={16} />各账号中选情况</h2><span className="muted">点击表头排序，表头下方可筛选；点击账号查看具体公演的抽选记录</span></div>
      <SortableFilterableTable columns={accountColumns} rows={overview.accounts} rowKey={(entry) => entry.account.id} emptyMessage="尚未添加账号。" />
    </section>

    <Modal open={!!modalAccount} title={modalAccount?.account.label || modalAccount?.account.eplusEmail} subtitle="公演抽选记录" onClose={() => setModalAccount(undefined)} wide>
      {modalAccount ? <PerformanceModalBody entry={modalAccount} /> : null}
    </Modal>

    <Modal open={!!modalPerformance} title={modalPerformance?.tourName} subtitle={modalPerformance?.eventDatetime || "各账号抽选情况"} onClose={() => setModalPerformance(undefined)} wide>
      {modalPerformance ? <TopPerformanceModalBody entry={modalPerformance} accountLabelById={accountLabelById} /> : null}
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
          <strong title={record.tourName}>{record.tourName}</strong>
          <span className="muted" title={`${props.accountLabelById.get(record.accountId) ?? "未知账号"} · ${record.orderDatetime || record.eventDatetime || "-"}`}>{props.accountLabelById.get(record.accountId) ?? "未知账号"} · {record.orderDatetime || record.eventDatetime || "-"}</span>
        </div>
      </li>;
    })}
  </ul>;
}

function TopPerformancesList(props: { readonly performances: readonly TopPerformanceEntry[]; readonly sortMode: TopPerformanceSortMode; readonly onSelect: (performance: TopPerformanceEntry) => void }) {
  if (props.performances.length === 0) return <p className="empty-state">暂无抽选记录。</p>;
  return <ol className="ranking-list">
    {props.performances.map((performance, index) => {
      const accountsText = `${performance.accountCount} 个账号抽过`;
      const drawsText = `${performance.totalDraws} 次抽选`;
      // Whichever count is currently the sort key gets the prominent badge - the other one moves
      // into the muted subtitle, so it's visually obvious which number is driving the order.
      const primaryText = props.sortMode === "draws" ? drawsText : accountsText;
      const secondaryText = props.sortMode === "draws" ? accountsText : drawsText;
      return <li
        key={performance.performanceKey}
        className="ranking-item ranking-item-clickable"
        role="button"
        tabIndex={0}
        onClick={() => props.onSelect(performance)}
        onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); props.onSelect(performance); } }}
      >
        <span className="ranking-index">{index + 1}</span>
        <div className="activity-item-text">
          <strong title={performance.tourName}>{performance.tourName}</strong>
          <span className="muted" title={`${performance.eventDatetime || "-"} · ${secondaryText}`}>{performance.eventDatetime || "-"} · {secondaryText}</span>
        </div>
        <span className="badge badge-teal">{primaryText}</span>
      </li>;
    })}
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

function TopPerformanceModalBody(props: { readonly entry: TopPerformanceEntry; readonly accountLabelById: ReadonlyMap<string, string> }) {
  const { entry } = props;
  const columns = useMemo((): Column<TopPerformanceAccountEntry>[] => [
    { key: "account", label: "账号", render: (row) => props.accountLabelById.get(row.accountId) ?? "未知账号", sortValue: (row) => props.accountLabelById.get(row.accountId) ?? "", filter: { type: "text", value: (row) => props.accountLabelById.get(row.accountId) ?? "" } },
    { key: "draws", label: "抽选次数", render: (row) => row.totalDraws, sortValue: (row) => row.totalDraws, filter: { type: "min", value: (row) => row.totalDraws }, noWrap: true, align: "right" },
    { key: "outcome", label: "结果", render: (row) => <span className={outcomeBadgeClass(row.outcome)}>{OUTCOME_LABEL[row.outcome]}</span>, sortValue: (row) => row.outcome, filter: { type: "select", value: (row) => OUTCOME_LABEL[row.outcome] }, noWrap: true }
  ], [props.accountLabelById]);

  return <div className="stack">
    <div className="summary-grid">
      <div><span>参与账号数</span><strong>{entry.accountCount}</strong></div>
      <div><span>抽选总次数</span><strong>{entry.totalDraws}</strong></div>
    </div>
    <SortableFilterableTable columns={columns} rows={entry.accounts} rowKey={(row) => row.accountId} emptyMessage="暂无数据。" />
  </div>;
}
