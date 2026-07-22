export type ProgressTone = "primary" | "warning" | "danger" | "success" | "neutral";

interface ProgressBarProps {
  /** 0–100; omit for an indeterminate (still-running) bar. */
  readonly value?: number;
  readonly tone?: ProgressTone;
  readonly label: string;
  readonly compact?: boolean;
}

export function ProgressBar(props: ProgressBarProps) {
  const indeterminate = props.value === undefined;
  const clamped = indeterminate ? undefined : Math.min(100, Math.max(0, props.value as number));
  const tone = props.tone ?? "primary";
  return (
    <div
      className={`progress-track progress-${tone}${indeterminate ? " indeterminate" : ""}${props.compact ? " compact" : ""}`}
      role="progressbar"
      aria-label={props.label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={indeterminate ? undefined : clamped}
    >
      <div className="progress-fill" style={indeterminate ? undefined : { width: `${clamped}%` }} />
    </div>
  );
}
