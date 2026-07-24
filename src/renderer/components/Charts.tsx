import { forwardRef } from "react";

const FONT = "'Segoe UI', system-ui, -apple-system, sans-serif";

export interface Segment {
  readonly key: string;
  readonly label: string;
  readonly value: number;
  readonly color: string;
}

interface SegmentBarChartProps {
  readonly segments: readonly Segment[];
  readonly total: number;
  readonly trackColor: string;
  readonly textColor: string;
  readonly mutedColor: string;
}

/** Part-to-whole: a single horizontal bar split into colored segments (gender / outcome
 *  breakdowns), with a vertically-stacked legend so it stays exportable as a self-contained
 *  PNG regardless of how many categories there are. */
export const SegmentBarChart = forwardRef<SVGSVGElement, SegmentBarChartProps>((props, ref) => {
  const width = 640;
  const barHeight = 32;
  const legendRowHeight = 24;
  const gap = 2;
  const nonZero = props.segments.filter((segment) => segment.value > 0);
  const usableWidth = width - gap * Math.max(0, nonZero.length - 1);
  const height = barHeight + 16 + Math.max(nonZero.length, 1) * legendRowHeight;

  let cursor = 0;
  const bars = nonZero.map((segment) => {
    const segmentWidth = props.total > 0 ? (segment.value / props.total) * usableWidth : 0;
    const x = cursor;
    cursor += segmentWidth + gap;
    const percent = props.total > 0 ? Math.round((segment.value / props.total) * 100) : 0;
    return <rect key={segment.key} x={x} y={0} width={Math.max(segmentWidth, 0)} height={barHeight} rx={4} fill={segment.color}>
      <title>{`${segment.label}：${segment.value}（${percent}%）`}</title>
    </rect>;
  });

  return <svg ref={ref} viewBox={`0 0 ${width} ${height}`} className="chart-svg" role="img" aria-label="占比图">
    {nonZero.length === 0
      ? <rect x={0} y={0} width={width} height={barHeight} rx={4} fill={props.trackColor} />
      : <g>{bars}</g>}
    <g transform={`translate(0, ${barHeight + 16})`}>
      {nonZero.map((segment, index) => {
        const percent = props.total > 0 ? Math.round((segment.value / props.total) * 100) : 0;
        return <g key={segment.key} transform={`translate(0, ${index * legendRowHeight})`}>
          <rect x={0} y={4} width={13} height={13} rx={3} fill={segment.color} />
          <text x={21} y={14} fontFamily={FONT} fontSize={13} fill={props.textColor}>{segment.label} · {segment.value}（{percent}%）</text>
        </g>;
      })}
      {nonZero.length === 0 ? <text x={0} y={14} fontFamily={FONT} fontSize={13} fill={props.mutedColor}>暂无数据</text> : null}
    </g>
  </svg>;
});
SegmentBarChart.displayName = "SegmentBarChart";

interface SegmentLegendProps {
  readonly segments: readonly Segment[];
  readonly total: number;
  readonly textColor: string;
  readonly mutedColor: string;
  readonly y: number;
}

function SegmentLegend(props: SegmentLegendProps) {
  const rowHeight = 24;
  return <g transform={`translate(0, ${props.y})`}>
    {props.segments.map((segment, index) => {
      const percent = props.total > 0 ? Math.round((segment.value / props.total) * 100) : 0;
      return <g key={segment.key} transform={`translate(0, ${index * rowHeight})`}>
        <rect x={0} y={4} width={13} height={13} rx={3} fill={segment.color} />
        <text x={21} y={14} fontFamily={FONT} fontSize={13} fill={props.textColor}>{segment.label} · {segment.value}（{percent}%）</text>
      </g>;
    })}
    {props.segments.length === 0 ? <text x={0} y={14} fontFamily={FONT} fontSize={13} fill={props.mutedColor}>暂无数据</text> : null}
  </g>;
}

function polarPoint(cx: number, cy: number, r: number, angle: number): { x: number; y: number } {
  return { x: cx + r * Math.cos(angle), y: cy + r * Math.sin(angle) };
}

/** Wedge of an annulus (a donut slice) between two angles, built from two arcs rather than a
 *  filled circle sector so the chart can carve out a center hole for the total-count figure. */
