import { describe, it, expect } from "vitest";
import { extract, cacheClear } from "../src/index.js";

describe("defaultToToday 옵션", () => {
  it("날짜 없는 쿼리 + defaultToToday=true → 오늘 반환", async () => {
    cacheClear();
    const r = await extract({
      text: "증권 계좌 잔액",
      referenceDate: "2025-11-17",
      outputModes: ["range", "single"],
      defaultToToday: true,
    });
    expect(r.hasDate).toBe(true);
    expect(r.expressions).toHaveLength(1);
    const range = r.expressions[0].results.find((x) => x.mode === "range");
    expect(range?.value).toEqual({ start: "2025-11-17", end: "2025-11-17" });
    const single = r.expressions[0].results.find((x) => x.mode === "single");
    expect(single?.value).toBe("2025-11-17");
    expect(r.expressions[0].confidence).toBe(0);
  });

  it("날짜 없는 쿼리 + defaultToToday=false (기본) → hasDate=false", async () => {
    cacheClear();
    const r = await extract({
      text: "증권 계좌 잔액",
      referenceDate: "2025-11-17",
      outputModes: ["single"],
    });
    expect(r.hasDate).toBe(false);
    expect(r.expressions).toHaveLength(0);
  });

  it("명시적 날짜 있는 쿼리 + defaultToToday=true → 명시된 날짜 반환 (폴백 무시)", async () => {
    cacheClear();
    const r = await extract({
      text: "어제 잔액",
      referenceDate: "2025-11-17",
      outputModes: ["single"],
      defaultToToday: true,
    });
    expect(r.hasDate).toBe(true);
    const single = r.expressions[0].results.find((x) => x.mode === "single");
    expect(single?.value).toBe("2025-11-16");
  });

  it("defaultToToday=true + LLM 에러 시에도 오늘 반환 (error 없음)", async () => {
    cacheClear();
    const r = await extract({
      text: "보통예금 얼마 있어?",
      referenceDate: "2025-11-17",
      outputModes: ["single"],
      defaultToToday: true,
    });
    expect(r.hasDate).toBe(true);
    expect(r.meta.error).toBeUndefined();
    const single = r.expressions[0].results.find((x) => x.mode === "single");
    expect(single?.value).toBe("2025-11-17");
  });
});
