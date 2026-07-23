import { Check, Copy } from "lucide-react";
import { useEffect, useState } from "react";

interface CopyButtonProps {
  readonly value: string;
  readonly label?: string;
  readonly disabled?: boolean;
}

/** Small inline "copy to clipboard" affordance for values the user needs to paste elsewhere
 *  (email/password/phone) now that login is a manual browser flow rather than automation. */
export function CopyButton(props: CopyButtonProps) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timeout = window.setTimeout(() => setCopied(false), 1_500);
    return () => window.clearTimeout(timeout);
  }, [copied]);

  async function copy(): Promise<void> {
    await navigator.clipboard.writeText(props.value);
    setCopied(true);
  }

  return <button
    type="button"
    className={copied ? "icon-button copy-button copied" : "icon-button copy-button"}
    disabled={props.disabled || !props.value}
    onClick={() => void copy()}
    title={props.label ? `复制${props.label}` : "复制"}
    aria-label={props.label ? `复制${props.label}` : "复制"}
  >
    {copied ? <Check key="check" size={14} /> : <Copy key="copy" size={14} />}
  </button>;
}
