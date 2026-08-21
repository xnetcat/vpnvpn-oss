import { describe, it, expect } from "vitest";
import { API_BASE_URL } from "./lib/config";

describe("desktop App config", () => {
  it("exposes a sensible default API URL", () => {
    expect(API_BASE_URL).toMatch(/^https?:\/\//);
  });
});
