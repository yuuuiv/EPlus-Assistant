import { useMemo } from "react";
import { useThemeMode } from "./theme.js";

/** Resolves design-token CSS variables to concrete color strings for use inside chart SVGs.
 *  Charts get exported to PNG by serializing the <svg> and rasterizing it in a detached
 *  <img> (see format.ts downloadSvgAsPng) - that image has no connection to this document's
 *  stylesheet cascade, so a fill of "var(--primary)" would render as black/transparent in the
 *  export. Resolving to a concrete hex/rgb string here bakes the real color into the SVG. */
export function useThemeColors() {
  const mode = useThemeMode();
  return useMemo(() => {
    const style = getComputedStyle(document.documentElement);
    const read = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback;
    return {
      primary: read("--primary", "#365fa1"),
      info: read("--info", "#3c4686"),
      warning: read("--warning", "#617a29"),
      success: read("--success", "#3d715c"),
      danger: read("--danger", "#d43f3f"),
      muted: read("--text-subtle", "#8891a1"),
      textMuted: read("--text-muted", "#5b6472"),
      text: read("--text", "#1a2130"),
      surfaceC: read("--surface-c", "rgba(15,23,42,0.09)"),
      surfaceSolid: read("--bg-surface-solid", "#ffffff")
    };
  }, [mode]);
}
