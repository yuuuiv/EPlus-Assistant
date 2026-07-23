import { Drawer } from "vaul";
import { X } from "lucide-react";
import { useEffect, useState } from "react";

interface ModalProps {
  readonly open: boolean;
  readonly title?: React.ReactNode;
  readonly subtitle?: string;
  readonly onClose: () => void;
  readonly children?: React.ReactNode;
  readonly wide?: boolean;
}

interface ModalContent {
  readonly title: React.ReactNode;
  readonly subtitle?: string;
  readonly children: React.ReactNode;
}

/** An iOS-style bottom sheet (via vaul) rather than a centered dialog: drag the handle (or the
 *  sheet itself) down to dismiss, with the same rubber-band/spring physics as a native sheet.
 *  Content is latched in local state so it stays visible through the close animation instead of
 *  vanishing the instant the caller stops passing it (which happens the same render `open` flips
 *  to false, since callers clear their "selected" state on close). */
export function Modal(props: ModalProps) {
  const [content, setContent] = useState<ModalContent>();

  useEffect(() => {
    if (props.open && props.title !== undefined) {
      setContent({ title: props.title, subtitle: props.subtitle, children: props.children });
    }
  }, [props.open, props.title, props.subtitle, props.children]);

  if (!content) return null;

  return (
    <Drawer.Root open={props.open} onOpenChange={(open) => { if (!open) props.onClose(); }} noBodyStyles handleOnly>
      <Drawer.Portal>
        <Drawer.Overlay className="drawer-overlay" />
        <Drawer.Content className={props.wide ? "drawer-content drawer-content-wide" : "drawer-content"} aria-describedby={content.subtitle ? undefined : "modal-no-description"}>
          {/* vaul puts will-change:transform on this Content element for the drag animation;
             a scrollable (overflow:auto) descendant of a will-change:transform layer is a known
             Chromium repaint bug (scrolled-to content renders blank) - so the actual scroll
             container lives one level down, off that compositing layer. */}
          <div className="drawer-scroll-area">
            <div className="drawer-handle-wrap"><Drawer.Handle /></div>
            <div className="panel-head modal-head">
              <div>
                <Drawer.Title className="modal-title">{content.title}</Drawer.Title>
                {content.subtitle ? <Drawer.Description className="muted">{content.subtitle}</Drawer.Description> : <span id="modal-no-description" hidden />}
              </div>
              <button type="button" className="icon-button" onClick={props.onClose} aria-label="关闭"><X size={16} /></button>
            </div>
            <div className="modal-body">{content.children}</div>
          </div>
        </Drawer.Content>
      </Drawer.Portal>
    </Drawer.Root>
  );
}
