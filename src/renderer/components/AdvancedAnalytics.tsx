import { BadgeCheck, ChartLine, ChartScatter, Coins, ImageDown, Repeat, Users } from "lucide-react";
import { useRef, useState } from "react";
import type { AccountsOverview, InvestmentReturnEntry } from "../../shared/ipc.js";
import { downloadSvgAsPng, formatPercent } from "../format.js";
import { useThemeColors } from "../useThemeColors.js";
import { CurveBarChart, RankedBarChart, ScatterChart, TrendChart, type CurveBarPoint, type RankedItem, type ScatterPoint } from "./Charts.js";

interface AdvancedAnalyticsProps {
  readonly overview: AccountsOverview | undefined;
  readonly loading: boolean;
}

type InvestmentGranularity = "tour" | "performance";

function InvestmentGranularityToggle(props: { readonly value: InvestmentGranularity; readonly onChange: (value: InvestmentGranularity) => void }) {
  return <div className="segmented" role="group" aria-label="切换统计粒度">
    <button className={props.value === "tour" ? "seg active" : "seg"} onClick={() => props.onChange("tour")}>巡演系列</button>
    <button className={props.value === "performance" ? "seg active" : "seg"} onClick={() => props.onChange("performance")}>单场公演</button>
  </div>;
}

function investmentItems(entries: readonly InvestmentReturnEntry[], granularity: InvestmentGranularity): RankedItem[] {
  return entries.map((entry) => ({
    key: entry.key,
    label: granularity === "performance" && entry.eventDatetime ? `${entry.label} · ${entry.eventDatetime}` : entry.label,
    value: Math.round((entry.efficiency ?? 0) * 100),
    displayValue: formatPercent(entry.efficiency),
    detail: `${entry.wonCount}/${entry.totalDraws}`
  }));
}

