import { describe, it, expect } from "vitest";
import { runRules } from "../src/rules/engine.js";
import { detectLocale } from "../src/rules/detect-locale.js";

describe("detectLocale", () => {
  it("한국어 문자 포함 → ko", () => {
    expect(detectLocale("저번 달")).toBe("ko");
    expect(detectLocale("3월 매출")).toBe("ko");
  });
  it("영어만 → en", () => {
    expect(detectLocale("last month")).toBe("en");
    expect(detectLocale("3/15/2025")).toBe("en");
    expect(detectLocale("")).toBe("en");
  });
  it("혼합 입력 → 한국어 지배", () => {
    expect(detectLocale("March 잔액")).toBe("ko");
  });
});

describe("runRules locale dispatch", () => {
  it("locale=en 강제 시 한국어 패턴 매치되지 않음", () => {
    const r = runRules("3월 매출", "en");
    expect(r.expressions).toHaveLength(0);
  });
  it("locale=ko 강제 시 영어 패턴 매치되지 않음", () => {
    const r = runRules("last month sales", "ko");
    expect(r.expressions).toHaveLength(0);
  });
  it("locale=auto → 영어 입력이면 영어 룰 사용", () => {
    const r = runRules("last month sales");
    expect(r.confidence).toBe(1.0);
    expect(r.expressions[0].expression).toEqual({
      kind: "relative",
      unit: "month",
      offset: -1,
    });
  });
  it("locale=auto → 한국어 입력이면 한국어 룰 사용", () => {
    const r = runRules("저번 달 잔액");
    expect(r.confidence).toBe(1.0);
    expect(r.expressions[0].expression).toEqual({
      kind: "relative",
      unit: "month",
      offset: -1,
    });
  });
});

describe("English rules - absolute dates", () => {
  it("ISO 2025-12-25 → absolute", () => {
    const r = runRules("2025-12-25 balance", "en");
    expect(r.expressions[0].expression).toEqual({
      kind: "absolute",
      year: 2025,
      month: 12,
      day: 25,
    });
  });

  it("YYYYMMDD 20250412 → absolute", () => {
    const r = runRules("20250412 balance", "en");
    expect(r.expressions).toHaveLength(1);
    expect(r.expressions[0].expression).toEqual({
      kind: "absolute",
      year: 2025,
      month: 4,
      day: 12,
    });
  });

  it("MMDD 0412 → absolute without year", () => {
    const r = runRules("0412 balance", "en");
    expect(r.expressions).toHaveLength(1);
    expect(r.expressions[0].expression).toEqual({
      kind: "absolute",
      month: 4,
      day: 12,
    });
  });

  it("MMDD with invalid month/day is ignored", () => {
    const r = runRules("9999 balance", "en");
    expect(r.expressions).toHaveLength(0);
  });

  it("US M/D/Y 3/15/2025 → absolute", () => {
    const r = runRules("3/15/2025 balance", "en");
    expect(r.expressions[0].expression).toEqual({
      kind: "absolute",
      year: 2025,
      month: 3,
      day: 15,
    });
  });

  it("March 15, 2025 → absolute full", () => {
    const r = runRules("March 15, 2025 meeting", "en");
    expect(r.expressions[0].expression).toEqual({
      kind: "absolute",
      year: 2025,
      month: 3,
      day: 15,
    });
  });

  it("Mar 15 (no year) → absolute m/d", () => {
    const r = runRules("see you on Mar 15", "en");
    expect(r.expressions[0].expression).toEqual({
      kind: "absolute",
      month: 3,
      day: 15,
    });
  });

  it("March 2025 (no day) → absolute y/m", () => {
    const r = runRules("revenue in March 2025", "en");
    const expr = r.expressions.find(
      (e) =>
        e.expression.kind === "absolute" &&
        e.expression.year === 2025 &&
        e.expression.month === 3 &&
        e.expression.day === undefined,
    );
    expect(expr).toBeDefined();
  });

  it("March alone → absolute month", () => {
    const r = runRules("March sales", "en");
    expect(r.expressions[0].expression).toEqual({
      kind: "absolute",
      month: 3,
    });
  });

  it("year alone (2025) → absolute year", () => {
    const r = runRules("the 2025 report", "en");
    expect(r.expressions.some((e) =>
      e.expression.kind === "absolute" && e.expression.year === 2025,
    )).toBe(true);
  });

  it("early March → monthPart=early", () => {
    const r = runRules("early March", "en");
    expect(r.expressions[0].expression).toEqual({
      kind: "absolute",
      month: 3,
      monthPart: "early",
    });
  });

  it("first week of March → weekOfMonth=1", () => {
    const r = runRules("first week of March", "en");
    expect(r.expressions[0].expression).toEqual({
      kind: "absolute",
      month: 3,
      weekOfMonth: 1,
    });
  });

  it("end of 2025 → yearPart=late", () => {
    const r = runRules("end of 2025", "en");
    expect(r.expressions[0].expression).toEqual({
      kind: "absolute",
      year: 2025,
      yearPart: "late",
    });
  });

  it("the 15th → absolute day", () => {
    const r = runRules("the 15th", "en");
    expect(r.expressions[0].expression).toEqual({
      kind: "absolute",
      day: 15,
    });
  });
});

