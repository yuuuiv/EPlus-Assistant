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

const DESKTOP_SCREEN = { width: 1920, height: 1080 };

// Playwright device name + full "screen" resolution (viewport for mobile/tablet devices,
// the outer monitor resolution for desktop ones) for every approved device profile.
const DEVICE_REGISTRY: Readonly<Record<DeviceProfileKey, { readonly playwrightName: string; readonly screen: { readonly width: number; readonly height: number } }>> = {
  "desktop-chrome": { playwrightName: "Desktop Chrome", screen: DESKTOP_SCREEN },
  "desktop-edge": { playwrightName: "Desktop Edge", screen: DESKTOP_SCREEN },
  "iphone-13": { playwrightName: "iPhone 13", screen: { width: 390, height: 844 } },
  "iphone-15": { playwrightName: "iPhone 15", screen: { width: 393, height: 852 } },
  "iphone-se": { playwrightName: "iPhone SE (3rd gen)", screen: { width: 375, height: 667 } },
  "pixel-7": { playwrightName: "Pixel 7", screen: { width: 412, height: 915 } },
  "pixel-8": { playwrightName: "Pixel 8", screen: { width: 412, height: 915 } },
  "galaxy-s24": { playwrightName: "Galaxy S24", screen: { width: 384, height: 832 } },
  "ipad-gen7": { playwrightName: "iPad (gen 7)", screen: { width: 810, height: 1080 } }
};

const descriptorFor = (name: string, screen: { readonly width: number; readonly height: number }): DeviceProfileDescriptor => {
  const descriptor = devices[name];
  if (!descriptor) throw new Error(`Missing approved Playwright device descriptor: ${name}`);
  return Object.freeze({ ...descriptor, viewport: Object.freeze({ ...descriptor.viewport }), screen: Object.freeze({ ...screen }) });
};

export const DEVICE_PROFILE_KEYS = Object.keys(DEVICE_REGISTRY) as readonly DeviceProfileKey[];

export const DEVICE_PROFILES: Readonly<Record<DeviceProfileKey, DeviceProfileDescriptor>> = Object.freeze(
  Object.fromEntries(DEVICE_PROFILE_KEYS.map((key) => [key, descriptorFor(DEVICE_REGISTRY[key].playwrightName, DEVICE_REGISTRY[key].screen)])) as Record<DeviceProfileKey, DeviceProfileDescriptor>
);

export const DEVICE_REGISTRY_DIGEST = createHash("sha256")
  .update(JSON.stringify({ playwrightCore: PLAYWRIGHT_CORE_VERSION, profiles: DEVICE_PROFILES }))
  .digest("hex");

export function isDeviceProfileKey(value: unknown): value is DeviceProfileKey {
  return typeof value === "string" && DEVICE_PROFILE_KEYS.includes(value as DeviceProfileKey);
}

export function getDeviceProfile(key: DeviceProfileKey = "desktop-chrome"): DeviceProfileDescriptor {
  return DEVICE_PROFILES[key];
}

export function assertApprovedDeviceProfile(value: unknown): DeviceProfileKey {
  if (!isDeviceProfileKey(value)) throw new Error(`Invalid device profile: ${String(value)}`);
  return value;
}
