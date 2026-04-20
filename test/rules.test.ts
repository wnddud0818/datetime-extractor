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

  it("2,3,4월 실적 → 세 개의 absolute month", () => {
    const r = runRules("2,3,4월 실적");
    expect(r.confidence).toBe(1.0);
    expect(r.expressions).toHaveLength(3);
    expect(r.expressions[0].expression).toEqual({ kind: "absolute", month: 2 });
    expect(r.expressions[1].expression).toEqual({ kind: "absolute", month: 3 });
    expect(r.expressions[2].expression).toEqual({ kind: "absolute", month: 4 });
  });

  it("2, 3월 실적 → 공백 포함 콤마도 처리", () => {
    const r = runRules("2, 3월 실적");
    expect(r.confidence).toBe(1.0);
    expect(r.expressions).toHaveLength(2);
    expect(r.expressions[0].expression).toEqual({ kind: "absolute", month: 2 });
    expect(r.expressions[1].expression).toEqual({ kind: "absolute", month: 3 });
  });

  it("2,3분기 실적 → 두 개의 quarter", () => {
    const r = runRules("2,3분기 실적");
    expect(r.confidence).toBe(1.0);
    expect(r.expressions).toHaveLength(2);
    expect(r.expressions[0].expression).toEqual({ kind: "quarter", quarter: 2, yearOffset: 0 });
    expect(r.expressions[1].expression).toEqual({ kind: "quarter", quarter: 3, yearOffset: 0 });
  });

  it("작년 2,3,4월 → yearOffset=-1인 세 개의 absolute month", () => {
    const r = runRules("작년 2,3,4월 실적");
    expect(r.confidence).toBe(1.0);
    expect(r.expressions).toHaveLength(3);
    expect(r.expressions[0].expression).toEqual({ kind: "absolute", yearOffset: -1, month: 2 });
    expect(r.expressions[1].expression).toEqual({ kind: "absolute", yearOffset: -1, month: 3 });
    expect(r.expressions[2].expression).toEqual({ kind: "absolute", yearOffset: -1, month: 4 });
  });

  it("2025년 2,3월 → year=2025인 두 개의 absolute month", () => {
    const r = runRules("2025년 2,3월 실적");
    expect(r.confidence).toBe(1.0);
    expect(r.expressions).toHaveLength(2);
    expect(r.expressions[0].expression).toEqual({ kind: "absolute", year: 2025, month: 2 });
    expect(r.expressions[1].expression).toEqual({ kind: "absolute", year: 2025, month: 3 });
  });

  it("작년 월별 → yearOffset=-1인 12개의 absolute month", () => {
    const r = runRules("작년 월별 매출");
    expect(r.confidence).toBe(1.0);
    expect(r.expressions).toHaveLength(12);
    expect(r.expressions.map((expr) => expr.expression)).toEqual(
      Array.from({ length: 12 }, (_, i) => ({
        kind: "absolute",
        yearOffset: -1,
        month: i + 1,
      })),
    );
  });

  it("2025년 월별로 → year=2025인 12개의 absolute month", () => {
    const r = runRules("2025년 월별로 매출");
    expect(r.confidence).toBe(1.0);
    expect(r.expressions).toHaveLength(12);
    expect(r.expressions.map((expr) => expr.expression)).toEqual(
      Array.from({ length: 12 }, (_, i) => ({
        kind: "absolute",
        year: 2025,
        month: i + 1,
      })),
    );
  });

  it("올해 1,2분기 → yearOffset=0인 두 개의 quarter", () => {
    const r = runRules("올해 1,2분기 실적");
    expect(r.confidence).toBe(1.0);
    expect(r.expressions).toHaveLength(2);
    expect(r.expressions[0].expression).toEqual({ kind: "quarter", quarter: 1, yearOffset: 0 });
    expect(r.expressions[1].expression).toEqual({ kind: "quarter", quarter: 2, yearOffset: 0 });
  });

  it("2025년 3,4분기 → year=2025인 두 개의 quarter", () => {
    const r = runRules("2025년 3,4분기 실적");
    expect(r.confidence).toBe(1.0);
    expect(r.expressions).toHaveLength(2);
    expect(r.expressions[0].expression).toEqual({ kind: "quarter", quarter: 3, year: 2025 });
    expect(r.expressions[1].expression).toEqual({ kind: "quarter", quarter: 4, year: 2025 });
  });

  it("2024년 상반기와 하반기 → 두 반기 모두 2024년으로 해석", () => {
    const r = runRules("2024년 상반기와 하반기 자금 상황을 비교해줘");
    expect(r.confidence).toBe(1.0);
    expect(r.expressions).toHaveLength(2);
    expect(r.expressions[0].expression).toEqual({ kind: "half", half: 1, year: 2024 });
    expect(r.expressions[1].expression).toEqual({ kind: "half", half: 2, year: 2024 });
  });

  it("혼합 언어: tomorrow morning ... 좀 자세히 → 영어 datetime 유지", () => {
    const r = runRules("tomorrow morning cash movement 좀 자세히");
    expect(r.confidence).toBe(1.0);
    expect(r.expressions).toHaveLength(1);
    expect(r.expressions[0].expression).toEqual({
      kind: "datetime",
      base: { kind: "named", name: "tomorrow" },
      time: { type: "period", period: "morning" },
    });
  });

  it("혼합 언어: from 9am to 5pm ... 바로 → 영어 시간 범위 유지", () => {
    const r = runRules("from 9am to 5pm cash activity 바로");
    expect(r.confidence).toBe(1.0);
    expect(r.expressions).toHaveLength(1);
    expect(r.expressions[0].expression).toEqual({
      kind: "datetime",
      base: { kind: "named", name: "today" },
      time: {
        type: "range",
        start: { hour: 9, meridiem: "am" },
        end: { hour: 5, meridiem: "pm" },
      },
    });
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

  it("다음 공휴일 → named next_holiday", () => {
    const r = runRules("다음 공휴일");
    expect(r.confidence).toBe(1.0);
    expect(r.expressions).toHaveLength(1);
    expect(r.expressions[0].expression).toEqual({
      kind: "named",
      name: "next_holiday",
    });
  });

  it("이번 휴일 → named today_or_next_holiday", () => {
    const r = runRules("이번 휴일");
    expect(r.confidence).toBe(1.0);
    expect(r.expressions).toHaveLength(1);
    expect(r.expressions[0].expression).toEqual({
      kind: "named",
      name: "today_or_next_holiday",
    });
  });

  it("작년 대비 지출 증가율 → 암묵적 올해를 보강", () => {
    const r = runRules("작년 대비 지출 증가율");
    expect(r.confidence).toBe(1.0);
    expect(r.expressions).toHaveLength(2);
    expect(r.expressions[0].text).toBe("작년");
    expect(r.expressions[0].expression).toEqual({
      kind: "relative",
      unit: "year",
      offset: -1,
    });
    expect(r.expressions[1].text).toBe("대비");
    expect(r.expressions[1].expression).toEqual({
      kind: "relative",
      unit: "year",
      offset: 0,
    });
  });

  it("작년 대비 올해 지출 증가율 → 명시적 올해가 있으면 중복 보강 안 함", () => {
    const r = runRules("작년 대비 올해 지출 증가율");
    expect(r.confidence).toBe(1.0);
    expect(r.expressions).toHaveLength(2);
    expect(r.expressions.map((expr) => expr.text)).toEqual(["작년", "올해"]);
    expect(r.expressions.map((expr) => expr.expression)).toEqual([
      { kind: "relative", unit: "year", offset: -1 },
      { kind: "relative", unit: "year", offset: 0 },
    ]);
  });

  it("재작년 대비 작년 지출 증가율 → 명시적 비교 대상만 유지", () => {
    const r = runRules("재작년 대비 작년 지출 증가율");
    expect(r.confidence).toBe(1.0);
    expect(r.expressions).toHaveLength(2);
    expect(r.expressions.map((expr) => expr.text)).toEqual(["재작년", "작년"]);
    expect(r.expressions.map((expr) => expr.expression)).toEqual([
      { kind: "relative", unit: "year", offset: -2 },
      { kind: "relative", unit: "year", offset: -1 },
    ]);
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

  it("네달전 → relative month offset=-4 singleDay", () => {
    const r = runRules("네달전");
    expect(r.confidence).toBe(1.0);
    expect(r.expressions[0].expression).toEqual({
      kind: "relative",
      unit: "month",
      offset: -4,
      singleDay: true,
    });
  });

  it("삼개월 전 → relative month offset=-3 singleDay", () => {
    const r = runRules("삼개월 전");
    expect(r.confidence).toBe(1.0);
    expect(r.expressions[0].expression).toEqual({
      kind: "relative",
      unit: "month",
      offset: -3,
      singleDay: true,
    });
  });

  it("최근 삼개월 → duration month amount=3", () => {
    const r = runRules("최근 삼개월 매출");
    expect(r.confidence).toBe(1.0);
    expect(r.expressions[0].expression).toEqual({
      kind: "duration",
      unit: "month",
      amount: 3,
      direction: "past",
    });
  });

  it("1년 반동안 → duration year amount=1.5", () => {
    const r = runRules("1년 반동안");
    expect(r.confidence).toBe(1.0);
    expect(r.expressions[0].expression).toEqual({
      kind: "duration",
      unit: "year",
      amount: 1.5,
      direction: "past",
    });
  });

  it("두달 반동안 → duration month amount=2.5", () => {
    const r = runRules("두달 반동안");
    expect(r.confidence).toBe(1.0);
    expect(r.expressions[0].expression).toEqual({
      kind: "duration",
      unit: "month",
      amount: 2.5,
      direction: "past",
    });
  });

  it("작년 한해동안 → absolute yearOffset=-1", () => {
    const r = runRules("작년 한해동안");
    expect(r.confidence).toBe(1.0);
    expect(r.expressions).toHaveLength(1);
    expect(r.expressions[0].expression).toEqual({
      kind: "absolute",
      yearOffset: -1,
    });
  });

  it("저번 한달동안 / 직전한달 → duration month amount=1", () => {
    for (const text of ["저번 한달동안", "직전한달"]) {
      const r = runRules(text);
      expect(r.confidence).toBe(1.0);
      expect(r.expressions).toHaveLength(1);
      expect(r.expressions[0].expression).toEqual({
        kind: "duration",
        unit: "month",
        amount: 1,
        direction: "past",
      });
    }
  });

  it("사개월/오개월/육개월/칠개월/팔개월/구개월 전 → month relative를 모두 지원", () => {
    const cases: Array<[string, number]> = [
      ["사개월전", -4],
      ["오개월전", -5],
      ["육개월전", -6],
      ["칠개월전", -7],
      ["팔개월전", -8],
      ["구개월전", -9],
    ];
    for (const [text, offset] of cases) {
      const r = runRules(text);
      expect(r.confidence).toBe(1.0);
      expect(r.expressions[0].expression).toEqual({
        kind: "relative",
        unit: "month",
        offset,
        singleDay: true,
      });
    }
  });

  it("삼일전/사일전 → day relative를 지원", () => {
    const cases: Array<[string, number]> = [
      ["삼일전", -3],
      ["사일전", -4],
    ];
    for (const [text, offset] of cases) {
      const r = runRules(text);
      expect(r.confidence).toBe(1.0);
      expect(r.expressions[0].expression).toEqual({
        kind: "relative",
        unit: "day",
        offset,
      });
    }
  });

  it("삼년전/사년전 → year relative를 지원", () => {
    const cases: Array<[string, number]> = [
      ["삼년전", -3],
      ["사년전", -4],
    ];
    for (const [text, offset] of cases) {
      const r = runRules(text);
      expect(r.confidence).toBe(1.0);
      expect(r.expressions[0].expression).toEqual({
        kind: "relative",
        unit: "year",
        offset,
        singleDay: true,
      });
    }
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

  // --- (prefix) 공백 구분 월 목록 ---
  it("작년 1월 2월 → yearOffset=-1 공백 구분 월 목록", () => {
    const r = runRules("작년 1월 2월 실적");
    expect(r.confidence).toBe(1.0);
    expect(r.expressions).toHaveLength(2);
    expect(r.expressions[0].expression).toEqual({ kind: "absolute", yearOffset: -1, month: 1 });
    expect(r.expressions[1].expression).toEqual({ kind: "absolute", yearOffset: -1, month: 2 });
  });

  it("내년 1월 2월 3월 → yearOffset=1 세 개 월", () => {
    const r = runRules("내년 1월 2월 3월 자금 계획");
    expect(r.confidence).toBe(1.0);
    expect(r.expressions).toHaveLength(3);
    expect(r.expressions[0].expression).toEqual({ kind: "absolute", yearOffset: 1, month: 1 });
    expect(r.expressions[1].expression).toEqual({ kind: "absolute", yearOffset: 1, month: 2 });
    expect(r.expressions[2].expression).toEqual({ kind: "absolute", yearOffset: 1, month: 3 });
  });

  it("2025년 1월 2월 → year=2025 공백 구분 월 목록", () => {
    const r = runRules("2025년 1월 2월 실적");
    expect(r.confidence).toBe(1.0);
    expect(r.expressions).toHaveLength(2);
    expect(r.expressions[0].expression).toEqual({ kind: "absolute", year: 2025, month: 1 });
    expect(r.expressions[1].expression).toEqual({ kind: "absolute", year: 2025, month: 2 });
  });

  // --- (month-prefix) + week-of-month (단일) ---
  it("지난달 첫째주 → monthOffset=-1, weekOfMonth=1", () => {
    const r = runRules("지난달 첫째주 실적");
    expect(r.confidence).toBe(1.0);
    expect(r.expressions).toHaveLength(1);
    expect(r.expressions[0].expression).toEqual({
      kind: "absolute",
      monthOffset: -1,
      weekOfMonth: 1,
    });
  });

  it("이번달 1주차 → monthOffset=0, weekOfMonth=1", () => {
    const r = runRules("이번달 1주차 잔액");
    expect(r.confidence).toBe(1.0);
    expect(r.expressions).toHaveLength(1);
    expect(r.expressions[0].expression).toEqual({
      kind: "absolute",
      monthOffset: 0,
      weekOfMonth: 1,
    });
  });

  it("다음달 둘째주 → monthOffset=1, weekOfMonth=2", () => {
    const r = runRules("다음달 둘째주 보고");
    expect(r.confidence).toBe(1.0);
    expect(r.expressions).toHaveLength(1);
    expect(r.expressions[0].expression).toEqual({
      kind: "absolute",
      monthOffset: 1,
      weekOfMonth: 2,
    });
  });

  it("이번달 둘째 화요일 → monthOffset=0, weekOfMonth=2, weekday=2", () => {
    const r = runRules("이번달 둘째 화요일 회의");
    expect(r.confidence).toBe(1.0);
    expect(r.expressions).toHaveLength(1);
    expect(r.expressions[0].expression).toEqual({
      kind: "absolute",
      monthOffset: 0,
      weekOfMonth: 2,
      weekday: 2,
    });
  });

  it("3월 둘째 화요일 → absolute month + weekOfMonth + weekday", () => {
    const r = runRules("3월 둘째 화요일");
    expect(r.expressions).toHaveLength(1);
    expect(r.expressions[0].expression).toEqual({
      kind: "absolute",
      month: 3,
      weekOfMonth: 2,
      weekday: 2,
    });
  });

  // --- (month-prefix) + week list ---
  it("지난달 1,2주 → monthOffset=-1 두 개 주차", () => {
    const r = runRules("지난달 1,2주 실적");
    expect(r.confidence).toBe(1.0);
    expect(r.expressions).toHaveLength(2);
    expect(r.expressions[0].expression).toEqual({
      kind: "absolute",
      monthOffset: -1,
      weekOfMonth: 1,
    });
    expect(r.expressions[1].expression).toEqual({
      kind: "absolute",
      monthOffset: -1,
      weekOfMonth: 2,
    });
  });

  it("이번달 1,2,3주차 → monthOffset=0 세 개 주차", () => {
    const r = runRules("이번달 1,2,3주차 플랜");
    expect(r.confidence).toBe(1.0);
    expect(r.expressions).toHaveLength(3);
    expect(r.expressions[0].expression).toEqual({
      kind: "absolute",
      monthOffset: 0,
      weekOfMonth: 1,
    });
    expect(r.expressions[1].expression).toEqual({
      kind: "absolute",
      monthOffset: 0,
      weekOfMonth: 2,
    });
    expect(r.expressions[2].expression).toEqual({
      kind: "absolute",
      monthOffset: 0,
      weekOfMonth: 3,
    });
  });

  it("지난달 첫째주, 둘째주 → 서수 주차 목록", () => {
    const r = runRules("지난달 첫째주, 둘째주 실적");
    expect(r.confidence).toBe(1.0);
    expect(r.expressions).toHaveLength(2);
    expect(r.expressions[0].expression).toEqual({
      kind: "absolute",
      monthOffset: -1,
      weekOfMonth: 1,
    });
    expect(r.expressions[1].expression).toEqual({
      kind: "absolute",
      monthOffset: -1,
      weekOfMonth: 2,
    });
  });

  // --- (month-prefix) + 말일/초일 (단일 날짜) ---
  it("지난달 말일 → monthOffset=-1, monthPart=end", () => {
    const r = runRules("지난달 말일 잔액");
    expect(r.confidence).toBe(1.0);
    expect(r.expressions).toHaveLength(1);
    expect(r.expressions[0].expression).toEqual({
      kind: "absolute",
      monthOffset: -1,
      monthPart: "end",
    });
  });

  it("이번달 초일 → monthOffset=0, monthPart=start", () => {
    const r = runRules("이번달 초일 조회");
    expect(r.confidence).toBe(1.0);
    expect(r.expressions).toHaveLength(1);
    expect(r.expressions[0].expression).toEqual({
      kind: "absolute",
      monthOffset: 0,
      monthPart: "start",
    });
  });

  it("다음달 마지막 날 → monthOffset=1, monthPart=end", () => {
    const r = runRules("다음달 마지막 날 보고");
    expect(r.confidence).toBe(1.0);
    expect(r.expressions).toHaveLength(1);
    expect(r.expressions[0].expression).toEqual({
      kind: "absolute",
      monthOffset: 1,
      monthPart: "end",
    });
  });

  // --- (year-prefix|YYYY년) + N분기 + 초/말 ---
  it("작년 1분기 초 → yearOffset=-1, quarter=1, part=early", () => {
    const r = runRules("작년 1분기 초 매출");
    expect(r.confidence).toBe(1.0);
    expect(r.expressions).toHaveLength(1);
    expect(r.expressions[0].expression).toEqual({
      kind: "quarter",
      quarter: 1,
      yearOffset: -1,
      part: "early",
    });
  });

  it("내년 2분기 말 → yearOffset=1, quarter=2, part=late", () => {
    const r = runRules("내년 2분기 말 매출");
    expect(r.confidence).toBe(1.0);
    expect(r.expressions).toHaveLength(1);
    expect(r.expressions[0].expression).toEqual({
      kind: "quarter",
      quarter: 2,
      yearOffset: 1,
      part: "late",
    });
  });

  it("2025년 1분기 초 → year=2025, quarter=1, part=early", () => {
    const r = runRules("2025년 1분기 초 실적");
    expect(r.confidence).toBe(1.0);
    expect(r.expressions).toHaveLength(1);
    expect(r.expressions[0].expression).toEqual({
      kind: "quarter",
      quarter: 1,
      year: 2025,
      part: "early",
    });
  });

  // --- separator 변형: 무공백/쉼표 월 목록 ---
  it("작년 1월2월 (공백 없음) → yearOffset=-1 두 개 월", () => {
    const r = runRules("작년 1월2월 실적");
    expect(r.confidence).toBe(1.0);
    expect(r.expressions).toHaveLength(2);
    expect(r.expressions[0].expression).toEqual({ kind: "absolute", yearOffset: -1, month: 1 });
    expect(r.expressions[1].expression).toEqual({ kind: "absolute", yearOffset: -1, month: 2 });
  });

  it("내년 1월, 2월 (쉼표+공백) → yearOffset=1 두 개 월", () => {
    const r = runRules("내년 1월, 2월 매출");
    expect(r.confidence).toBe(1.0);
    expect(r.expressions).toHaveLength(2);
    expect(r.expressions[0].expression).toEqual({ kind: "absolute", yearOffset: 1, month: 1 });
    expect(r.expressions[1].expression).toEqual({ kind: "absolute", yearOffset: 1, month: 2 });
  });

  // --- separator 변형: 공백 구분 서수 주차 ---
  it("지난달 첫째주 둘째주 (공백 구분) → 두 개의 주차", () => {
    const r = runRules("지난달 첫째주 둘째주 보고");
    expect(r.confidence).toBe(1.0);
    expect(r.expressions).toHaveLength(2);
    expect(r.expressions[0].expression).toEqual({
      kind: "absolute",
      monthOffset: -1,
      weekOfMonth: 1,
    });
    expect(r.expressions[1].expression).toEqual({
      kind: "absolute",
      monthOffset: -1,
      weekOfMonth: 2,
    });
  });

  // --- separator 변형: N주 토큰 반복 ---
  it("지난달 1주 2주 (공백) → 두 개의 주차", () => {
    const r = runRules("지난달 1주 2주 매출");
    expect(r.confidence).toBe(1.0);
    expect(r.expressions).toHaveLength(2);
    expect(r.expressions[0].expression).toEqual({
      kind: "absolute",
      monthOffset: -1,
      weekOfMonth: 1,
    });
    expect(r.expressions[1].expression).toEqual({
      kind: "absolute",
      monthOffset: -1,
      weekOfMonth: 2,
    });
  });

  it("지난달 1주, 2주 (쉼표+공백) → 두 개의 주차", () => {
    const r = runRules("지난달 1주, 2주 보고");
    expect(r.confidence).toBe(1.0);
    expect(r.expressions).toHaveLength(2);
    expect(r.expressions[0].expression).toEqual({
      kind: "absolute",
      monthOffset: -1,
      weekOfMonth: 1,
    });
    expect(r.expressions[1].expression).toEqual({
      kind: "absolute",
      monthOffset: -1,
      weekOfMonth: 2,
    });
  });

  it("지난달 1주차 2주차 3주차 → 세 개의 주차", () => {
    const r = runRules("지난달 1주차 2주차 3주차 매출");
    expect(r.confidence).toBe(1.0);
    expect(r.expressions).toHaveLength(3);
    expect(r.expressions[0].expression).toEqual({
      kind: "absolute",
      monthOffset: -1,
      weekOfMonth: 1,
    });
    expect(r.expressions[1].expression).toEqual({
      kind: "absolute",
      monthOffset: -1,
      weekOfMonth: 2,
    });
    expect(r.expressions[2].expression).toEqual({
      kind: "absolute",
      monthOffset: -1,
      weekOfMonth: 3,
    });
  });

  it("저번주 목 → weekday_in_week -1/4", () => {
    const r = runRules("저번주 목 회의");
    expect(r.expressions[0].expression).toEqual({
      kind: "weekday_in_week",
      weekOffset: -1,
      weekday: 4,
    });
  });

  it("저번주 금 → weekday_in_week -1/5", () => {
    const r = runRules("저번주 금 실적");
    expect(r.expressions[0].expression).toEqual({
      kind: "weekday_in_week",
      weekOffset: -1,
      weekday: 5,
    });
  });

  it("이번주 월 → weekday_in_week 0/1", () => {
    const r = runRules("이번주 월 기준");
    expect(r.expressions[0].expression).toEqual({
      kind: "weekday_in_week",
      weekOffset: 0,
      weekday: 1,
    });
  });

  it("다음주 수 → weekday_in_week 1/3", () => {
    const r = runRules("다음주 수 미팅");
    expect(r.expressions[0].expression).toEqual({
      kind: "weekday_in_week",
      weekOffset: 1,
      weekday: 3,
    });
  });

  it("목요일 단독 → weekday_in_week nearestFuture/4", () => {
    const r = runRules("목요일 회의");
    expect(r.expressions[0].expression).toEqual({
      kind: "weekday_in_week",
      weekOffset: 0,
      weekday: 4,
      nearest: true,
    });
  });

  it("금요일 단독 → weekday_in_week nearestFuture/5", () => {
    const r = runRules("금요일 실적");
    expect(r.expressions[0].expression).toEqual({
      kind: "weekday_in_week",
      weekOffset: 0,
      weekday: 5,
      nearest: true,
    });
  });

  it("금욜 단독 → weekday_in_week nearestFuture/5", () => {
    const r = runRules("금욜 미팅");
    expect(r.expressions[0].expression).toEqual({
      kind: "weekday_in_week",
      weekOffset: 0,
      weekday: 5,
      nearest: true,
    });
  });

  it("저번주 목요일 → prefix 규칙이 단독 규칙보다 우선", () => {
    const r = runRules("저번주 목요일");
    expect(r.expressions[0].expression).toEqual({
      kind: "weekday_in_week",
      weekOffset: -1,
      weekday: 4,
    });
  });

  it("저번 목요일 → weekday_in_week -1/4 (주 없는 형태)", () => {
    const r = runRules("저번 목요일 회의");
    expect(r.expressions[0].expression).toEqual({
      kind: "weekday_in_week",
      weekOffset: -1,
      weekday: 4,
    });
  });

  it("지난 금요일 → weekday_in_week -1/5 (주 없는 형태)", () => {
    const r = runRules("지난 금요일 실적");
    expect(r.expressions[0].expression).toEqual({
      kind: "weekday_in_week",
      weekOffset: -1,
      weekday: 5,
    });
  });

  it("지난 월요일 → weekday_in_week -1/1", () => {
    const r = runRules("지난 월요일 기준");
    expect(r.expressions[0].expression).toEqual({
      kind: "weekday_in_week",
      weekOffset: -1,
      weekday: 1,
    });
  });

  it("저번 목 → weekday_in_week -1/4 (주+한글자 조합)", () => {
    const r = runRules("저번 목 회의");
    expect(r.expressions[0].expression).toEqual({
      kind: "weekday_in_week",
      weekOffset: -1,
      weekday: 4,
    });
  });

  it("저번주 목이 아파 → 목을 목요일로 오탐하지 않음", () => {
    const r = runRules("저번주 목이 아파");
    const hasWeekdayExpr = r.expressions.some(
      (e) => e.expression.kind === "weekday_in_week"
    );
    expect(hasWeekdayExpr).toBe(false);
  });
});
