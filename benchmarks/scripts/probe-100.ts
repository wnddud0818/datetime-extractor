import { extract, cacheClear } from "../../src/index.js";
import type { ExtractRequest, OutputMode } from "../../src/types.js";

/**
 * 100개 하드 케이스 정확도 프로브.
 * 기준일: 2026-04-18 (Saturday).
 *
 * 실행: npx tsx benchmarks/scripts/probe-100.ts
 *   --verbose  모든 케이스 상세 출력
 *   --fails    실패한 케이스만 상세 출력
 */

const REF = "2026-04-18"; // Saturday
const VERBOSE = process.argv.includes("--verbose");
const FAILS_ONLY = process.argv.includes("--fails");

type RangeExp = { start: string; end: string };

interface TC {
  id: number;
  cat: string;
  text: string;
  ref?: string;
  modes?: OutputMode[];
  opts?: Partial<ExtractRequest>;
  expected: {
    hasDate?: boolean;
    ranges?: RangeExp[];          // 순서 무관, 모두 매칭되어야 통과
    anyOfRanges?: RangeExp[][];   // 허용 가능한 여러 답 (어느 것이든 OK)
    holidaysContains?: string[];  // holidays 모드 응답이 반드시 포함해야 하는 날짜
    holidaysEquals?: string[];    // holidays 모드 응답 전체가 이 배열이어야 함
    businessDaysEquals?: string[];
    weekdaysCountMin?: number;
  };
  note?: string;
}

