import { describe, it, expect } from "vitest";
import {
  TIERS,
  getTierFromPriceId,
  getTierConfig,
  yearlyBillingEnabled,
} from "@/lib/tiers";

describe("Tiers configuration", () => {
  it("should have correct Basic tier configuration", () => {
    const basic = TIERS.basic;
    expect(basic.name).toBe("Basic");
    expect(basic.price).toBe(10);
    expect(basic.deviceLimit).toBe(1);
    expect(basic.features).toContain("1 device");
  });

  it("should have correct Pro tier configuration", () => {
    const pro = TIERS.pro;
    expect(pro.name).toBe("Pro");
    expect(pro.price).toBe(30);
    expect(pro.deviceLimit).toBe(5);
    expect(pro.features).toContain("5 devices");
    expect(pro.features).toContain("Priority support");
  });

  it("should have correct Enterprise tier configuration", () => {
    const enterprise = TIERS.enterprise;
    expect(enterprise.name).toBe("Enterprise");
    expect(enterprise.price).toBe(1000);
    expect(enterprise.deviceLimit).toBe(999);
    expect(enterprise.features).toContain("Unlimited devices");
    expect(enterprise.features).toContain("Dedicated support");
  });

  it("should get tier from price ID", () => {
    // The tier matching works based on what's in TIERS object
    // For testing, we just verify the fallback behavior
    const tier = getTierFromPriceId("unknown_price_id");
    expect(tier).toBe("basic"); // Falls back to basic
  });

  it("should default to basic for unknown price ID", () => {
    const tier = getTierFromPriceId("unknown_price");
    expect(tier).toBe("basic");
  });

  it("should get tier config by name", () => {
    const proConfig = getTierConfig("pro");
    expect(proConfig.name).toBe("Pro");
    expect(proConfig.deviceLimit).toBe(5);
  });

  describe("yearly billing", () => {
    it("resolves a monthly price ID to its tier", () => {
      expect(getTierFromPriceId("price_basic_test")).toBe("basic");
      expect(getTierFromPriceId("price_pro_test")).toBe("pro");
    });

    it("resolves a yearly price ID to its tier", () => {
      expect(getTierFromPriceId("price_basic_yearly_test")).toBe("basic");
      expect(getTierFromPriceId("price_pro_yearly_test")).toBe("pro");
    });

    it("exposes yearly price and price ID for configured tiers", () => {
      expect(TIERS.basic.yearlyPrice).toBe(100);
      expect(TIERS.basic.yearlyPriceId).toBe("price_basic_yearly_test");
      expect(TIERS.pro.yearlyPrice).toBe(300);
      expect(TIERS.pro.yearlyPriceId).toBe("price_pro_yearly_test");
    });

    it("leaves yearly price ID unset for tiers without a configured env var", () => {
      // Enterprise yearly is intentionally unset in the test environment.
      expect(TIERS.enterprise.yearlyPriceId).toBeFalsy();
    });

    it("reports yearly billing enabled per-tier based on configured ID", () => {
      expect(yearlyBillingEnabled("basic")).toBe(true);
      expect(yearlyBillingEnabled("pro")).toBe(true);
      expect(yearlyBillingEnabled("enterprise")).toBe(false);
    });

    it("reports yearly billing globally enabled when any tier has a yearly ID", () => {
      expect(yearlyBillingEnabled()).toBe(true);
    });
  });
});
