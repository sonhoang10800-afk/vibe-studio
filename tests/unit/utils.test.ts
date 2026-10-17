import { describe, it, expect } from "vitest";
import { cn, formatDate } from "@/lib/utils";

describe("src/lib/utils", () => {
  describe("cn()", () => {
    it("should merge class names correctly", () => {
      const result = cn("text-sm", "font-bold");
      expect(result).toBe("text-sm font-bold");
    });

    it("should handle conditional and falsy values", () => {
      const isVisible = false;
      const isSelected = true;
      const result = cn(
        "base-class",
        isVisible && "hidden",
        isSelected && "active-class",
        null,
        undefined
      );
      expect(result).toBe("base-class active-class");
    });

    it("should resolve Tailwind CSS conflicts by keeping the last class", () => {
      const result = cn("px-2 py-1", "px-4");
      expect(result).toBe("py-1 px-4");
    });
  });

  describe("formatDate()", () => {
    it("should format valid ISO string to readable date", () => {
      const result = formatDate("2026-10-17T00:00:00.000Z");
      expect(result).toMatch(/Oct 17, 2026/);
    });

    it("should handle Date objects and numeric timestamps", () => {
      const date = new Date(2026, 0, 15);
      expect(formatDate(date)).toMatch(/Jan 15, 2026/);
      expect(formatDate(date.getTime())).toMatch(/Jan 15, 2026/);
    });

    it("should return 'Invalid Date' for malformed inputs", () => {
      expect(formatDate("not-a-date")).toBe("Invalid Date");
    });
  });
});
