import { describe, it, expect } from "vitest";
import { format } from "date-fns";
import { resolveExpression, formatRange, parseReferenceDate, getFilterKind } from "../src/resolver/resolve.js";
import type { DateExpression } from "../src/types.js";

const ymd = (d: Date) => format(d, "yyyy-MM-dd");

const ctx = (iso: string) => ({
  referenceDate: parseReferenceDate(iso),
  timezone: "Asia/Seoul",
});

describe("resolver: absolute", () => {
  it("YYYY-MM-DD → single day range", () => {
    const expr: DateExpression = { kind: "absolute", year: 2025, month: 3, day: 1 };
    const r = resolveExpression(expr, ctx("2026-04-17"));
    expect(r.granularity).toBe("day");
    expect(ymd(r.start)).toBe("2025-03-01");
  });

  it("month only → month range of refDate year", () => {
    const expr: DateExpression = { kind: "absolute", month: 3 };
    const r = resolveExpression(expr, ctx("2026-04-17"));
    expect(r.granularity).toBe("month");
    expect(ymd(r.start)).toBe("2026-03-01");
    expect(ymd(r.end)).toBe("2026-03-31");
  });

  it("lunar 1/1 2026 → solar 2026-02-17", () => {
    const expr: DateExpression = { kind: "absolute", year: 2026, month: 1, day: 1, lunar: true };
    const r = resolveExpression(expr, ctx("2026-04-17"));
    expect(ymd(r.start)).toBe("2026-02-17");
  });
});

describe("resolver: ambiguityStrategy (day-only)", () => {
  const ctxWith = (iso: string, strategy: "past" | "future" | "both") => ({
    referenceDate: parseReferenceDate(iso),
    timezone: "Asia/Seoul",
    ambiguityStrategy: strategy,
  });

  it("past / day < refDay → same month", () => {
    const expr: DateExpression = { kind: "absolute", day: 15 };
    const r = resolveExpression(expr, ctxWith("2026-04-18", "past"));
    expect(ymd(r.start)).toBe("2026-04-15");
  });

  it("past / day > refDay → previous month", () => {
    const expr: DateExpression = { kind: "absolute", day: 25 };
    const r = resolveExpression(expr, ctxWith("2026-04-18", "past"));
    expect(ymd(r.start)).toBe("2026-03-25");
  });

  it("past / day > refDay in January → previous year December", () => {
    const expr: DateExpression = { kind: "absolute", day: 25 };
    const r = resolveExpression(expr, ctxWith("2026-01-10", "past"));
    expect(ymd(r.start)).toBe("2025-12-25");
  });

  it("past / day == refDay → same day (today included)", () => {
    const expr: DateExpression = { kind: "absolute", day: 18 };
    const r = resolveExpression(expr, ctxWith("2026-04-18", "past"));
    expect(ymd(r.start)).toBe("2026-04-18");
  });

  it("future / day > refDay → same month", () => {
    const expr: DateExpression = { kind: "absolute", day: 25 };
    const r = resolveExpression(expr, ctxWith("2026-04-18", "future"));
    expect(ymd(r.start)).toBe("2026-04-25");
  });

  it("future / day < refDay → next month", () => {
    const expr: DateExpression = { kind: "absolute", day: 15 };
    const r = resolveExpression(expr, ctxWith("2026-04-18", "future"));
    expect(ymd(r.start)).toBe("2026-05-15");
  });

  it("future / day < refDay in December → next year January", () => {
    const expr: DateExpression = { kind: "absolute", day: 5 };
    const r = resolveExpression(expr, ctxWith("2026-12-20", "future"));
    expect(ymd(r.start)).toBe("2027-01-05");
  });

  it("contextDate overrides strategy (uses contextDate month/year)", () => {
    const expr: DateExpression = { kind: "absolute", day: 25 };
    const r = resolveExpression(expr, {
      referenceDate: parseReferenceDate("2026-04-18"),
      timezone: "Asia/Seoul",
      ambiguityStrategy: "past",
      contextDate: parseReferenceDate("2025-06-01"),
    });
    expect(ymd(r.start)).toBe("2025-06-25");
  });
});