const cases: TC[] = [
  // ================================================================
  // A. 절대 날짜 (10)
  // ================================================================
  { id: 1, cat: "A.절대", text: "2025-12-25", expected: { ranges: [{ start: "2025-12-25", end: "2025-12-25" }] } },
  { id: 2, cat: "A.절대", text: "2025/12/25", expected: { ranges: [{ start: "2025-12-25", end: "2025-12-25" }] } },
  { id: 3, cat: "A.절대", text: "2025.12.25", expected: { ranges: [{ start: "2025-12-25", end: "2025-12-25" }] } },
  { id: 4, cat: "A.절대", text: "2025년 3월 1일", expected: { ranges: [{ start: "2025-03-01", end: "2025-03-01" }] } },
  { id: 5, cat: "A.절대", text: "2025년", expected: { ranges: [{ start: "2025-01-01", end: "2025-12-31" }] } },
  { id: 6, cat: "A.절대", text: "3월", expected: { ranges: [{ start: "2026-03-01", end: "2026-03-31" }] }, note: "ambiguity=past, 올해 3월이 과거라서 2026-03" },
  { id: 7, cat: "A.절대", text: "3월 1일", expected: { ranges: [{ start: "2026-03-01", end: "2026-03-01" }] } },
  { id: 8, cat: "A.절대", text: "2024년 2월 29일", expected: { ranges: [{ start: "2024-02-29", end: "2024-02-29" }] } },
  { id: 9, cat: "A.절대", text: "12월 25일", expected: { ranges: [{ start: "2025-12-25", end: "2025-12-25" }] }, note: "past=작년 12월" },
  { id: 10, cat: "A.절대", text: "4월 18일", expected: { ranges: [{ start: "2026-04-18", end: "2026-04-18" }] } },

  // ================================================================
  // B. 상대 연/월 (10)
  // ================================================================
  { id: 11, cat: "B.연월", text: "작년", expected: { ranges: [{ start: "2025-01-01", end: "2025-12-31" }] } },
  { id: 12, cat: "B.연월", text: "올해", expected: { ranges: [{ start: "2026-01-01", end: "2026-12-31" }] } },
  { id: 13, cat: "B.연월", text: "내년", expected: { ranges: [{ start: "2027-01-01", end: "2027-12-31" }] } },
  { id: 14, cat: "B.연월", text: "재작년", expected: { ranges: [{ start: "2024-01-01", end: "2024-12-31" }] } },
  { id: 15, cat: "B.연월", text: "제작년", expected: { ranges: [{ start: "2024-01-01", end: "2024-12-31" }] }, note: "재작년 alias" },
  { id: 16, cat: "B.연월", text: "이번달", expected: { ranges: [{ start: "2026-04-01", end: "2026-04-30" }] } },
  { id: 17, cat: "B.연월", text: "지난달", expected: { ranges: [{ start: "2026-03-01", end: "2026-03-31" }] } },
  { id: 18, cat: "B.연월", text: "저번달", expected: { ranges: [{ start: "2026-03-01", end: "2026-03-31" }] } },
  { id: 19, cat: "B.연월", text: "다음달", expected: { ranges: [{ start: "2026-05-01", end: "2026-05-31" }] } },
  { id: 20, cat: "B.연월", text: "지지난달", expected: { ranges: [{ start: "2026-02-01", end: "2026-02-28" }] } },

  // ================================================================
  // C. 주 / 요일 (10)
  // ================================================================
  { id: 21, cat: "C.주", text: "지난주", expected: { ranges: [{ start: "2026-04-06", end: "2026-04-12" }] } },
  { id: 22, cat: "C.주", text: "이번주", expected: { ranges: [{ start: "2026-04-13", end: "2026-04-19" }] } },
  { id: 23, cat: "C.주", text: "다음주", expected: { ranges: [{ start: "2026-04-20", end: "2026-04-26" }] } },
  { id: 24, cat: "C.주", text: "지지난주", expected: { ranges: [{ start: "2026-03-30", end: "2026-04-05" }] } },
  { id: 25, cat: "C.주", text: "이번 주 월요일", expected: { ranges: [{ start: "2026-04-13", end: "2026-04-13" }] } },
  { id: 26, cat: "C.주", text: "이번 주 금요일", expected: { ranges: [{ start: "2026-04-17", end: "2026-04-17" }] } },
  { id: 27, cat: "C.주", text: "다음주 월요일", expected: { ranges: [{ start: "2026-04-20", end: "2026-04-20" }] } },
  { id: 28, cat: "C.주", text: "지난주 수요일", expected: { ranges: [{ start: "2026-04-08", end: "2026-04-08" }] } },
  { id: 29, cat: "C.주", text: "다음주 일요일", expected: { ranges: [{ start: "2026-04-26", end: "2026-04-26" }] } },
  { id: 30, cat: "C.주", text: "지난주 금요일", expected: { ranges: [{ start: "2026-04-10", end: "2026-04-10" }] } },

  // ================================================================
  // D. N일/주/개월/년 전/뒤 (10)
  // ================================================================
  { id: 31, cat: "D.상대", text: "7일 전", expected: { ranges: [{ start: "2026-04-11", end: "2026-04-11" }] } },
  { id: 32, cat: "D.상대", text: "3일 뒤", expected: { ranges: [{ start: "2026-04-21", end: "2026-04-21" }] } },
  { id: 33, cat: "D.상대", text: "2주 전", expected: { ranges: [{ start: "2026-04-04", end: "2026-04-04" }] } },
  { id: 34, cat: "D.상대", text: "2주 뒤", expected: { ranges: [{ start: "2026-05-02", end: "2026-05-02" }] } },
  { id: 35, cat: "D.상대", text: "1개월 전", expected: { ranges: [{ start: "2026-03-18", end: "2026-03-18" }] } },
  { id: 36, cat: "D.상대", text: "2개월 뒤", expected: { ranges: [{ start: "2026-06-18", end: "2026-06-18" }] } },
  { id: 37, cat: "D.상대", text: "1년 전", expected: { ranges: [{ start: "2025-04-18", end: "2025-04-18" }] } },
  { id: 38, cat: "D.상대", text: "10년 전", expected: { ranges: [{ start: "2016-04-18", end: "2016-04-18" }] } },
  { id: 39, cat: "D.상대", text: "100일 뒤", expected: { ranges: [{ start: "2026-07-27", end: "2026-07-27" }] } },
  { id: 40, cat: "D.상대", text: "30일 전", expected: { ranges: [{ start: "2026-03-19", end: "2026-03-19" }] } },

  // ================================================================
  // E. 한국어 수사 (10)
  // ================================================================
  { id: 41, cat: "E.수사", text: "하루 전", expected: { ranges: [{ start: "2026-04-17", end: "2026-04-17" }] } },
  { id: 42, cat: "E.수사", text: "이틀 전", expected: { ranges: [{ start: "2026-04-16", end: "2026-04-16" }] } },
  { id: 43, cat: "E.수사", text: "사흘 전", expected: { ranges: [{ start: "2026-04-15", end: "2026-04-15" }] } },
  { id: 44, cat: "E.수사", text: "나흘 뒤", expected: { ranges: [{ start: "2026-04-22", end: "2026-04-22" }] } },
  { id: 45, cat: "E.수사", text: "닷새 뒤", expected: { ranges: [{ start: "2026-04-23", end: "2026-04-23" }] } },
  { id: 46, cat: "E.수사", text: "엿새 뒤", expected: { ranges: [{ start: "2026-04-24", end: "2026-04-24" }] } },
  { id: 47, cat: "E.수사", text: "이레 뒤", expected: { ranges: [{ start: "2026-04-25", end: "2026-04-25" }] } },
  { id: 48, cat: "E.수사", text: "여드레 뒤", expected: { ranges: [{ start: "2026-04-26", end: "2026-04-26" }] } },
  { id: 49, cat: "E.수사", text: "열흘 뒤", expected: { ranges: [{ start: "2026-04-28", end: "2026-04-28" }] } },
  { id: 50, cat: "E.수사", text: "보름 전", expected: { ranges: [{ start: "2026-04-03", end: "2026-04-03" }] } },

  // ================================================================
  // F. 일상어 (10)
  // ================================================================
  { id: 51, cat: "F.일상", text: "오늘", expected: { ranges: [{ start: "2026-04-18", end: "2026-04-18" }] } },
  { id: 52, cat: "F.일상", text: "어제", expected: { ranges: [{ start: "2026-04-17", end: "2026-04-17" }] } },
  { id: 53, cat: "F.일상", text: "내일", expected: { ranges: [{ start: "2026-04-19", end: "2026-04-19" }] } },
  { id: 54, cat: "F.일상", text: "모레", expected: { ranges: [{ start: "2026-04-20", end: "2026-04-20" }] } },
  { id: 55, cat: "F.일상", text: "글피", expected: { ranges: [{ start: "2026-04-21", end: "2026-04-21" }] } },
  { id: 56, cat: "F.일상", text: "그글피", expected: { ranges: [{ start: "2026-04-22", end: "2026-04-22" }] } },
  { id: 57, cat: "F.일상", text: "그저께", expected: { ranges: [{ start: "2026-04-16", end: "2026-04-16" }] } },
  { id: 58, cat: "F.일상", text: "엊그제", expected: { anyOfRanges: [[{ start: "2026-04-16", end: "2026-04-16" }], [{ start: "2026-04-15", end: "2026-04-15" }]] } },
  { id: 59, cat: "F.일상", text: "yesterday", expected: { ranges: [{ start: "2026-04-17", end: "2026-04-17" }] } },
  { id: 60, cat: "F.일상", text: "tomorrow", expected: { ranges: [{ start: "2026-04-19", end: "2026-04-19" }] } },

  // ================================================================
  // G. 필터 (영업일/평일/공휴일) (10)
  // ================================================================
  { id: 61, cat: "G.필터", text: "저번달 영업일", modes: ["business_days"], expected: { businessDaysEquals: [
    "2026-03-03","2026-03-04","2026-03-05","2026-03-06","2026-03-09","2026-03-10","2026-03-11","2026-03-12","2026-03-13",
    "2026-03-16","2026-03-17","2026-03-18","2026-03-19","2026-03-20","2026-03-23","2026-03-24","2026-03-25","2026-03-26","2026-03-27",
    "2026-03-30","2026-03-31",
  ] }, note: "3/1(일)·3/2(대체) 제외, 주말 제외 → 21일" },
  { id: 62, cat: "G.필터", text: "이번 달 평일", modes: ["weekdays"], expected: { weekdaysCountMin: 22 }, note: "4월 평일 22일" },
  { id: 63, cat: "G.필터", text: "작년 공휴일", modes: ["holidays"], expected: { holidaysContains: ["2025-01-01","2025-03-01","2025-05-05","2025-10-06","2025-12-25"] } },
  { id: 64, cat: "G.필터", text: "올해 공휴일", modes: ["holidays"], expected: { holidaysContains: ["2026-01-01","2026-02-17","2026-03-01","2026-05-05","2026-09-25","2026-12-25"] } },
  { id: 65, cat: "G.필터", text: "다음달 공휴일", modes: ["holidays"], expected: { holidaysEquals: ["2026-05-05","2026-05-24","2026-05-25"] } },
  { id: 66, cat: "G.필터", text: "이번달 공휴일", modes: ["holidays"], expected: { holidaysEquals: [] }, note: "2026-04 공휴일 없음 (엣지)" },
  { id: 67, cat: "G.필터", text: "이번 주 영업일", modes: ["business_days"], expected: { businessDaysEquals: ["2026-04-13","2026-04-14","2026-04-15","2026-04-16","2026-04-17"] } },
  { id: 68, cat: "G.필터", text: "다음주 영업일", modes: ["business_days"], expected: { businessDaysEquals: ["2026-04-20","2026-04-21","2026-04-22","2026-04-23","2026-04-24"] } },
  { id: 69, cat: "G.필터", text: "2024년 공휴일", modes: ["holidays"], expected: { holidaysContains: ["2024-02-09","2024-02-10","2024-02-12","2024-04-10","2024-05-06"] }, note: "대체공휴일·임시공휴일 포함 확인" },
  { id: 70, cat: "G.필터", text: "다음달 평일", modes: ["weekdays"], expected: { weekdaysCountMin: 21 } },

  // ================================================================
  // H. 분기 / 반기 (10)  (fiscalYearStart=1 default)
  // ================================================================
  { id: 71, cat: "H.분기", text: "1분기", expected: { ranges: [{ start: "2026-01-01", end: "2026-03-31" }] } },
  { id: 72, cat: "H.분기", text: "2분기", expected: { ranges: [{ start: "2026-04-01", end: "2026-06-30" }] } },
  { id: 73, cat: "H.분기", text: "작년 4분기", expected: { ranges: [{ start: "2025-10-01", end: "2025-12-31" }] } },
  { id: 74, cat: "H.분기", text: "상반기", expected: { ranges: [{ start: "2026-01-01", end: "2026-06-30" }] } },
  { id: 75, cat: "H.분기", text: "하반기", expected: { anyOfRanges: [[{ start: "2026-07-01", end: "2026-12-31" }], [{ start: "2025-07-01", end: "2025-12-31" }]] } },
  { id: 76, cat: "H.분기", text: "작년 상반기", expected: { ranges: [{ start: "2025-01-01", end: "2025-06-30" }] } },
  { id: 77, cat: "H.분기", text: "내년 1분기", expected: { ranges: [{ start: "2027-01-01", end: "2027-03-31" }] } },
  { id: 78, cat: "H.분기", text: "올해 1분기", expected: { ranges: [{ start: "2026-01-01", end: "2026-03-31" }] } },
  { id: 79, cat: "H.분기", text: "4분기", expected: { anyOfRanges: [[{ start: "2026-10-01", end: "2026-12-31" }], [{ start: "2025-10-01", end: "2025-12-31" }]] } },
  { id: 80, cat: "H.분기", text: "올해 상반기", expected: { ranges: [{ start: "2026-01-01", end: "2026-06-30" }] } },

  // ================================================================
  // I. 공휴일 고유명 & 음력 (10)
  // ================================================================
  { id: 81, cat: "I.고유", text: "설날", expected: { ranges: [{ start: "2026-02-17", end: "2026-02-17" }] } },
  { id: 82, cat: "I.고유", text: "추석", expected: { ranges: [{ start: "2026-09-25", end: "2026-09-25" }] } },
  { id: 83, cat: "I.고유", text: "어린이날", expected: { ranges: [{ start: "2026-05-05", end: "2026-05-05" }] } },
  { id: 84, cat: "I.고유", text: "크리스마스", expected: { ranges: [{ start: "2026-12-25", end: "2026-12-25" }] } },
  { id: 85, cat: "I.고유", text: "삼일절", expected: { ranges: [{ start: "2026-03-01", end: "2026-03-01" }] } },
  { id: 86, cat: "I.고유", text: "광복절", expected: { ranges: [{ start: "2026-08-15", end: "2026-08-15" }] } },
  { id: 87, cat: "I.고유", text: "현충일", expected: { ranges: [{ start: "2026-06-06", end: "2026-06-06" }] } },
  { id: 88, cat: "I.고유", text: "한글날", expected: { ranges: [{ start: "2026-10-09", end: "2026-10-09" }] } },
  { id: 89, cat: "I.고유", text: "음력 1월 1일", expected: { ranges: [{ start: "2026-02-17", end: "2026-02-17" }] } },
  { id: 90, cat: "I.고유", text: "정월 대보름", expected: { ranges: [{ start: "2026-03-03", end: "2026-03-03" }] }, note: "음력 1/15 = 2026-03-03" },

  // ================================================================
  // J. 영어 복합 & 엣지 (10)
  // ================================================================
  { id: 91, cat: "J.엣지", text: "안녕하세요", expected: { hasDate: false } },
  { id: 92, cat: "J.엣지", text: "last month sales", expected: { ranges: [{ start: "2026-03-01", end: "2026-03-31" }] } },
  { id: 93, cat: "J.엣지", text: "3 days ago", expected: { ranges: [{ start: "2026-04-15", end: "2026-04-15" }] } },
  { id: 94, cat: "J.엣지", text: "next Friday", expected: { ranges: [{ start: "2026-04-24", end: "2026-04-24" }] } },
  { id: 95, cat: "J.엣지", text: "3월 4월 잔액", expected: { ranges: [
    { start: "2026-03-01", end: "2026-03-31" },
    { start: "2026-04-01", end: "2026-04-30" },
  ] } },
  { id: 96, cat: "J.엣지", text: "작년 오늘", expected: { ranges: [{ start: "2025-04-18", end: "2025-04-18" }] } },
  { id: 97, cat: "J.엣지", text: "내년 1월 1일", expected: { ranges: [{ start: "2027-01-01", end: "2027-01-01" }] } },
  { id: 98, cat: "J.엣지", text: "월말", expected: { ranges: [{ start: "2026-04-30", end: "2026-04-30" }] } },
  { id: 99, cat: "J.엣지", text: "연말", expected: { ranges: [{ start: "2026-12-31", end: "2026-12-31" }] } },
  { id: 100, cat: "J.엣지", text: "3월 1일부터 5월 31일까지", expected: { ranges: [{ start: "2026-03-01", end: "2026-05-31" }] } },
];

