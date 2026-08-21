import { describe, expect, it } from "vitest";
import { formatBytes, formatDuration, formatRate } from "./StatusPanel";

describe("formatBytes", () => {
  it("formats small byte counts without decimals", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(512)).toBe("512 B");
  });

  it("formats KB/MB/GB", () => {
    expect(formatBytes(1024)).toBe("1.00 KB");
    expect(formatBytes(1024 * 1024)).toBe("1.00 MB");
    expect(formatBytes(1024 * 1024 * 1024)).toBe("1.00 GB");
  });

  it("uses one decimal for values >= 10", () => {
    expect(formatBytes(15 * 1024 * 1024)).toBe("15.0 MB");
  });

  it("clamps negatives to zero", () => {
    expect(formatBytes(-5)).toBe("0 B");
  });
});

describe("formatRate", () => {
  it("appends /s", () => {
    expect(formatRate(1024)).toBe("1.00 KB/s");
    expect(formatRate(0)).toBe("0 B/s");
  });
});

describe("formatDuration", () => {
  it("formats minutes:seconds", () => {
    expect(formatDuration(0)).toBe("0:00");
    expect(formatDuration(65)).toBe("1:05");
  });

  it("formats hours:minutes:seconds", () => {
    expect(formatDuration(3661)).toBe("1:01:01");
  });

  it("clamps negatives", () => {
    expect(formatDuration(-10)).toBe("0:00");
  });
});
