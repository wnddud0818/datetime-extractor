import { describe, it, expect } from "vitest";
import { runRules } from "../src/rules/engine.js";

describe("rules engine", () => {
  it("저번 달 잔액 알려줘 → 1.0 confidence, relative month=-1", () => {
    const r = runRules("저번 달 잔액 알려줘");
    expect(r.confidence).toBe(1.0);
    expect(r.expressions).toHaveLength(1);
    expect(r.expressions[0].expression).toEqual({
      kind: "relative",
      unit: "month",
      offset: -1,
    });
  });

  it("3월 4월 잔액 알려줘 → 1.0, 두 개의 absolute month", () => {
    const r = runRules("3월 4월 잔액 알려줘");
    expect(r.confidence).toBe(1.0);
    expect(r.expressions).toHaveLength(2);
    expect(r.expressions[0].expression).toEqual({ kind: "absolute", month: 3 });
    expect(r.expressions[1].expression).toEqual({ kind: "absolute", month: 4 });
  });

  it("사흘 전 날씨 → 1.0, named 사흘 past", () => {
    const r = runRules("사흘 전 날씨");
    expect(r.confidence).toBe(1.0);
    expect(r.expressions[0].expression).toEqual({
      kind: "named",
      name: "사흘",
      direction: "past",
    });
  });

  it("저번달 영업일 → filter(business_days) 단일 매치", () => {
    const r = runRules("저번달 영업일");
    expect(r.confidence).toBe(1.0);
    expect(r.expressions).toHaveLength(1);
    expect(r.expressions[0].expression).toEqual({
      kind: "filter",
      base: { kind: "relative", unit: "month", offset: -1 },
      filter: "business_days",
    });
  });

  it("이번 달 평일 → filter(weekdays)", () => {
    const r = runRules("이번 달 평일");
    expect(r.confidence).toBe(1.0);
    expect(r.expressions[0].expression).toEqual({
      kind: "filter",
      base: { kind: "relative", unit: "month", offset: 0 },
      filter: "weekdays",
    });
  });

  it("작년 공휴일 → filter(holidays) over relative year=-1", () => {
    const r = runRules("작년 공휴일");
    expect(r.confidence).toBe(1.0);
    expect(r.expressions[0].expression).toEqual({
      kind: "filter",
      base: { kind: "relative", unit: "year", offset: -1 },
      filter: "holidays",
    });
  });

  it("2025-12-25 잔액 → ISO 절대 매치", () => {
    const r = runRules("2025-12-25 잔액");
    expect(r.confidence).toBe(1.0);
    expect(r.expressions[0].expression).toEqual({
      kind: "absolute",
      year: 2025,
      month: 12,
      day: 25,
    });
  });

  it("20250412 잔액 → 구분자 없는 YYYYMMDD", () => {
    const r = runRules("20250412 잔액");
    expect(r.confidence).toBe(1.0);
    expect(r.expressions).toHaveLength(1);
    expect(r.expressions[0].expression).toEqual({
      kind: "absolute",
      year: 2025,
      month: 4,
      day: 12,
    });
  });

  it("0412 잔액 → 구분자 없는 MMDD (연도 미상)", () => {
    const r = runRules("0412 잔액");
    expect(r.confidence).toBe(1.0);
    expect(r.expressions).toHaveLength(1);
    expect(r.expressions[0].expression).toEqual({
      kind: "absolute",
      month: 4,
      day: 12,
    });
  });

  it("19991231 → 과거 연도 YYYYMMDD", () => {
    const r = runRules("19991231");
    expect(r.expressions).toHaveLength(1);
    expect(r.expressions[0].expression).toEqual({
      kind: "absolute",
      year: 1999,
      month: 12,
      day: 31,
    });
  });

  it("99999999 → 유효하지 않은 월/일은 매치 안 됨", () => {
    const r = runRules("99999999");
    expect(r.expressions).toHaveLength(0);
  });

  it("2025년 → 연도 단독 (YYYYMMDD/MMDD와 겹치지 않음)", () => {
    const r = runRules("2025년");
    expect(r.expressions).toHaveLength(1);
    expect(r.expressions[0].expression).toEqual({
      kind: "absolute",
      year: 2025,
    });
  });

  it("2025년 3월 1일 → 한국 연월일", () => {
    const r = runRules("2025년 3월 1일");
    expect(r.confidence).toBe(1.0);
    expect(r.expressions[0].expression).toEqual({
      kind: "absolute",
      year: 2025,
      month: 3,
      day: 1,
    });
  });

  it("7일 전 → relative day offset=-7", () => {
    const r = runRules("7일 전");
    expect(r.confidence).toBe(1.0);
    expect(r.expressions[0].expression).toEqual({
      kind: "relative",
      unit: "day",
      offset: -7,
    });
  });

  it("어제 매출 → named yesterday", () => {
    const r = runRules("어제 매출");
    expect(r.confidence).toBe(1.0);
    expect(r.expressions[0].expression).toEqual({
      kind: "named",
      name: "yesterday",
    });
  });

  it("안녕하세요 → 매치 없음", () => {
    const r = runRules("안녕하세요");
    expect(r.confidence).toBe(0);
    expect(r.expressions).toHaveLength(0);
  });

  it("last month sales → 영어 상대", () => {
    const r = runRules("last month sales");
    expect(r.confidence).toBe(1.0);
    expect(r.expressions[0].expression).toEqual({
      kind: "relative",
      unit: "month",
      offset: -1,
    });
  });

  it("what was the balance yesterday → named yesterday", () => {
    const r = runRules("what was the balance yesterday");
    expect(r.confidence).toBe(1.0);
    expect(r.expressions[0].expression).toEqual({
      kind: "named",
      name: "yesterday",
    });
  });

  it("보름 전 → named 보름 past", () => {
    const r = runRules("보름 전");
    expect(r.confidence).toBe(1.0);
    expect(r.expressions[0].expression).toEqual({
      kind: "named",
      name: "보름",
      direction: "past",
    });
  });

  it("모호: '그리고 반기별로' → confidence 낮음 (반기 잔여)", () => {
    const r = runRules("매출 반기별로 보여줘");
    // 반기 키워드 있지만 매칭은 없음 → no_match이지만 residual에 '반기'
    expect(r.expressions).toHaveLength(0);
  });
});