function donutSlicePath(cx: number, cy: number, innerR: number, outerR: number, startAngle: number, endAngle: number): string {
  const largeArc = endAngle - startAngle > Math.PI ? 1 : 0;
  const outerStart = polarPoint(cx, cy, outerR, startAngle);
  const outerEnd = polarPoint(cx, cy, outerR, endAngle);
  const innerStart = polarPoint(cx, cy, innerR, endAngle);
  const innerEnd = polarPoint(cx, cy, innerR, startAngle);
  return [
    `M ${outerStart.x} ${outerStart.y}`,
    `A ${outerR} ${outerR} 0 ${largeArc} 1 ${outerEnd.x} ${outerEnd.y}`,
    `L ${innerStart.x} ${innerStart.y}`,
    `A ${innerR} ${innerR} 0 ${largeArc} 0 ${innerEnd.x} ${innerEnd.y}`,
    "Z"
  ].join(" ");
}

interface DonutChartProps {
  readonly segments: readonly Segment[];
  readonly total: number;
  readonly totalLabel: string;
  readonly textColor: string;
  readonly mutedColor: string;
  readonly trackColor: string;
}

/** Part-to-whole as a real pie/donut, offered as an alternate view alongside SegmentBarChart -
 *  same segments, same legend, just a circular mark instead of a bar for readers who want it.
 *  The 2px surface gap between slices is approximated as a small angular inset so wedges read as
 *  distinct without an outline stroke (see the dataviz skill's mark spec). */
export const DonutChart = forwardRef<SVGSVGElement, DonutChartProps>((props, ref) => {
  const width = 640;
  const cx = 130;
  const cy = 130;
  const outerR = 108;
  const innerR = 62;
  const plotHeight = 260;
  const nonZero = props.segments.filter((segment) => segment.value > 0);
  const legendRowHeight = 24;
  const height = plotHeight + Math.max(nonZero.length, 1) * legendRowHeight + 8;
  const gapAngle = nonZero.length > 1 ? 2 / outerR : 0;

  let cursor = -Math.PI / 2;
  const slices = nonZero.map((segment) => {
    const share = props.total > 0 ? segment.value / props.total : 0;
    const sweep = share * Math.PI * 2;
    const start = cursor + gapAngle / 2;
    const end = cursor + sweep - gapAngle / 2;
    cursor += sweep;
    const percent = Math.round(share * 100);
    const mid = (start + end) / 2;
    const labelPoint = polarPoint(cx, cy, (innerR + outerR) / 2, mid);
    const showLabel = end > start && share >= 0.08;
    return <g key={segment.key}>
      <path d={donutSlicePath(cx, cy, innerR, outerR, Math.min(start, end), Math.max(start, end))} fill={segment.color}>
        <title>{`${segment.label}：${segment.value}（${percent}%）`}</title>
      </path>
      {showLabel ? <text x={labelPoint.x} y={labelPoint.y} textAnchor="middle" dominantBaseline="middle" fontFamily={FONT} fontSize={13} fontWeight={600} fill="#ffffff">{percent}%</text> : null}
    </g>;
  });

  return <svg ref={ref} viewBox={`0 0 ${width} ${height}`} className="chart-svg" role="img" aria-label="饼图">
    <g transform={`translate(${(width - cx * 2) / 2}, 0)`}>
      {nonZero.length === 0
        ? <circle cx={cx} cy={cy} r={outerR} fill={props.trackColor} />
        : <>
          <circle cx={cx} cy={cy} r={outerR} fill="none" />
          {slices}
        </>}
      <text x={cx} y={cy - 6} textAnchor="middle" fontFamily={FONT} fontSize={26} fontWeight={700} fill={props.textColor} style={{ fontVariantNumeric: "tabular-nums" }}>{props.total}</text>
      <text x={cx} y={cy + 16} textAnchor="middle" fontFamily={FONT} fontSize={12.5} fill={props.mutedColor}>{props.totalLabel}</text>
    </g>
    <SegmentLegend segments={nonZero} total={props.total} textColor={props.textColor} mutedColor={props.mutedColor} y={plotHeight} />
  </svg>;
});
DonutChart.displayName = "DonutChart";

export interface RankedItem {
  readonly key: string;
  readonly label: string;
  readonly value: number;
  /** Rendered both beside the bar and in its tooltip - keep this short (it has roughly a
   *  60-unit-wide column to sit in before it runs into the viewBox edge). Use `detail` for
   *  anything that needs more room; it only appears on hover. */
  readonly displayValue: string;
  /** Extra tooltip-only context (e.g. the raw counts behind a percentage) that wouldn't fit
   *  next to the bar. */
  readonly detail?: string;
}