// ---------------------- runner ----------------------
interface Result {
  tc: TC;
  pass: boolean;
  reason: string;
  actualSummary: string;
  path: string;
}

function rangeEq(a: RangeExp, b: RangeExp) {
  return a.start === b.start && a.end === b.end;
}

function matchRanges(expected: RangeExp[], actuals: RangeExp[]): boolean {
  if (expected.length !== actuals.length) return false;
  const used = new Set<number>();
  for (const exp of expected) {
    const idx = actuals.findIndex((a, i) => !used.has(i) && rangeEq(a, exp));
    if (idx < 0) return false;
    used.add(idx);
  }
  return true;
}

function pickRange(results: Array<{ mode: string; value: unknown }>): RangeExp | null {
  for (const r of results) {
    if (r.mode === "range") {
      const v = r.value as RangeExp;
      return { start: v.start, end: v.end };
    }
  }
  for (const r of results) {
    if (r.mode === "single") {
      const v = r.value as string;
      return { start: v, end: v };
    }
  }
  return null;
}

async function runOne(tc: TC): Promise<Result> {
  cacheClear();
  const modes = tc.modes ?? (["range", "single"] as OutputMode[]);
  let res;
  try {
    res = await extract({
      text: tc.text,
      referenceDate: tc.ref ?? REF,
      outputModes: modes,
      ...tc.opts,
    });
  } catch (e: any) {
    return {
      tc,
      pass: false,
      reason: `ERROR: ${e?.message ?? e}`,
      actualSummary: "(throw)",
      path: "err",
    };
  }

  const path = res.meta.path;
  const exp = tc.expected;

  // hasDate=false 체크
  if (exp.hasDate === false) {
    const ok = !res.hasDate || res.expressions.length === 0;
    return {
      tc,
      pass: ok,
      reason: ok ? "ok" : "expected no date but got expressions",
      actualSummary: res.expressions.map((e) => e.text).join(" | ") || "(none)",
      path,
    };
  }

  // holidays 모드
  if (exp.holidaysEquals || exp.holidaysContains) {
    const actual = new Set<string>();
    for (const e of res.expressions) {
      for (const r of e.results) {
        if (r.mode === "holidays") {
          const list = r.value as string[];
          for (const d of list) actual.add(d);
        }
      }
    }
    if (exp.holidaysEquals) {
      const expSet = new Set(exp.holidaysEquals);
      const same = actual.size === expSet.size && [...expSet].every((d) => actual.has(d));
      return {
        tc,
        pass: same,
        reason: same ? "ok" : `holidays mismatch: want [${exp.holidaysEquals.join(",")}] got [${[...actual].sort().join(",")}]`,
        actualSummary: [...actual].sort().join(","),
        path,
      };
    } else {
      const missing = exp.holidaysContains!.filter((d) => !actual.has(d));
      const ok = missing.length === 0;
      return {
        tc,
        pass: ok,
        reason: ok ? "ok" : `missing holidays: ${missing.join(",")}`,
        actualSummary: `size=${actual.size} [${[...actual].sort().slice(0, 6).join(",")}${actual.size > 6 ? "..." : ""}]`,
        path,
      };
    }
  }

  // business_days 모드
  if (exp.businessDaysEquals) {
    const actual: string[] = [];
    for (const e of res.expressions) {
      for (const r of e.results) {
        if (r.mode === "business_days") {
          const list = r.value as string[];
          for (const d of list) actual.push(d);
        }
      }
    }
    const same = actual.length === exp.businessDaysEquals.length && actual.every((d, i) => d === exp.businessDaysEquals![i]);
    return {
      tc,
      pass: same,
      reason: same ? "ok" : `business_days len want=${exp.businessDaysEquals.length} got=${actual.length}`,
      actualSummary: `size=${actual.length} first=${actual[0]} last=${actual[actual.length - 1]}`,
      path,
    };
  }

  // weekdays 모드 (카운트만)
  if (exp.weekdaysCountMin !== undefined) {
    let count = 0;
    for (const e of res.expressions) {
      for (const r of e.results) {
        if (r.mode === "weekdays") {
          const list = r.value as string[];
          count += list.length;
        }
      }
    }
    const ok = count >= exp.weekdaysCountMin;
    return {
      tc,
      pass: ok,
      reason: ok ? "ok" : `weekdays count ${count} < ${exp.weekdaysCountMin}`,
      actualSummary: `count=${count}`,
      path,
    };
  }

  // range/single 비교
  const actuals = res.expressions
    .map((e) => pickRange(e.results))
    .filter(Boolean) as RangeExp[];
  const actualSummary = actuals.map((a) => `${a.start}~${a.end}`).join(" | ") || "(none)";

  if (exp.anyOfRanges) {
    const ok = exp.anyOfRanges.some((cand) => matchRanges(cand, actuals));
    return {
      tc,
      pass: ok,
      reason: ok ? "ok" : `no anyOf match`,
      actualSummary,
      path,
    };
  }
  if (exp.ranges) {
    const ok = matchRanges(exp.ranges, actuals);
    return {
      tc,
      pass: ok,
      reason: ok ? "ok" : `range mismatch (want ${exp.ranges.map((r) => `${r.start}~${r.end}`).join(",")})`,
      actualSummary,
      path,
    };
  }

  return { tc, pass: false, reason: "no expected schema matched", actualSummary, path };
}

