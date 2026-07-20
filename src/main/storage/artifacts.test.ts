import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { maskApplicationId, maskIp, maskName, maskPhone, sanitizeDom } from "../../shared/redaction.js";
import { ArtifactWriter } from "./artifacts.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("ArtifactWriter", () => {
  it("masks pattern-level sensitive DOM values", () => {
    const sanitized = sanitizeDom('<input value="password-value"><p>person@example.test 203.0.113.45 123456 08012345678</p>');

    expect(maskPhone("08012345678")).toBe("080****5678");
    expect(maskIp("203.0.113.45")).toBe("203.0.***.***");
    expect(maskName("山田太郎")).toBe("山田***");
    expect(maskApplicationId("EP2024123400012345")).toBe("**************2345");
    expect(sanitized).not.toContain("password-value");
    expect(sanitized).not.toContain("person@example.test");
    expect(sanitized).not.toContain("203.0.113.45");
    expect(sanitized).not.toContain("123456");
    expect(sanitized).not.toContain("08012345678");
  });

  it("removes DOM values, configured sensitive elements, and known account values before writing HTML", async () => {
    const artifactDir = await tempDirectory();
    const writer = new ArtifactWriter({ accountRunId: "run", stepId: "step", artifactDir, maskSelectors: [".secret"], knownAccountValues: ["password-value", "person@example.test", "203.0.113.45"] });

    const manifest = await writer.captureHtmlSnapshot('<input value="password-value"><textarea>password-value</textarea><div class="secret">person@example.test</div><p>203.0.113.45</p>', "manifest");
    const contents = await readFile(manifest.filePath, "utf8");

    expect(contents).not.toContain("password-value");
    expect(contents).not.toContain("person@example.test");
    expect(contents).not.toContain("203.0.113.45");
    expect(contents).toContain("[redacted]");
  });

  it("requires browser-side masking before screenshot persistence", async () => {
    const writer = new ArtifactWriter({ accountRunId: "run", stepId: "step", artifactDir: await tempDirectory(), maskSelectors: [".secret"], knownAccountValues: [] });

    await expect(writer.captureScreenshot({ screenshot: async () => Buffer.from("image") }, "manifest")).rejects.toThrow("masking preparation hook");
  });

  it("writes a screenshot only after the page prepares masking", async () => {
    const artifactDir = await tempDirectory();
    const prepared: { value: boolean } = { value: false };
    const writer = new ArtifactWriter({ accountRunId: "run", stepId: "step", artifactDir, maskSelectors: [".secret"], knownAccountValues: [] });

    const manifest = await writer.captureScreenshot({ prepareForArtifact: async () => { prepared.value = true; }, screenshot: async () => Buffer.from("masked-image") }, "manifest");

    expect(prepared.value).toBe(true);
    expect(await readFile(manifest.filePath, "utf8")).toBe("masked-image");
  });
});

async function tempDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "eplus-artifacts-"));
  directories.push(directory);
  return directory;
}
