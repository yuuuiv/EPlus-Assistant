import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  classifyPageState,
  defaultSelectorHints,
  type PageState
} from "./pageStateClassifier.js";

const fixtureDirectory = join(__dirname, "fixtures");

async function loadFixture(name: string): Promise<string> {
  return readFile(join(fixtureDirectory, name), "utf8");
}

function classifyFixture(url: string, html: string) {
  return classifyPageState({ url, html, selectors: defaultSelectorHints() });
}

const fixtureCases: ReadonlyArray<readonly [string, PageState, readonly string[]]> = [
  ["login.html", "Login", ["fill email", "click login"]],
  ["email-code.html", "EmailCode", ["fill verification code"]],
  ["captcha-slider.html", "CaptchaSliderDevice", []],
  ["interstitial-consent.html", "InterstitialConsent", ["click confirmation"]],
  ["checkbox-gate.html", "CheckboxGate", ["request manual confirmation"]],
  ["lottery-form.html", "LotteryForm", ["select ticket options"]],
  ["day-selection.html", "DaySelection", ["select requested day"]],
  ["receipt.html", "Receipt", []],
  ["reception-closed.html", "ReceptionClosed", []]
];

describe("pageStateClassifier", () => {
  describe("happy path - each fixture returns its expected state", () => {
    it.each(fixtureCases)("classifies %s as %s", async (fixtureName, expectedState, expectedHints) => {
      const html = await loadFixture(fixtureName);

      const classified = classifyFixture("https://eplus.jp/sf/apply", html);

      expect(classified.state).toBe(expectedState);
      expect(classified.confidence).toBeGreaterThan(0.7);
      for (const hint of expectedHints) {
        expect(classified.safeActionHints).toContain(hint);
      }
    });
  });

  describe("state priority", () => {
    it("prefers closed reception over a receipt, login form, and lottery form", () => {
      const classified = classifyFixture(
        "https://eplus.jp/login",
        `
          <p>受付は終了しました。</p>
          <p>受付番号: 12345</p>
          <form><input type="email"><input type="password"><select name="ticket"></select>抽選申込み</form>
        `
      );

      expect(classified.state).toBe("ReceptionClosed");
      expect(classified.safeActionHints).toEqual([]);
    });

    it("prefers CAPTCHA over a login form", () => {
      const classified = classifyFixture(
        "https://eplus.jp/login",
        `
          <form><input type="email"><input type="password"></form>
          <iframe src="https://www.google.com/recaptcha/api2/anchor"></iframe>
        `
      );

      expect(classified.state).toBe("CaptchaSliderDevice");
      expect(classified.safeActionHints).toEqual([]);
    });

    it("prefers receipt evidence over a login form", () => {
      const classified = classifyFixture(
        "https://eplus.jp/login",
        `<p>申込完了</p><form><input type="email"><input type="password"></form>`
      );

      expect(classified.state).toBe("Receipt");
    });

  it("recognizes a serial form before the phone-verification notice", () => {
      const classified = classifyFixture(
        "https://eplus.jp/serial/mygo_3rdAL",
        `<h1>シリアル先行</h1><p>電話番号認証が必要です。</p><input name="ninsho_key1_1" placeholder="シリアルコード"><button name="action" value="moushikomi">お申込みへ</button>`
      );

      expect(classified.state).toBe("SerialCode");
      expect(classified.requiresManualTakeover).toBe(false);
      expect(classified.safeActionHints).toContain("fill serial code");
    });
  });

  it("does not treat a generic phone notice as a phone login challenge", () => {
    const classified = classifyPageState({ html: "<main><p>電話番号認証が必要</p><h1>抽選受付</h1></main>", url: "https://eplus.jp/sf/detail/1", selectors: defaultSelectorHints() });
    expect(classified.state).not.toBe("CaptchaSliderDevice");
  });

  describe("unknown/changed markup", () => {
    it("returns Unknown with a manifest and no actions for ambiguous markup", async () => {
      const html = await loadFixture("unknown.html");

      const classified = classifyFixture("https://eplus.jp/changed", html);

      expect(classified.state).toBe("Unknown");
      expect(classified.requiresManualTakeover).toBe(true);
      expect(classified.safeActionHints).toEqual([]);
      expect(classified.manifestEntry).toEqual({
        selectorConfidence: {
          loginButton: false,
          cautionNextButton: false,
          finalConsentButton: false
        },
        matchedPatterns: []
      });
    });
  });

  describe("manual takeover states", () => {
    it.each(["captcha-slider.html", "unknown.html", "reception-closed.html"] as const)(
      "gives %s zero click or fill permission",
      async (fixtureName) => {
        const html = await loadFixture(fixtureName);

        const classified = classifyFixture("https://eplus.jp/sf/apply", html);

        expect(classified.requiresManualTakeover).toBe(true);
        expect(classified.safeActionHints).toEqual([]);
      }
    );

    it("does not auto-approve a generic required checkbox", async () => {
      const html = await loadFixture("checkbox-gate.html");

      const classified = classifyFixture("https://eplus.jp/sf/apply", html);

      expect(classified.state).toBe("CheckboxGate");
      expect(classified.safeActionHints).not.toContain("check terms");
    });
  });

  describe("does not mutate", () => {
    it("preserves the supplied HTML string", async () => {
      const html = await loadFixture("login.html");
      const originalHtml = html;

      classifyFixture("https://eplus.jp/login", html);

      expect(html).toBe(originalHtml);
    });
  });
});