describe("resolver: relative", () => {
  it("relative month offset=-1 → 전월 range", async () => {
    const expr: DateExpression = { kind: "relative", unit: "month", offset: -1 };
    const r = resolveExpression(expr, ctx("2026-04-17"));
    const out = await formatRange(r, "range", null);
    expect(out).toEqual({
      mode: "range",
      value: { start: "2026-03-01", end: "2026-03-31" },
    });
  });

  it("relative year offset=-1 → 작년 range", async () => {
    const expr: DateExpression = { kind: "relative", unit: "year", offset: -1 };
    const r = resolveExpression(expr, ctx("2026-04-17"));
    const out = await formatRange(r, "range", null);
    expect(out).toEqual({
      mode: "range",
      value: { start: "2025-01-01", end: "2025-12-31" },
    });
  });

  it("relative week offset=-1 (ISO Mon-Sun) → 지난주", async () => {
    // 2026-04-17 is Fri. Last week = Mon 2026-04-06 ~ Sun 2026-04-12
    const expr: DateExpression = { kind: "relative", unit: "week", offset: -1 };
    const r = resolveExpression(expr, ctx("2026-04-17"));
    const out = await formatRange(r, "range", null);
    expect(out).toEqual({
      mode: "range",
      value: { start: "2026-04-06", end: "2026-04-12" },
    });
  });

  it("relative day offset=-7", async () => {
    const expr: DateExpression = { kind: "relative", unit: "day", offset: -7 };
    const r = resolveExpression(expr, ctx("2026-04-17"));
    const out = await formatRange(r, "single", null);
    expect(out).toEqual({ mode: "single", value: "2026-04-10" });
  });
});

describe("resolver: named (Korean numerals)", () => {
  it("사흘 (directional) + past → -3 days", async () => {
    const expr: DateExpression = { kind: "named", name: "사흘", direction: "past" };
    const r = resolveExpression(expr, ctx("2026-04-17"));
    const out = await formatRange(r, "single", null);
    expect(out).toEqual({ mode: "single", value: "2026-04-14" });
  });

  it("보름 + past → -15 days", async () => {
    const expr: DateExpression = { kind: "named", name: "보름", direction: "past" };
    const r = resolveExpression(expr, ctx("2026-04-17"));
    const out = await formatRange(r, "single", null);
    expect(out).toEqual({ mode: "single", value: "2026-04-02" });
  });

  it("그저께 → -2 days (non-directional)", async () => {
    const expr: DateExpression = { kind: "named", name: "그저께" };
    const r = resolveExpression(expr, ctx("2026-04-17"));
    const out = await formatRange(r, "single", null);
    expect(out).toEqual({ mode: "single", value: "2026-04-15" });
  });

  it("today/yesterday/tomorrow/모레/글피", async () => {
    const cases: Array<[string, string]> = [
      ["today", "2026-04-17"],
      ["yesterday", "2026-04-16"],
      ["tomorrow", "2026-04-18"],
      ["모레", "2026-04-19"],
      ["글피", "2026-04-20"],
    ];
    for (const [name, expected] of cases) {
      const r = resolveExpression(
        { kind: "named", name: name as any },
        ctx("2026-04-17"),
      );
      const out = await formatRange(r, "single", null);
      expect(out).toEqual({ mode: "single", value: expected });
    }
  });

  it("next/prev/current holiday tokens resolve against holiday calendar", async () => {
    const cases: Array<[DateExpression, string]> = [
      [{ kind: "named", name: "next_holiday" }, "2026-05-05"],
      [{ kind: "named", name: "prev_holiday" }, "2026-03-02"],
      [{ kind: "named", name: "today_or_next_holiday" }, "2026-05-05"],
    ];
    for (const [expr, expected] of cases) {
      const r = resolveExpression(expr, {
        ...ctx("2026-04-17"),
        holidaysByYear: {
          2025: {
            "2025-12-25": "성탄절",
          },
          2026: {
            "2026-03-02": "대체공휴일",
            "2026-05-05": "어린이날",
          },
        },
      });
      const out = await formatRange(r, "single", null);
      expect(out).toEqual({ mode: "single", value: expected });
    }
  });

  it("today_or_next_holiday includes today when reference date is a holiday", async () => {
    const r = resolveExpression(
      { kind: "named", name: "today_or_next_holiday" },
      {
        ...ctx("2026-05-05"),
        holidaysByYear: {
          2026: {
            "2026-05-05": "어린이날",
            "2026-05-25": "대체공휴일",
          },
        },
      },
    );
    const out = await formatRange(r, "single", null);
    expect(out).toEqual({ mode: "single", value: "2026-05-05" });
  });
});