export interface RankedBarHeat {
  /** Below-midpoint anchor hue ("cold" - underperforming). */
  readonly cool: string;
  /** Above-midpoint anchor hue ("hot" - overperforming). */
  readonly warm: string;
  /** What a bar sitting exactly at the midpoint fades toward - a visible neutral, not the
   *  track color, so a middling value still reads as a real (if quiet) bar. */
  readonly neutral: string;
  /** The value that's neither hot nor cold - e.g. 50 for a win rate, where the reader's
   *  real question is "above or below half," not just "who's highest." */
  readonly midpoint: number;
}

interface RankedBarChartProps {
  readonly items: readonly RankedItem[];
  readonly barColor?: string;
  readonly trackColor: string;
  readonly labelColor: string;
  readonly valueColor: string;
  readonly maxValue?: number;
  /** Widen the left label column past the 170-unit default - for labels that are routinely
   *  longer than an account name (tour titles), so more of the name shows before it's cut off
   *  and pushed to the tooltip. */
  readonly labelWidth?: number;
  /** Recolors each bar by distance above/below `heat.midpoint` (a diverging encoding) instead
   *  of a single flat barColor - rank still comes from bar length, this adds a second read
   *  ("comfortably above half" vs "barely above half") that length alone can't show. */
  readonly heat?: RankedBarHeat;
}

function truncateLabel(label: string, maxChars: number = 18): string {
  return label.length > maxChars ? `${label.slice(0, maxChars - 1)}…` : label;
}

function heatFill(value: number, max: number, heat: RankedBarHeat): string {
  const span = Math.max(heat.midpoint, max - heat.midpoint) || 1;
  const t = Math.max(-1, Math.min(1, (value - heat.midpoint) / span));
  const pct = Math.round(Math.abs(t) * 100);
  return `color-mix(in srgb, ${t >= 0 ? heat.warm : heat.cool} ${pct}%, ${heat.neutral})`;
}

/** Magnitude comparison across accounts/performances - single sequential hue, sorted by the
 *  caller, direct-labeled (no legend needed for one series per the dataviz method). */
export const RankedBarChart = forwardRef<SVGSVGElement, RankedBarChartProps>((props, ref) => {
  // Wider viewBox than the other charts: this one renders in a full-width panel (not the
  // two-column layout the segment/donut charts share), so at 640 the browser scales it up ~1.7x
  // to fill that width - inflating the SVG's fixed font sizes well past the surrounding text.
  // Matching the viewBox to roughly its real rendered width keeps the scale factor near 1:1.
  const width = 1040;
  const rowHeight = 30;
  const rowGap = 8;
  const labelWidth = props.labelWidth ?? 170;
  const labelMaxChars = Math.round((labelWidth * 18) / 170);
  const valueWidth = 60;
  const trackWidth = width - labelWidth - valueWidth;
  const max = props.maxValue ?? Math.max(1, ...props.items.map((item) => item.value));
  const height = props.items.length > 0 ? props.items.length * (rowHeight + rowGap) - rowGap : rowHeight;

  return <svg ref={ref} viewBox={`0 0 ${width} ${Math.max(height, rowHeight)}`} className="chart-svg" role="img" aria-label="排行图">
    {props.items.length === 0
      ? <text x={0} y={rowHeight / 2} dominantBaseline="middle" fontFamily={FONT} fontSize={13} fill={props.labelColor}>暂无数据</text>
      : props.items.map((item, index) => {
        const y = index * (rowHeight + rowGap);
        const barWidth = max > 0 ? Math.max((item.value / max) * trackWidth, item.value > 0 ? 3 : 0) : 0;
        return <g key={item.key}>
          <text x={labelWidth - 10} y={y + rowHeight / 2} dominantBaseline="middle" textAnchor="end" fontFamily={FONT} fontSize={12.5} fill={props.labelColor}>
            <title>{item.label}</title>
            {truncateLabel(item.label, labelMaxChars)}
          </text>
          <rect x={labelWidth} y={y + 5} width={trackWidth} height={rowHeight - 10} rx={4} fill={props.trackColor} />
          <rect x={labelWidth} y={y + 5} width={barWidth} height={rowHeight - 10} rx={4} fill={props.heat ? heatFill(item.value, max, props.heat) : props.barColor}>
            <title>{`${item.label}：${item.displayValue}${item.detail ? `（${item.detail}）` : ""}`}</title>
          </rect>
          <text x={labelWidth + trackWidth + 10} y={y + rowHeight / 2} dominantBaseline="middle" fontFamily={FONT} fontSize={12.5} style={{ fontVariantNumeric: "tabular-nums" }} fill={props.valueColor}>{item.displayValue}</text>
        </g>;
      })}
  </svg>;
});
RankedBarChart.displayName = "RankedBarChart";

