import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { chromium } from "playwright-core";

/** Loads only local process configuration. Nothing from this module is exposed to the renderer. */
export function loadLocalEnv(projectRoot = process.cwd()): void {
  const envFile = path.join(projectRoot, ".env");
  if (!existsSync(envFile)) return;
  for (const line of readFileSync(envFile, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!match || process.env[match[1]]) continue;
    const value = match[2]?.trim().replace(/^['"]|['"]$/g, "") ?? "";
    process.env[match[1]] = value;
  }
}

export function resolveBrowserExecutable(explicit = process.env.EPLUS_BROWSER_EXECUTABLE): string {
  const candidates = [
    explicit,
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, "Google", "Chrome", "Application", "chrome.exe") : undefined,
    process.env.PROGRAMFILES ? path.join(process.env.PROGRAMFILES, "Google", "Chrome", "Application", "chrome.exe") : undefined,
    process.env["PROGRAMFILES(X86)"] ? path.join(process.env["PROGRAMFILES(X86)"], "Google", "Chrome", "Application", "chrome.exe") : undefined,
    process.env.PROGRAMFILES ? path.join(process.env.PROGRAMFILES, "Microsoft", "Edge", "Application", "msedge.exe") : undefined,
    chromium.executablePath()
  ].filter((candidate): candidate is string => Boolean(candidate));
  const resolved = candidates.find((candidate) => existsSync(candidate));
  if (!resolved) throw new Error("未找到可见 Chromium 浏览器。请安装 Chrome/Edge，或在 .env 设置 EPLUS_BROWSER_EXECUTABLE。");
  return resolved;
}
