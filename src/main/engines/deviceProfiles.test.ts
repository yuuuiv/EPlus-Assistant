import { describe, expect, it } from "vitest";
import { DEVICE_PROFILE_KEYS, DEVICE_PROFILES, DEVICE_REGISTRY_DIGEST, PLAYWRIGHT_CORE_VERSION, assertApprovedDeviceProfile, getDeviceProfile, isDeviceProfileKey } from "./deviceProfiles.js";

describe("device profile registry", () => {
  it("uses the installed Playwright descriptor snapshots", () => {
    expect(PLAYWRIGHT_CORE_VERSION).toBe("1.61.1");
    expect(getDeviceProfile("desktop-chrome")).toMatchObject({ viewport: { width: 1280, height: 720 }, screen: { width: 1920, height: 1080 }, isMobile: false, hasTouch: false });
    expect(getDeviceProfile("iphone-13")).toMatchObject({ viewport: { width: 390, height: 664 }, screen: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
    expect(getDeviceProfile("pixel-7")).toMatchObject({ viewport: { width: 412, height: 839 }, screen: { width: 412, height: 915 }, deviceScaleFactor: 2.625, isMobile: true, hasTouch: true });
    expect(Object.keys(DEVICE_PROFILES)).toEqual(["desktop-chrome", "desktop-edge", "iphone-13", "iphone-15", "iphone-se", "pixel-7", "pixel-8", "galaxy-s24", "ipad-gen7"]);
    expect(DEVICE_REGISTRY_DIGEST).toHaveLength(64);
  });

  it("expands the catalogue with real, distinct Playwright device descriptors for every approved key", () => {
    for (const key of DEVICE_PROFILE_KEYS) {
      const descriptor = getDeviceProfile(key);
      expect(descriptor.viewport.width).toBeGreaterThan(0);
      expect(descriptor.viewport.height).toBeGreaterThan(0);
      expect(descriptor.screen.width).toBeGreaterThan(0);
      expect(descriptor.screen.height).toBeGreaterThan(0);
      expect(descriptor.userAgent.length).toBeGreaterThan(0);
    }
    expect(getDeviceProfile("iphone-15")).toMatchObject({ isMobile: true, hasTouch: true });
    expect(getDeviceProfile("pixel-8")).toMatchObject({ isMobile: true, hasTouch: true });
    expect(getDeviceProfile("galaxy-s24")).toMatchObject({ isMobile: true, hasTouch: true });
    expect(getDeviceProfile("ipad-gen7")).toMatchObject({ isMobile: true, hasTouch: true });
    expect(getDeviceProfile("desktop-edge")).toMatchObject({ isMobile: false, hasTouch: false });
    expect(isDeviceProfileKey("iphone-se")).toBe(true);
    expect(isDeviceProfileKey("android-custom")).toBe(false);
  });

  it("rejects unapproved profile and override values", () => {
    expect(() => assertApprovedDeviceProfile("android-custom")).toThrow("Invalid device profile");
    expect(() => assertApprovedDeviceProfile({ userAgent: "custom" })).toThrow("Invalid device profile");
  });
});