export interface TrendBarPoint {
  readonly x: string;
  /** On its own relative scale (this series' own max), not the labeled axis - the bars are
   *  read as "which months were busier," not against a literal number on the gridlines. The
   *  real count belongs in displayValue. */
  readonly value: number;
  readonly displayValue: string;
}

export interface TrendLinePoint {
  readonly x: string;
  /** A real 0-100 percentage - this is the series the Y-axis gridlines actually describe. */
  readonly y: number | null;
  readonly displayValue: string;
}

interface TrendChartProps {
  /** Rendered as recessive background bars on their own relative scale - conveys "more/less
   *  than other months" without claiming a literal position on the (percentage) axis. */
  readonly bar: { readonly label: string; readonly color: string; readonly points: readonly TrendBarPoint[] };
  /** Rendered as the foreground line, plotted against the one labeled 0-100% axis. */
  readonly line: { readonly label: string; readonly color: string; readonly points: readonly TrendLinePoint[] };
  readonly gridColor: string;
  readonly labelColor: string;
  readonly textColor: string;
  readonly mutedColor: string;
}

/** A volume-and-rate trend over a shared category axis (e.g. months). Two series with
 *  different units can't both own the Y-axis without inventing a false correlation (see the
 *  dataviz dual-axis anti-pattern) - so only the rate gets a labeled percentage axis, and the
 *  volume renders as unlabeled background bars scaled to their own max, exactly like a
 *  temperature-line-over-precipitation-bars weather chart. A null line y leaves a gap rather
 *  than interpolating across missing data. */
