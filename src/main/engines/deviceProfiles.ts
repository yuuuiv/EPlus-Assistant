import { createHash } from "node:crypto";
import { devices } from "playwright-core";
import type { DeviceProfileKey } from "../../shared/types.js";

export const PLAYWRIGHT_CORE_VERSION = "1.61.1";

export interface DeviceProfileDescriptor {
  readonly viewport: { readonly width: number; readonly height: number };
  readonly userAgent: string;
  readonly deviceScaleFactor: number;
  readonly isMobile: boolean;
  readonly hasTouch: boolean;
  readonly defaultBrowserType: "chromium" | "firefox" | "webkit";
  readonly screen: { readonly width: number; readonly height: number };
}

const descriptorFor = (name: string): DeviceProfileDescriptor => {
  const descriptor = devices[name];
  if (!descriptor) throw new Error(`Missing approved Playwright device descriptor: ${name}`);
  const screen = name === "Desktop Chrome"
    ? { width: 1920, height: 1080 }
    : name === "iPhone 13"
      ? { width: 390, height: 844 }
      : { width: 412, height: 915 };
  return Object.freeze({ ...descriptor, viewport: Object.freeze({ ...descriptor.viewport }), screen: Object.freeze({ ...screen }) });
};

export const DEVICE_PROFILES: Readonly<Record<DeviceProfileKey, DeviceProfileDescriptor>> = Object.freeze({
  "desktop-chrome": descriptorFor("Desktop Chrome"),
  "iphone-13": descriptorFor("iPhone 13"),
  "pixel-7": descriptorFor("Pixel 7")
});

export const DEVICE_REGISTRY_DIGEST = createHash("sha256")
  .update(JSON.stringify({ playwrightCore: PLAYWRIGHT_CORE_VERSION, profiles: DEVICE_PROFILES }))
  .digest("hex");

export function isDeviceProfileKey(value: unknown): value is DeviceProfileKey {
  return value === "desktop-chrome" || value === "iphone-13" || value === "pixel-7";
}

export function getDeviceProfile(key: DeviceProfileKey = "desktop-chrome"): DeviceProfileDescriptor {
  return DEVICE_PROFILES[key];
}

export function assertApprovedDeviceProfile(value: unknown): DeviceProfileKey {
  if (!isDeviceProfileKey(value)) throw new Error(`Invalid device profile: ${String(value)}`);
  return value;
}