describe("resolver: filter", () => {
  it("business_days on 저번달 → 주말+공휴일 제외", async () => {
    const expr: DateExpression = {
      kind: "filter",
      base: { kind: "relative", unit: "month", offset: -1 },
      filter: "business_days",
    };
    const r = resolveExpression(expr, ctx("2026-04-17"));
    const filter = getFilterKind(expr);
    const out = await formatRange(r, "business_days", filter);
    expect(out?.mode).toBe("business_days");
    if (out?.mode === "business_days") {
      // 2026-03-01 is 삼일절(일)/3-02 대체공휴일. 포함되면 안 됨.
      expect(out.value).not.toContain("2026-03-01");
      expect(out.value).not.toContain("2026-03-02");
      // 토/일 제외
      expect(out.value).not.toContain("2026-03-07");
      expect(out.value).not.toContain("2026-03-08");
      // 평일이자 공휴일 아닌 날 포함
      expect(out.value).toContain("2026-03-03");
      expect(out.value).toContain("2026-03-31");
      // 영업일 수는 20일 이상
      expect(out.value.length).toBeGreaterThanOrEqual(20);
    }
  });

  it("holidays filter on 작년 → 2025 공휴일 목록", async () => {
    const expr: DateExpression = {
      kind: "filter",
      base: { kind: "relative", unit: "year", offset: -1 },
      filter: "holidays",
    };
    const r = resolveExpression(expr, ctx("2026-04-17"));
    const filter = getFilterKind(expr);
    const out = await formatRange(r, "holidays", filter);
    if (out?.mode === "holidays") {
      expect(out.value).toContain("2025-01-01");
      expect(out.value).toContain("2025-03-01");
      expect(out.value).toContain("2025-05-05");
      expect(out.value).toContain("2025-12-25");
    }
  });

  it("weekdays filter on 이번 달", async () => {
    const expr: DateExpression = {
      kind: "filter",
      base: { kind: "relative", unit: "month", offset: 0 },
      filter: "weekdays",
    };
    const r = resolveExpression(expr, ctx("2026-04-17"));
    const filter = getFilterKind(expr);
    const out = await formatRange(r, "weekdays", filter);
    if (out?.mode === "weekdays") {
      expect(out.value.length).toBeGreaterThanOrEqual(20);
      expect(out.value).not.toContain("2026-04-18"); // 토
      expect(out.value).not.toContain("2026-04-19"); // 일
    }
  });
});

describe("resolver: range", () => {
  it("3월 ~ 4월 range → 두 기간 병합", async () => {
    const expr: DateExpression = {
      kind: "range",
      start: { kind: "absolute", month: 3 },
      end: { kind: "absolute", month: 4 },
    };
    const r = resolveExpression(expr, ctx("2026-04-17"));
    const out = await formatRange(r, "range", null);
    expect(out).toEqual({
      mode: "range",
      value: { start: "2026-03-01", end: "2026-04-30" },
    });
  });
});
