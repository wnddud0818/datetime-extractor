import { describe, expect, it } from "vitest";
import { cacheClear, extract } from "../src/index.js";

describe("cache key option isolation", () => {
  it("presentRangeEnd가 다른 요청은 서로 다른 캐시 엔트리를 사용한다", async () => {
    cacheClear();

    const fullPeriod = await extract({
      text: "이번달",
      referenceDate: "2025-11-17",
      outputModes: ["range"],
      presentRangeEnd: "period",
    });

    const clampedToToday = await extract({
      text: "이번달",
      referenceDate: "2025-11-17",
      outputModes: ["range"],
      presentRangeEnd: "today",
    });

    expect(fullPeriod.expressions[0].results[0]).toEqual({
      mode: "range",
      value: { start: "2025-11-01", end: "2025-11-30" },
    });
    expect(clampedToToday.expressions[0].results[0]).toEqual({
      mode: "range",
      value: { start: "2025-11-01", end: "2025-11-17" },
    });
    expect(clampedToToday.meta.path).toBe("rule");
  });
});