export const TrendChart = forwardRef<SVGSVGElement, TrendChartProps>((props, ref) => {
  const width = 1040;
  const marginLeft = 34;
  const marginRight = 16;
  // Room above the 100%-mark gridline for its label's ascent and the top row of markers (r=4) -
  // without it, both get clipped flush against the viewBox's top edge.
  const topPadding = 12;
  const plotHeight = 220;
  const labelRowHeight = 28;
  const legendRowHeight = 22;
  const plotWidth = width - marginLeft - marginRight;
  const categories = props.line.points.map((point) => point.x);
  const n = categories.length;

  if (n === 0) {
    return <svg ref={ref} viewBox={`0 0 ${width} ${plotHeight}`} className="chart-svg" role="img" aria-label="趋势图">
      <text x={0} y={plotHeight / 2} dominantBaseline="middle" fontFamily={FONT} fontSize={13} fill={props.labelColor}>暂无数据</text>
    </svg>;
  }

  const height = topPadding + plotHeight + labelRowHeight + 2 * legendRowHeight + 16;
  const xStep = n > 1 ? plotWidth / (n - 1) : 0;
  const xAt = (index: number) => marginLeft + (n > 1 ? index * xStep : plotWidth / 2);
  const yAt = (value: number) => topPadding + plotHeight - (Math.max(0, Math.min(100, value)) / 100) * plotHeight;
  const labelStride = Math.max(1, Math.ceil(n / 10));

  const barMax = Math.max(1, ...props.bar.points.map((point) => point.value));
  const barWidth = Math.min(24, Math.max(6, (n > 1 ? xStep : plotWidth) - 10));

  return <svg ref={ref} viewBox={`0 0 ${width} ${height}`} className="chart-svg" role="img" aria-label="趋势图">
    {[0, 25, 50, 75, 100].map((tick) => <g key={tick}>
      <line x1={marginLeft} x2={width - marginRight} y1={yAt(tick)} y2={yAt(tick)} stroke={props.gridColor} strokeWidth={1} />
      <text x={marginLeft - 6} y={yAt(tick) + 4} textAnchor="end" fontFamily={FONT} fontSize={10.5} fill={props.mutedColor}>{tick}%</text>
    </g>)}
    {categories.map((label, index) => index % labelStride === 0
      ? <text key={`${label}-${index}`} x={xAt(index)} y={topPadding + plotHeight + 20} textAnchor="middle" fontFamily={FONT} fontSize={11.5} fill={props.mutedColor}>{label}</text>
      : null)}
    {props.bar.points.map((point, index) => {
      const barHeight = Math.max((point.value / barMax) * plotHeight, point.value > 0 ? 2 : 0);
      return <rect key={index} x={xAt(index) - barWidth / 2} y={topPadding + plotHeight - barHeight} width={barWidth} height={barHeight} rx={2} fill={props.bar.color} fillOpacity={0.32}>
        <title>{`${props.bar.label} · ${categories[index]}：${point.displayValue}`}</title>
      </rect>;
    })}
    {(() => {
      const runs: { x: number; y: number }[][] = [];
      let current: { x: number; y: number }[] = [];
      props.line.points.forEach((point, index) => {
        if (point.y === null) {
          if (current.length > 0) runs.push(current);
          current = [];
          return;
        }
        current.push({ x: xAt(index), y: yAt(point.y) });
      });
      if (current.length > 0) runs.push(current);
      return <g>
        {runs.map((run, runIndex) => run.length > 1
          ? <polyline key={runIndex} points={run.map((point) => `${point.x},${point.y}`).join(" ")} fill="none" stroke={props.line.color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
          : null)}
        {props.line.points.map((point, index) => point.y === null ? null : <circle key={index} cx={xAt(index)} cy={yAt(point.y)} r={4} fill={props.line.color}>
          <title>{`${props.line.label} · ${categories[index]}：${point.displayValue}`}</title>
        </circle>)}
      </g>;
    })()}
    <g transform={`translate(0, ${topPadding + plotHeight + labelRowHeight})`}>
      {[props.bar, props.line].map((series, index) => <g key={series.label} transform={`translate(0, ${index * legendRowHeight})`}>
        <rect x={0} y={4} width={13} height={13} rx={3} fill={series.color} />
        <text x={21} y={14} fontFamily={FONT} fontSize={13} fill={props.textColor}>{series.label}</text>
      </g>)}
    </g>
  </svg>;
});
TrendChart.displayName = "TrendChart";

export interface CurveBarPoint {
  readonly key: string;
  /** Bucket label (e.g. "1个", "6+个") - buckets render in the order given, not sorted by value,
   *  since the order along a dose-response curve is the point. */
  readonly label: string;
  readonly value: number | null;
  readonly sampleSize: number;
  readonly displayValue: string;
}

interface CurveBarChartProps {
  readonly points: readonly CurveBarPoint[];
  readonly trackColor: string;
  readonly labelColor: string;
  readonly valueColor: string;
  readonly mutedColor: string;
  readonly heat?: RankedBarHeat;
}

/** Ordered dose-response curve as vertical bars (bucket count on X, a 0-100 rate on Y), each
 *  bar labeled with its sample size so a thin bucket doesn't read as equally trustworthy as a
 *  thick one. Reuses RankedBarChart's diverging heat fill for the same warm/cool language. */
export const CurveBarChart = forwardRef<SVGSVGElement, CurveBarChartProps>((props, ref) => {
  const width = 1040;
  const marginLeft = 16;
  const marginRight = 16;
  const plotHeight = 200;
  const labelRowHeight = 40;
  const valueLabelHeight = 20;
  const plotWidth = width - marginLeft - marginRight;
  const n = props.points.length;

  if (n === 0) {
    return <svg ref={ref} viewBox={`0 0 ${width} ${plotHeight}`} className="chart-svg" role="img" aria-label="量效曲线">
      <text x={0} y={plotHeight / 2} dominantBaseline="middle" fontFamily={FONT} fontSize={13} fill={props.labelColor}>暂无数据</text>
    </svg>;
  }

  const height = plotHeight + labelRowHeight + valueLabelHeight + 8;
  // Bars stay thin and centered in their slot even when there are few buckets - the slot's
  // leftover width is air, not more bar (mark spec: bars cap at 24px thick).
  const slotWidth = plotWidth / n;
  const barWidth = Math.min(24, Math.max(8, slotWidth - 16));
  const startX = (index: number) => marginLeft + index * slotWidth + (slotWidth - barWidth) / 2;

  return <svg ref={ref} viewBox={`0 0 ${width} ${height}`} className="chart-svg" role="img" aria-label="量效曲线">
    {props.points.map((point, index) => {
      const x = startX(index);
      const value = point.value ?? 0;
      const barHeight = point.value === null ? 0 : Math.max((value / 100) * plotHeight, value > 0 ? 3 : 0);
      const y = valueLabelHeight + plotHeight - barHeight;
      const fill = point.value === null ? props.trackColor : (props.heat ? heatFill(value, 100, props.heat) : props.trackColor);
      return <g key={point.key}>
        {/* Track spans the full slot height (not just the filled bar) so hovering anywhere in a
           thin/near-zero bar's column still surfaces its tooltip. */}
        <rect x={x} y={valueLabelHeight} width={barWidth} height={plotHeight} rx={4} fill={props.trackColor}>
          <title>{`${point.label}：${point.displayValue}（n=${point.sampleSize}）`}</title>
        </rect>
        <rect x={x} y={y} width={barWidth} height={barHeight} rx={4} fill={fill} pointerEvents="none" />
        <text x={x + barWidth / 2} y={y - 6} textAnchor="middle" fontFamily={FONT} fontSize={12.5} fontWeight={600} style={{ fontVariantNumeric: "tabular-nums" }} fill={props.valueColor}>{point.displayValue}</text>
        <text x={x + barWidth / 2} y={valueLabelHeight + plotHeight + 18} textAnchor="middle" fontFamily={FONT} fontSize={12.5} fill={props.labelColor}>{point.label}</text>
        <text x={x + barWidth / 2} y={valueLabelHeight + plotHeight + 34} textAnchor="middle" fontFamily={FONT} fontSize={11} fill={props.mutedColor}>n={point.sampleSize}</text>
      </g>;
    })}
  </svg>;
});
CurveBarChart.displayName = "CurveBarChart";

export interface ScatterPoint {
  readonly key: string;
  readonly x: number;
  /** 0-100. */
  readonly y: number;
  readonly label: string;
  readonly displayValue: string;
  /** Draw a small direct label next to this point - reserve for the few points the story is
   *  about (see the dataviz "label selectively" rule); most points rely on the hover tooltip. */
  readonly showLabel?: boolean;
}

interface ScatterChartProps {
  readonly points: readonly ScatterPoint[];
  readonly xLabel: string;
  readonly yLabel: string;
  readonly pointColor: string;
  /** Surface-color ring around each dot, so overlapping points stay distinguishable. */
  readonly ringColor: string;
  readonly gridColor: string;
  readonly labelColor: string;
  readonly mutedColor: string;
  /** A dashed vertical threshold line (e.g. median X) - deliberately dashed to read as "a
   *  threshold," distinct from the solid scale gridlines. */
  readonly xReference?: number;
  /** Short captions dropped into the four corners of the plot so the two axes read as an
   *  interpretable 2x2 frame instead of a bare unlabeled scatter. */
  readonly quadrantLabels?: { readonly topRight: string; readonly topLeft: string; readonly bottomRight: string; readonly bottomLeft: string };
}

/** Linear X/Y scatter - X is whatever scale the caller passes (e.g. a raw demand count), Y is
 *  always a 0-100 rate. Each point's real values surface through its tooltip. */
export const ScatterChart = forwardRef<SVGSVGElement, ScatterChartProps>((props, ref) => {
  const width = 1040;
  const marginLeft = 50;
  const marginRight = 20;
  // A reserved band above the plot for the Y-axis caption, so it doesn't collide with the
  // "100%" gridline label sitting right at the plot's top edge.
  const yLabelBand = 22;
  const marginTop = 10 + yLabelBand;
  const plotHeight = 280;
  const axisLabelHeight = 34;
  const plotWidth = width - marginLeft - marginRight;

  if (props.points.length === 0) {
    return <svg ref={ref} viewBox={`0 0 ${width} ${plotHeight}`} className="chart-svg" role="img" aria-label="散点图">
      <text x={0} y={plotHeight / 2} dominantBaseline="middle" fontFamily={FONT} fontSize={13} fill={props.labelColor}>暂无数据</text>
    </svg>;
  }

  const height = marginTop + plotHeight + axisLabelHeight + 20;
  const maxX = Math.max(1, ...props.points.map((point) => point.x));
  const xAt = (value: number) => marginLeft + (value / maxX) * plotWidth;
  const yAt = (value: number) => marginTop + plotHeight - (Math.max(0, Math.min(100, value)) / 100) * plotHeight;
  const yTicks = [0, 25, 50, 75, 100];
  const xTickCount = 5;

  return <svg ref={ref} viewBox={`0 0 ${width} ${height}`} className="chart-svg" role="img" aria-label="散点图">
    {yTicks.map((tick) => <g key={tick}>
      <line x1={marginLeft} x2={width - marginRight} y1={yAt(tick)} y2={yAt(tick)} stroke={props.gridColor} strokeWidth={1} />
      <text x={marginLeft - 8} y={yAt(tick) + 4} textAnchor="end" fontFamily={FONT} fontSize={11} fill={props.mutedColor}>{tick}%</text>
    </g>)}
    {Array.from({ length: xTickCount + 1 }, (_, index) => {
      const value = Math.round((maxX / xTickCount) * index);
      return <text key={index} x={xAt(value)} y={marginTop + plotHeight + 18} textAnchor="middle" fontFamily={FONT} fontSize={11} fill={props.mutedColor}>{value}</text>;
    })}
    {props.quadrantLabels ? <g>
      <text x={width - marginRight - 6} y={marginTop + 12} textAnchor="end" fontFamily={FONT} fontSize={11} fill={props.mutedColor}>{props.quadrantLabels.topRight}</text>
      <text x={marginLeft + 6} y={marginTop + 12} textAnchor="start" fontFamily={FONT} fontSize={11} fill={props.mutedColor}>{props.quadrantLabels.topLeft}</text>
      <text x={width - marginRight - 6} y={marginTop + plotHeight - 8} textAnchor="end" fontFamily={FONT} fontSize={11} fill={props.mutedColor}>{props.quadrantLabels.bottomRight}</text>
      <text x={marginLeft + 6} y={marginTop + plotHeight - 8} textAnchor="start" fontFamily={FONT} fontSize={11} fill={props.mutedColor}>{props.quadrantLabels.bottomLeft}</text>
    </g> : null}
    {props.xReference !== undefined ? (
      // Line only, no inline label here - the top-left corner already carries the Y-axis
      // caption and a quadrant label, and a reference value near the left edge would collide
      // with both. The muted caption text below the chart explains what the dashed line is.
      <line x1={xAt(props.xReference)} x2={xAt(props.xReference)} y1={marginTop} y2={marginTop + plotHeight} stroke={props.mutedColor} strokeWidth={1} strokeDasharray="4 3" />
    ) : null}
    {props.points.map((point) => {
      const cx = xAt(point.x);
      const cy = yAt(point.y);
      const nearRightEdge = cx > width - marginRight - 60;
      const nearLeftEdge = cx < marginLeft + 60;
      const labelAnchor = nearRightEdge ? "end" : nearLeftEdge ? "start" : "middle";
      const labelX = nearRightEdge ? Math.min(cx + 8, width - marginRight) : nearLeftEdge ? Math.max(cx - 8, marginLeft) : cx;
      return <g key={point.key}>
        {/* Invisible but hit-testable - a 5px dot is a pinpoint target, so the actual hover/
           focus area is a generous 24px circle around it, per the interaction spec. */}
        <circle cx={cx} cy={cy} r={12} fill="transparent" style={{ pointerEvents: "all" }}>
          <title>{`${point.label}：${point.displayValue}`}</title>
        </circle>
        <circle cx={cx} cy={cy} r={5} fill={props.pointColor} fillOpacity={0.85} stroke={props.ringColor} strokeWidth={2} pointerEvents="none" />
        {point.showLabel ? <text x={labelX} y={cy - 10} textAnchor={labelAnchor} fontFamily={FONT} fontSize={11} fill={props.labelColor}>{truncateLabel(point.label, 14)}</text> : null}
      </g>;
    })}
    <text x={marginLeft + plotWidth / 2} y={height - 4} textAnchor="middle" fontFamily={FONT} fontSize={12} fill={props.labelColor}>{props.xLabel}</text>
    <text x={marginLeft} y={16} fontFamily={FONT} fontSize={12} fill={props.labelColor}>{props.yLabel}</text>
  </svg>;
});
ScatterChart.displayName = "ScatterChart";
