import { X } from "lucide-react";
import { useEffect, useRef } from "react";

interface ModalProps {
  readonly title: string;
  readonly subtitle?: string;
  readonly onClose: () => void;
  readonly children: React.ReactNode;
  readonly wide?: boolean;
}

export function Modal(props: ModalProps) {
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === "Escape") props.onClose();
    }
    document.addEventListener("keydown", onKeyDown);
    dialogRef.current?.focus();
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [props]);

  return <div className="modal-overlay" onMouseDown={(event) => { if (event.target === event.currentTarget) props.onClose(); }}>
    <div
      ref={dialogRef}
      className={props.wide ? "modal-dialog modal-dialog-wide" : "modal-dialog"}
      role="dialog"
      aria-modal="true"
      aria-labelledby="modal-title"
      tabIndex={-1}
    >
      <div className="panel-head modal-head">
        <div><h2 id="modal-title">{props.title}</h2>{props.subtitle ? <span className="muted">{props.subtitle}</span> : null}</div>
        <button type="button" className="icon-button" onClick={props.onClose} aria-label="关闭"><X size={16} /></button>
      </div>
      <div className="modal-body">{props.children}</div>
    </div>
  </div>;
}
