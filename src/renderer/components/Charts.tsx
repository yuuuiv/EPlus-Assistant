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
  readonly displayValue: string;
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
  /** Recolors each bar by distance above/below `heat.midpoint` (a diverging encoding) instead
   *  of a single flat barColor - rank still comes from bar length, this adds a second read
   *  ("comfortably above half" vs "barely above half") that length alone can't show. */
  readonly heat?: RankedBarHeat;
}

function truncateLabel(label: string): string {
  return label.length > 18 ? `${label.slice(0, 17)}…` : label;
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
  const labelWidth = 170;
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
            {truncateLabel(item.label)}
          </text>
          <rect x={labelWidth} y={y + 5} width={trackWidth} height={rowHeight - 10} rx={4} fill={props.trackColor} />
          <rect x={labelWidth} y={y + 5} width={barWidth} height={rowHeight - 10} rx={4} fill={props.heat ? heatFill(item.value, max, props.heat) : props.barColor}>
            <title>{`${item.label}：${item.displayValue}`}</title>
          </rect>
          <text x={labelWidth + trackWidth + 10} y={y + rowHeight / 2} dominantBaseline="middle" fontFamily={FONT} fontSize={12.5} style={{ fontVariantNumeric: "tabular-nums" }} fill={props.valueColor}>{item.displayValue}</text>
        </g>;
      })}
  </svg>;
});
RankedBarChart.displayName = "RankedBarChart";