async function main() {
  // warm up Ollama? skip, many cases will use rule.
  const results: Result[] = [];
  for (const tc of cases) {
    const r = await runOne(tc);
    results.push(r);
    if (VERBOSE || (FAILS_ONLY && !r.pass)) {
      const mark = r.pass ? "✓" : "✗";
      console.log(`${mark} #${tc.id} [${tc.cat}] "${tc.text}"  path=${r.path}`);
      console.log(`    actual: ${r.actualSummary}`);
      if (!r.pass) console.log(`    reason: ${r.reason}`);
      if (tc.note) console.log(`    note:   ${tc.note}`);
    }
  }

  // ---- summary ----
  const total = results.length;
  const pass = results.filter((r) => r.pass).length;
  console.log(`\n========================================`);
  console.log(`전체 정확도: ${pass}/${total} (${((pass / total) * 100).toFixed(1)}%)`);
  console.log(`========================================`);

  // per-category
  const cats = new Map<string, { total: number; pass: number }>();
  for (const r of results) {
    const c = cats.get(r.tc.cat) ?? { total: 0, pass: 0 };
    c.total++;
    if (r.pass) c.pass++;
    cats.set(r.tc.cat, c);
  }
  console.log(`\n카테고리별:`);
  for (const [cat, s] of [...cats.entries()].sort()) {
    console.log(`  ${cat.padEnd(12)}  ${s.pass}/${s.total}  (${((s.pass / s.total) * 100).toFixed(0)}%)`);
  }

  // path breakdown
  const pathStats = new Map<string, { total: number; pass: number }>();
  for (const r of results) {
    const p = pathStats.get(r.path) ?? { total: 0, pass: 0 };
    p.total++;
    if (r.pass) p.pass++;
    pathStats.set(r.path, p);
  }
  console.log(`\n경로별:`);
  for (const [p, s] of [...pathStats.entries()].sort()) {
    console.log(`  ${p.padEnd(12)}  ${s.pass}/${s.total}  (${((s.pass / s.total) * 100).toFixed(0)}%)`);
  }

  // failures list
  const fails = results.filter((r) => !r.pass);
  if (fails.length > 0 && !VERBOSE && !FAILS_ONLY) {
    console.log(`\n실패 케이스 (${fails.length}개):`);
    for (const r of fails) {
      console.log(`  ✗ #${r.tc.id} [${r.tc.cat}] "${r.tc.text}"`);
      console.log(`     want: ${r.tc.expected.ranges?.map((x) => `${x.start}~${x.end}`).join(",") ?? JSON.stringify(r.tc.expected)}`);
      console.log(`     got : ${r.actualSummary}  (path=${r.path})`);
      if (r.reason !== "ok") console.log(`     ※ ${r.reason}`);
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
