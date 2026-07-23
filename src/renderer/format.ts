/** The eplus.jp page stores some fields (credit card brand names like "ＶＩＳＡ"/"Ｍａｓｔｅｒ")
 *  in fullwidth Unicode forms; the collector copies them verbatim, but they read as oddly
 *  spaced-out in a Latin UI, so normalize to regular ASCII for display. */
export function toHalfWidth(value: string): string {
  return value.replace(/[！-～]/g, (char) => String.fromCharCode(char.charCodeAt(0) - 0xFEE0));
}

export function formatDateTime(iso: string | undefined): string {
  if (!iso) return "-";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

export function formatPercent(rate: number | null): string {
  return rate === null ? "-" : `${Math.round(rate * 100)}%`;
}

/** RFC 4180-ish: wraps a field in quotes and doubles any embedded quotes whenever the raw
 *  value could otherwise be mistaken for a delimiter, quote, or line break. */
export function csvCell(value: string | number | undefined | null): string {
  const text = value === undefined || value === null ? "" : String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function downloadTextFile(filename: string, content: string, mimeType: string): void {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

/** Serializes an inline SVG element to a PNG and downloads it. Draws the SVG into an
 *  off-screen canvas at 2x for crisper export, since chart SVGs here have no external
 *  resources (no <image>/web fonts) that would need extra handling to rasterize. */
export async function downloadSvgAsPng(svg: SVGSVGElement, filename: string, background: string): Promise<void> {
  const scale = 2;
  const width = svg.viewBox.baseVal.width || svg.clientWidth;
  const height = svg.viewBox.baseVal.height || svg.clientHeight;
  const serialized = new XMLSerializer().serializeToString(svg);
  const svgUrl = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(serialized)}`;

  const image = new Image();
  const loaded = new Promise<void>((resolve, reject) => {
    image.onload = () => resolve();
    image.onerror = () => reject(new Error("图表渲染失败"));
  });
  image.src = svgUrl;
  await loaded;

  const canvas = document.createElement("canvas");
  canvas.width = width * scale;
  canvas.height = height * scale;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("无法创建画布");
  context.fillStyle = background;
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.scale(scale, scale);
  context.drawImage(image, 0, 0, width, height);

  const blob: Blob | null = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
  if (!blob) throw new Error("导出图片失败");
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
