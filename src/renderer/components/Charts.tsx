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

export interface RankedItem {
  readonly key: string;
  readonly label: string;
  readonly value: number;
  readonly displayValue: string;
}

interface RankedBarChartProps {
  readonly items: readonly RankedItem[];
  readonly barColor: string;
  readonly trackColor: string;
  readonly labelColor: string;
  readonly valueColor: string;
  readonly maxValue?: number;
}

function truncateLabel(label: string): string {
  return label.length > 18 ? `${label.slice(0, 17)}…` : label;
}

/** Magnitude comparison across accounts/performances - single sequential hue, sorted by the
 *  caller, direct-labeled (no legend needed for one series per the dataviz method). */
export const RankedBarChart = forwardRef<SVGSVGElement, RankedBarChartProps>((props, ref) => {
  const width = 640;
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
          <rect x={labelWidth} y={y + 5} width={barWidth} height={rowHeight - 10} rx={4} fill={props.barColor}>
            <title>{`${item.label}：${item.displayValue}`}</title>
          </rect>
          <text x={labelWidth + trackWidth + 10} y={y + rowHeight / 2} dominantBaseline="middle" fontFamily={FONT} fontSize={12.5} style={{ fontVariantNumeric: "tabular-nums" }} fill={props.valueColor}>{item.displayValue}</text>
        </g>;
      })}
  </svg>;
});
RankedBarChart.displayName = "RankedBarChart";