describe("English rules - relative", () => {
  it("last month → relative month=-1", () => {
    const r = runRules("last month sales", "en");
    expect(r.expressions[0].expression).toEqual({
      kind: "relative",
      unit: "month",
      offset: -1,
    });
  });

  it("next week → relative week=1", () => {
    const r = runRules("next week schedule", "en");
    expect(r.expressions[0].expression).toEqual({
      kind: "relative",
      unit: "week",
      offset: 1,
    });
  });

  it("this year → relative year=0", () => {
    const r = runRules("this year performance", "en");
    expect(r.expressions[0].expression).toEqual({
      kind: "relative",
      unit: "year",
      offset: 0,
    });
  });

  it("last March → absolute yearOffset=-1 month=3", () => {
    const r = runRules("last March", "en");
    expect(r.expressions[0].expression).toEqual({
      kind: "absolute",
      yearOffset: -1,
      month: 3,
    });
  });

  it("3 days ago → relative day=-3", () => {
    const r = runRules("3 days ago", "en");
    expect(r.expressions[0].expression).toEqual({
      kind: "relative",
      unit: "day",
      offset: -3,
    });
  });

  it("in 5 days → relative day=5", () => {
    const r = runRules("in 5 days", "en");
    expect(r.expressions[0].expression).toEqual({
      kind: "relative",
      unit: "day",
      offset: 5,
    });
  });

  it("2 weeks from now → relative week=2", () => {
    const r = runRules("2 weeks from now", "en");
    expect(r.expressions[0].expression).toEqual({
      kind: "relative",
      unit: "week",
      offset: 2,
    });
  });
});

describe("English rules - named", () => {
  it("yesterday → named yesterday", () => {
    const r = runRules("yesterday sales", "en");
    expect(r.expressions[0].expression).toEqual({
      kind: "named",
      name: "yesterday",
    });
  });

  it("day after tomorrow → named 모레", () => {
    const r = runRules("day after tomorrow", "en");
    expect(r.expressions[0].expression).toEqual({
      kind: "named",
      name: "모레",
    });
  });

  it("day before yesterday → named 그저께", () => {
    const r = runRules("day before yesterday", "en");
    expect(r.expressions[0].expression).toEqual({
      kind: "named",
      name: "그저께",
    });
  });

  it("fortnight ago → named 보름 past", () => {
    const r = runRules("fortnight ago", "en");
    expect(r.expressions[0].expression).toEqual({
      kind: "named",
      name: "보름",
      direction: "past",
    });
  });
});

describe("English rules - quarter / half / duration", () => {
  it("Q1 → quarter with yearOffset=0", () => {
    const r = runRules("Q1 revenue", "en");
    expect(r.expressions[0].expression).toEqual({
      kind: "quarter",
      quarter: 1,
      yearOffset: 0,
    });
  });

  it("Q2 2025 → quarter year=2025", () => {
    const r = runRules("Q2 2025 revenue", "en");
    expect(r.expressions[0].expression).toEqual({
      kind: "quarter",
      quarter: 2,
      year: 2025,
    });
  });

  it("first quarter of 2024 → quarter year=2024", () => {
    const r = runRules("first quarter of 2024", "en");
    expect(r.expressions[0].expression).toEqual({
      kind: "quarter",
      quarter: 1,
      year: 2024,
    });
  });

  it("H1 2025 → half 1 year=2025", () => {
    const r = runRules("H1 2025 budget", "en");
    expect(r.expressions[0].expression).toEqual({
      kind: "half",
      half: 1,
      year: 2025,
    });
  });

  it("first half of 2024 → half 1 year=2024", () => {
    const r = runRules("first half of 2024", "en");
    expect(r.expressions[0].expression).toEqual({
      kind: "half",
      half: 1,
      year: 2024,
    });
  });

  it("past 30 days → duration day 30 past", () => {
    const r = runRules("past 30 days", "en");
    expect(r.expressions[0].expression).toEqual({
      kind: "duration",
      unit: "day",
      amount: 30,
      direction: "past",
    });
  });

  it("since March 2025 → range(absolute 2025-3, today)", () => {
    const r = runRules("since March 2025", "en");
    expect(r.expressions[0].expression).toEqual({
      kind: "range",
      start: { kind: "absolute", year: 2025, month: 3 },
      end: { kind: "named", name: "today" },
    });
  });
});

describe("English rules - filter suffix", () => {
  it("next month business days → filter business_days", () => {
    const r = runRules("next month business days", "en");
    expect(r.expressions[0].expression).toEqual({
      kind: "filter",
      base: { kind: "relative", unit: "month", offset: 1 },
      filter: "business_days",
    });
  });

  it("last week weekdays → filter weekdays", () => {
    const r = runRules("last week weekdays", "en");
    expect(r.expressions[0].expression).toEqual({
      kind: "filter",
      base: { kind: "relative", unit: "week", offset: -1 },
      filter: "weekdays",
    });
  });

  it("this month holidays → filter holidays", () => {
    const r = runRules("this month holidays", "en");
    expect(r.expressions[0].expression).toEqual({
      kind: "filter",
      base: { kind: "relative", unit: "month", offset: 0 },
      filter: "holidays",
    });
  });
});

describe("English rules - weekday", () => {
  it("next Monday → weekday_in_week 1/1", () => {
    const r = runRules("next Monday meeting", "en");
    expect(r.expressions[0].expression).toEqual({
      kind: "weekday_in_week",
      weekOffset: 1,
      weekday: 1,
    });
  });

  it("last Friday → weekday_in_week -1/5", () => {
    const r = runRules("last Friday report", "en");
    expect(r.expressions[0].expression).toEqual({
      kind: "weekday_in_week",
      weekOffset: -1,
      weekday: 5,
    });
  });
});

describe("English rules - edge cases", () => {
  it("plain greeting → no match", () => {
    const r = runRules("hello there", "en");
    expect(r.expressions).toHaveLength(0);
    expect(r.confidence).toBe(0);
  });
});
