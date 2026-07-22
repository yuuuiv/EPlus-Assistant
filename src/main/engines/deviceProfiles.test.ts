import { describe, expect, it } from "vitest";
import { DEVICE_PROFILES, DEVICE_REGISTRY_DIGEST, PLAYWRIGHT_CORE_VERSION, assertApprovedDeviceProfile, getDeviceProfile } from "./deviceProfiles.js";

describe("device profile registry", () => {
  it("uses the installed Playwright descriptor snapshots", () => {
    expect(PLAYWRIGHT_CORE_VERSION).toBe("1.61.1");
    expect(getDeviceProfile("desktop-chrome")).toMatchObject({ viewport: { width: 1280, height: 720 }, screen: { width: 1920, height: 1080 }, isMobile: false, hasTouch: false });
    expect(getDeviceProfile("iphone-13")).toMatchObject({ viewport: { width: 390, height: 664 }, screen: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
    expect(getDeviceProfile("pixel-7")).toMatchObject({ viewport: { width: 412, height: 839 }, screen: { width: 412, height: 915 }, deviceScaleFactor: 2.625, isMobile: true, hasTouch: true });
    expect(DEVICE_REGISTRY_DIGEST).toBe("bf01fed7710348d4ad9b520be86e4e98d76d3dcad4b55844b22fac467ec2691e");
    expect(Object.keys(DEVICE_PROFILES)).toEqual(["desktop-chrome", "iphone-13", "pixel-7"]);
  });

  it("rejects unapproved profile and override values", () => {
    expect(() => assertApprovedDeviceProfile("android-custom")).toThrow("Invalid device profile");
    expect(() => assertApprovedDeviceProfile({ userAgent: "custom" })).toThrow("Invalid device profile");
  });
});