export function AdvancedAnalytics(props: AdvancedAnalyticsProps) {
  const colors = useThemeColors();
  const [investmentGranularity, setInvestmentGranularity] = useState<InvestmentGranularity>("tour");
  const trendChartRef = useRef<SVGSVGElement>(null);
  const accountCurveChartRef = useRef<SVGSVGElement>(null);
  const stackCurveChartRef = useRef<SVGSVGElement>(null);
  const confidenceChartRef = useRef<SVGSVGElement>(null);
  const investmentChartRef = useRef<SVGSVGElement>(null);
  const heatChartRef = useRef<SVGSVGElement>(null);

  if (props.loading || !props.overview) {
    return <section className="workspace-panel" aria-labelledby="analytics-title">
      <div className="workspace-heading"><div><p className="section-kicker">深度分析</p><h1 id="analytics-title">策略向统计</h1></div></div>
      <p className="empty-state">正在加载统计数据…</p>
    </section>;
  }

  const advanced = props.overview.advanced;

  async function exportChart(ref: React.RefObject<SVGSVGElement | null>, name: string): Promise<void> {
    if (!ref.current) return;
    await downloadSvgAsPng(ref.current, `eplus-${name}-${new Date().toISOString().slice(0, 10)}.png`, colors.surfaceSolid);
  }

  const trendBar = {
    label: "申请量（背景柱，相对高度）",
    color: colors.chart1,
    points: advanced.monthlyTrend.map((point) => ({ x: point.month, value: point.applications, displayValue: `${point.applications} 次申请` }))
  };
  const trendLine = {
    label: "当选率（左侧坐标轴，当选 / (当选+落选)）",
    color: colors.chart3,
    points: advanced.monthlyTrend.map((point) => ({ x: point.month, y: point.winRate === null ? null : point.winRate * 100, displayValue: formatPercent(point.winRate) }))
  };

  function toCurvePoints(points: typeof advanced.accountCountCurve): CurveBarPoint[] {
    return points.map((point) => ({
      key: point.bucketLabel,
      label: point.bucketLabel,
      value: point.successRate === null ? null : point.successRate * 100,
      sampleSize: point.sampleSize,
      displayValue: formatPercent(point.successRate)
    }));
  }

  const confidenceItems: RankedItem[] = advanced.confidenceRanking.map((entry) => ({
    key: entry.accountId,
    label: entry.label,
    value: Math.round((entry.adjustedScore ?? 0) * 100),
    displayValue: formatPercent(entry.adjustedScore)
  }));

  const investmentEntries = investmentGranularity === "tour" ? advanced.tourInvestmentReturn : advanced.performanceInvestmentReturn;
  const investmentRankedItems = investmentItems(investmentEntries, investmentGranularity);

  const sortedTotalDraws = advanced.heatDifficulty.map((point) => point.totalDraws).sort((a, b) => a - b);
  const medianTotalDraws = sortedTotalDraws.length === 0 ? 0 : sortedTotalDraws[Math.floor((sortedTotalDraws.length - 1) / 2)];
  const topDemandKeys = new Set([...advanced.heatDifficulty].sort((a, b) => b.totalDraws - a.totalDraws).slice(0, 3).map((point) => point.performanceKey));

  const heatPoints: ScatterPoint[] = advanced.heatDifficulty
    .filter((point) => point.participantWinRate !== null)
    .map((point) => ({
      key: point.performanceKey,
      x: point.totalDraws,
      y: Math.round((point.participantWinRate ?? 0) * 100),
      label: point.tourName,
      displayValue: `${point.totalDraws} 次抽选 · ${point.accountCount} 个账号参与 · 参与账号中率 ${formatPercent(point.participantWinRate)}`,
      showLabel: topDemandKeys.has(point.performanceKey)
    }));

  return <section className="workspace-panel" aria-labelledby="analytics-title">
    <div className="workspace-heading">
      <div><p className="section-kicker">深度分析</p><h1 id="analytics-title">策略向统计</h1><p>这里的图表偏"怎么用这个工具"的决策分析，而非基础汇总——养多少个号够用、复投几次划算、哪些号可能有问题、哪些巡演/场次值得多投入。</p></div>
    </div>

    <section className="panel-card">
      <div className="panel-head"><h2><ChartLine size={16} />申请量与当选率月度趋势</h2><button className="icon-button" onClick={() => void exportChart(trendChartRef, "月度趋势")}><ImageDown size={14} />导出图片</button></div>
      <p className="muted">按演出时间分月统计（申请时间字段暂未被采集端记录）。纵轴的 0-100% 只描述当选率这条线；背景柱是申请量，柱高只按自身月度峰值做相对高度、不对应坐标轴刻度，真实次数悬停查看。</p>
      <TrendChart ref={trendChartRef} bar={trendBar} line={trendLine} gridColor={colors.surfaceC} labelColor={colors.textMuted} textColor={colors.text} mutedColor={colors.textMuted} />
    </section>

    <section className="panel-card">
      <div className="panel-head"><h2><Users size={16} />多账号联合中选率</h2><button className="icon-button" onClick={() => void exportChart(accountCurveChartRef, "多账号联合中选率")}><ImageDown size={14} />导出图片</button></div>
      <p className="muted">按同一场公演有多少个账号参与抽选分桶，纵轴是该桶内"至少有一个账号中选"的比例。这是观察性统计而非受控实验——参与账号多的场次本身可能就是热门场次，不能直接解读成"加账号必然提高概率"，但能大致看出边际收益的形状。</p>
      <CurveBarChart ref={accountCurveChartRef} points={toCurvePoints(advanced.accountCountCurve)} trackColor={colors.surfaceC} labelColor={colors.textMuted} valueColor={colors.text} mutedColor={colors.textMuted} heat={{ cool: colors.chart1, warm: colors.chart3, neutral: colors.textMuted, midpoint: 50 }} />
    </section>

    <section className="panel-card">
      <div className="panel-head"><h2><Repeat size={16} />复投量效曲线</h2><button className="icon-button" onClick={() => void exportChart(stackCurveChartRef, "复投量效曲线")}><ImageDown size={14} />导出图片</button></div>
      <p className="muted">按单个账号对同一场公演投入了几份抽选申请分桶，纵轴是该桶内最终中选的比例。</p>
      <CurveBarChart ref={stackCurveChartRef} points={toCurvePoints(advanced.stackCountCurve)} trackColor={colors.surfaceC} labelColor={colors.textMuted} valueColor={colors.text} mutedColor={colors.textMuted} heat={{ cool: colors.chart1, warm: colors.chart3, neutral: colors.textMuted, midpoint: 50 }} />
    </section>

    <section className="panel-card">
      <div className="panel-head"><h2><BadgeCheck size={16} />置信区间修正的中签率排行</h2><button className="icon-button" onClick={() => void exportChart(confidenceChartRef, "置信区间修正排行")}><ImageDown size={14} />导出图片</button></div>
      <p className="muted">用 Wilson score 区间下界重新排序，样本量越小越往整体均值收缩——避免"只抽过1场且中了"排在"抽过20场稳定中一半"前面这种小样本假象。</p>
      <RankedBarChart
        ref={confidenceChartRef}
        items={confidenceItems}
        trackColor={colors.surfaceC}
        labelColor={colors.textMuted}
        valueColor={colors.text}
        maxValue={100}
        labelWidth={320}
        heat={{ cool: colors.chart1, warm: colors.chart3, neutral: colors.textMuted, midpoint: 50 }}
      />
    </section>

    <section className="panel-card">
      <div className="panel-head"><h2><Coins size={16} />投入产出比</h2><div className="actions"><InvestmentGranularityToggle value={investmentGranularity} onChange={setInvestmentGranularity} /><button className="icon-button" onClick={() => void exportChart(investmentChartRef, "投入产出比")}><ImageDown size={14} />导出图片</button></div></div>
      <p className="muted">条形长度 = 中选次数 / 投入抽选份数；悬停条形查看"中选数/投入数"原始值；已过滤掉投入不足 3 份的系列/场次，避免样本太薄的噪音。</p>
      <div key={investmentGranularity} className="chart-swap">
        <RankedBarChart
          ref={investmentChartRef}
          items={investmentRankedItems}
          trackColor={colors.surfaceC}
          labelColor={colors.textMuted}
          valueColor={colors.text}
          maxValue={100}
          labelWidth={320}
          barColor={colors.chart2}
        />
      </div>
    </section>

    <section className="panel-card">
      <div className="panel-head"><h2><ChartScatter size={16} />热度-难度相关性</h2><button className="icon-button" onClick={() => void exportChart(heatChartRef, "热度难度相关性")}><ImageDown size={14} />导出图片</button></div>
      <p className="muted">横轴是该场公演的总抽选份数（跨账号，代表热度），纵轴是参与账号里最终中过的比例（代表实际难度）。虚线是热度中位数；标了名字的是热度最高的 3 场；四角的文字标出了"热门/冷门 × 好中/难中"这四个象限各自的含义。</p>
      <ScatterChart
        ref={heatChartRef}
        points={heatPoints}
        xLabel="总抽选份数（热度）"
        yLabel="参与账号中率"
        pointColor={colors.chart4}
        ringColor={colors.surfaceSolid}
        gridColor={colors.surfaceC}
        labelColor={colors.textMuted}
        mutedColor={colors.textMuted}
        xReference={medianTotalDraws}
        quadrantLabels={{ topRight: "热门 · 好中", topLeft: "冷门 · 好中", bottomRight: "热门 · 难中", bottomLeft: "冷门 · 难中" }}
      />
    </section>
  </section>;
}
