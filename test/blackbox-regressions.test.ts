import { beforeEach, describe, expect, it } from "vitest";
import { cacheClear, extract } from "../src/index.js";

const referenceDate = "2026-04-19";

describe("black-box regressions", () => {
  beforeEach(() => {
    cacheClear();
  });

  it("3개월 전부터 보름 동안의 평일", async () => {
    const res = await extract({
      text: "3개월 전부터 보름 동안의 평일",
      referenceDate,
      outputModes: ["weekdays"],
    });

    expect(res.hasDate).toBe(true);
    expect(res.expressions).toHaveLength(1);
    const weekdays = res.expressions[0].results.find((x) => x.mode === "weekdays");
    expect(weekdays?.value).toEqual([
      "2026-01-19",
      "2026-01-20",
      "2026-01-21",
      "2026-01-22",
      "2026-01-23",
      "2026-01-26",
      "2026-01-27",
      "2026-01-28",
      "2026-01-29",
      "2026-01-30",
      "2026-02-02",
    ]);
  });

  it("연초부터 지금까지 매출", async () => {
    const res = await extract({
      text: "연초부터 지금까지 매출",
      referenceDate,
      outputModes: ["range"],
    });

    expect(res.hasDate).toBe(true);
    const range = res.expressions[0].results.find((x) => x.mode === "range");
    expect(range?.value).toEqual({
      start: "2026-01-01",
      end: "2026-04-19",
    });
  });

  it("3영업일 전 매출", async () => {
    const res = await extract({
      text: "3영업일 전 매출",
      referenceDate,
      outputModes: ["single"],
    });

    expect(res.hasDate).toBe(true);
    const single = res.expressions[0].results.find((x) => x.mode === "single");
    expect(single?.value).toBe("2026-04-15");
  });

  it("이번주 초 실적", async () => {
    const res = await extract({
      text: "이번주 초 실적",
      referenceDate,
      outputModes: ["range"],
    });

    expect(res.hasDate).toBe(true);
    const range = res.expressions[0].results.find((x) => x.mode === "range");
    expect(range?.value).toEqual({
      start: "2026-04-13",
      end: "2026-04-15",
    });
  });

  it("작년 동기 대비 매출", async () => {
    const res = await extract({
      text: "작년 동기 대비 매출",
      referenceDate,
      outputModes: ["range"],
    });

    expect(res.hasDate).toBe(true);
    const range = res.expressions[0].results.find((x) => x.mode === "range");
    expect(range?.value).toEqual({
      start: "2025-01-01",
      end: "2025-04-19",
    });
  });

  it("전월 동월 비교", async () => {
    const res = await extract({
      text: "전월 동월 비교",
      referenceDate,
      outputModes: ["range"],
    });

    expect(res.hasDate).toBe(true);
    expect(res.expressions).toHaveLength(2);
    expect(res.expressions[0].results.find((x) => x.mode === "range")?.value).toEqual({
      start: "2026-03-01",
      end: "2026-03-19",
    });
    expect(res.expressions[1].results.find((x) => x.mode === "range")?.value).toEqual({
      start: "2026-04-01",
      end: "2026-04-19",
    });
  });
});
