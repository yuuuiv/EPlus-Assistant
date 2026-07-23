import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

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
