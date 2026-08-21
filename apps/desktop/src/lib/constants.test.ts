import { describe, it, expect } from "vitest";
import {
  COUNTRY_COORDS,
  REGION_TO_COUNTRY,
  TIMEZONE_TO_COUNTRY,
} from "./constants";

describe("COUNTRY_COORDS", () => {
  it("provides plausible lat/lng for known countries", () => {
    for (const [code, coords] of Object.entries(COUNTRY_COORDS)) {
      expect(coords.lat).toBeGreaterThanOrEqual(-90);
      expect(coords.lat).toBeLessThanOrEqual(90);
      expect(coords.lng).toBeGreaterThanOrEqual(-180);
      expect(coords.lng).toBeLessThanOrEqual(180);
      // Country codes are ISO 3166-1 alpha-2 (two uppercase letters).
      expect(code).toMatch(/^[A-Z]{2}$/);
    }
  });
});

describe("REGION_TO_COUNTRY", () => {
  it("maps every AWS region to a country that has coordinates", () => {
    for (const country of Object.values(REGION_TO_COUNTRY)) {
      expect(COUNTRY_COORDS[country]).toBeDefined();
    }
  });

  it("maps known AWS regions to the expected countries", () => {
    expect(REGION_TO_COUNTRY["us-east-1"]).toBe("US");
    expect(REGION_TO_COUNTRY["eu-west-1"]).toBe("IE");
    expect(REGION_TO_COUNTRY["ap-southeast-1"]).toBe("SG");
    expect(REGION_TO_COUNTRY["local"]).toBe("US");
  });
});

describe("TIMEZONE_TO_COUNTRY", () => {
  it("maps every timezone to a country that has coordinates", () => {
    for (const country of Object.values(TIMEZONE_TO_COUNTRY)) {
      expect(COUNTRY_COORDS[country]).toBeDefined();
    }
  });

  it("maps common timezones to the expected countries", () => {
    expect(TIMEZONE_TO_COUNTRY["Europe/Warsaw"]).toBe("PL");
    expect(TIMEZONE_TO_COUNTRY["Asia/Tokyo"]).toBe("JP");
    expect(TIMEZONE_TO_COUNTRY["America/New_York"]).toBe("US");
  });
});
