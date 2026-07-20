import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { redactAccountValues, sanitizeDom } from "../../shared/redaction.js";

export interface ArtifactWriterOptions {
  readonly accountRunId: string;
  readonly stepId: string;
  readonly artifactDir: string;
  readonly maskSelectors: readonly string[];
  readonly knownAccountValues: readonly string[];
}

export interface ArtifactManifestEntry {
  readonly id: string;
  readonly filePath: string;
  readonly kind: "screenshot" | "html-snapshot";
  readonly maskedSelectors: readonly string[];
  readonly sizeBytes: number;
}

interface ScreenshotPage {
  screenshot(): Promise<Buffer>;
  prepareForArtifact?(options: { readonly maskSelectors: readonly string[]; readonly knownAccountValues: readonly string[] }): Promise<void>;
}

export class ArtifactWriter {
  constructor(private readonly options: ArtifactWriterOptions) {}

  async captureScreenshot(page: ScreenshotPage, manifestId: string): Promise<ArtifactManifestEntry> {
    if (this.options.maskSelectors.length > 0 || this.options.knownAccountValues.length > 0) {
      if (!page.prepareForArtifact) {
        throw new Error("Screenshot capture requires a masking preparation hook.");
      }
      await page.prepareForArtifact({ maskSelectors: this.options.maskSelectors, knownAccountValues: this.options.knownAccountValues });
    }
    const contents = await page.screenshot();
    return this.writeArtifact(manifestId, "screenshot", "png", contents);
  }

  async captureHtmlSnapshot(html: string, manifestId: string): Promise<ArtifactManifestEntry> {
    const sanitized = redactAccountValues(sanitizeDom(html, this.options.maskSelectors), this.options.knownAccountValues);
    for (const value of this.options.knownAccountValues) {
      if (value.length > 0 && sanitized.includes(value)) {
        throw new Error("Sanitized artifact still contains an account value.");
      }
    }
    return this.writeArtifact(manifestId, "html-snapshot", "html", Buffer.from(sanitized));
  }

  private async writeArtifact(manifestId: string, kind: ArtifactManifestEntry["kind"], extension: string, contents: Buffer): Promise<ArtifactManifestEntry> {
    const directory = path.join(this.options.artifactDir, this.options.accountRunId, this.options.stepId);
    const filePath = path.join(directory, `${kind === "screenshot" ? "screenshot" : "snapshot"}-${manifestId}.${extension}`);
    await mkdir(directory, { recursive: true });
    await writeFile(filePath, contents);
    return { id: manifestId, filePath, kind, maskedSelectors: this.options.maskSelectors, sizeBytes: contents.byteLength };
  }
}
