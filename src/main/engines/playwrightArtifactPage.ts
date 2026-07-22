import type { Page } from "playwright-core";
import type { ArtifactPage } from "./browserSessionTypes.js";

export function createPlaywrightArtifactPage(page: Page): ArtifactPage {
  return {
    screenshot: () => page.screenshot(),
    prepareForArtifact: async ({ maskSelectors, knownAccountValues }) => {
      await page.evaluate(
        ({ selectors, values }) => {
          const safeSelectors = [
            ...selectors,
            "input[type='password']",
            "input[autocomplete='cc-number']",
            "input[autocomplete='cc-csc']",
            "input[name*='cvv' i]"
          ];
          for (const selector of safeSelectors) {
            for (const element of Array.from(document.querySelectorAll(selector))) {
              (element as HTMLElement).style.visibility = "hidden";
            }
          }
          for (const element of Array.from(document.querySelectorAll("input, textarea"))) {
            if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement)) continue;
            if (values.includes(element.value)) {
              element.value = "[redacted]";
            }
          }
        },
        { selectors: maskSelectors, values: knownAccountValues }
      );
    }
  };
}
