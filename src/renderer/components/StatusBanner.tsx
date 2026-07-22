import { CheckCircle2, CircleAlert, X } from "lucide-react";
import { useEffect, useState } from "react";

export type StatusTone = "success" | "error";

interface StatusBannerProps {
  readonly message: string;
  readonly onDismiss: () => void;
}

const AUTO_DISMISS_MS = 4200;
const EXIT_MS = 160;

function toneOf(message: string): StatusTone {
  return message.includes("失败") || message.includes("未通过") ? "error" : "success";
}

/** Sticky, tone-aware status feedback. Errors persist until dismissed; everything else clears itself. */
export function StatusBanner(props: StatusBannerProps) {
  const [shown, setShown] = useState<{ text: string; tone: StatusTone } | null>(null);
  const [closing, setClosing] = useState(false);

  useEffect(() => {
    if (!props.message) return;
    setShown({ text: props.message, tone: toneOf(props.message) });
    setClosing(false);
  }, [props.message]);

  useEffect(() => {
    if (!shown || shown.tone === "error") return;
    const timeout = window.setTimeout(close, AUTO_DISMISS_MS);
    return () => window.clearTimeout(timeout);
  }, [shown]);

  function close(): void {
    setClosing(true);
    window.setTimeout(() => { setShown(null); props.onDismiss(); }, EXIT_MS);
  }

  if (!shown) return null;
  const Icon = shown.tone === "error" ? CircleAlert : CheckCircle2;
  return (
    <div className={`message-banner message-${shown.tone}${closing ? " message-leaving" : ""}`} role="status">
      <Icon size={16} aria-hidden="true" />
      <span>{shown.text}</span>
      <button type="button" className="message-dismiss" onClick={close} aria-label="关闭提示"><X size={14} /></button>
    </div>
  );
}
