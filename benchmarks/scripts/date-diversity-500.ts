import fs from "node:fs";
import path from "node:path";
import {
  addDays,
  addMonths,
  addWeeks,
  addYears,
  eachDayOfInterval,
  endOfMonth,
  endOfQuarter,
  endOfWeek,
  endOfYear,
  format,
  parseISO,
  startOfMonth,
  startOfQuarter,
  startOfWeek,
  startOfYear,
} from "date-fns";
import KoreanLunarCalendar from "korean-lunar-calendar";
import { cacheClear, extract } from "../../src/index.js";
import { runRules } from "../../src/rules/engine.js";
import {
  formatRange,
  getFilterKind,
  parseReferenceDate,
  resolveExpression,
} from "../../src/resolver/resolve.js";
import type { DateExpression, OutputMode } from "../../src/types.js";
import {
  datasetsDir,
  ensureBenchmarkDirs,
  repoRoot,
  reportsDir,
} from "./paths.js";

process.loadEnvFile?.(".env");

type Category =
  | "named_day"
  | "relative_numeric"
  | "week_weekday"
  | "absolute_calendar"
  | "month_year_relative"
  | "quarter_half_parts"
  | "named_holiday"
  | "range_comparison"
  | "english"
  | "filters"
  | "time"
  | "ambiguous_day";

type RangeExp = { start: string; end: string };
type DateTimeExp = { start: string; end: string };

interface Case {
  id: string;
  category: Category;
  text: string;
  referenceDate: string;
  presentRangeEnd: "today";
  outputMode: OutputMode;
  expected: Array<RangeExp | string[] | DateTimeExp>;
}

interface EvalReport {
  total: number;
  passed: number;
  accuracy: number;
  byCategory: Array<{
    category: Category;
    total: number;
    passed: number;
    accuracy: number;
  }>;
  byPath: Array<{ path: string; count: number }>;
  failures: Array<{
    id: string;
    category: Category;
    text: string;
    path: string;
    outputMode: OutputMode;
    expected: Array<RangeExp | string[] | DateTimeExp>;
    actual: Array<unknown>;
    issues: string[];
  }>;
}

const REFERENCE_DATE = "2025-11-17";
const CASE_TIMEOUT_MS = 15_000;
const RULE_ONLY = process.argv.includes("--rule-only");
const ref = parseISO(`${REFERENCE_DATE}T00:00:00`);
const jsonPath = path.join(datasetsDir, "date-diversity-500.json");
const reportPath = path.join(
  reportsDir,
  RULE_ONLY ? "date-diversity-500-rule-only-report.json" : "date-diversity-500-report.json",
);

const HOLIDAY_DATA = JSON.parse(
  fs.readFileSync(
    path.join(repoRoot, "src", "calendar", "holidays-fallback.json"),
    "utf8",
  ),
) as Record<string, Record<string, string>>;

function ymd(date: Date): string {
  return format(date, "yyyy-MM-dd");
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function clampIfCurrent(start: Date, end: Date): RangeExp {
  if (start <= ref && end >= ref) return { start: ymd(start), end: REFERENCE_DATE };
  return { start: ymd(start), end: ymd(end) };
}

function isExplicitSubset(expr: DateExpression): boolean {
  if (expr.kind === "absolute") {
    return !!(expr.yearPart || expr.monthPart || expr.weekOfMonth);
  }
  if (expr.kind === "quarter") {
    return !!expr.part;
  }
  if (expr.kind === "filter") {
    return isExplicitSubset(expr.base);
  }
  return false;
}

function dayRange(date: Date): RangeExp {
  const iso = ymd(date);
  return { start: iso, end: iso };
}

function weekOffsetRange(offset: number): RangeExp {
  const d = addWeeks(ref, offset);
  return clampIfCurrent(
    startOfWeek(d, { weekStartsOn: 1 }),
    endOfWeek(d, { weekStartsOn: 1 }),
  );
}

function weekdayInOffsetWeek(offset: number, weekday: number): RangeExp {
  const weekBase = addDays(ref, offset * 7);
  const weekStart = startOfWeek(weekBase, { weekStartsOn: 1 });
  const target = addDays(weekStart, (weekday - 1 + 7) % 7);
  return dayRange(target);
}

function monthOffsetRange(offset: number): RangeExp {
  const d = addMonths(ref, offset);
  return clampIfCurrent(startOfMonth(d), endOfMonth(d));
}

function yearOffsetRange(offset: number): RangeExp {
  const year = ref.getFullYear() + offset;
  return clampIfCurrent(new Date(year, 0, 1), new Date(year, 11, 31));
}

function monthOnlyPastRange(month: number): RangeExp {
  let year = ref.getFullYear();
  if (new Date(year, month - 1, 1) > ref) year -= 1;
  return { start: `${year}-${pad(month)}-01`, end: ymd(endOfMonth(new Date(year, month - 1, 1))) };
}

function dayOnlyPastRange(day: number): RangeExp {
  let year = ref.getFullYear();
  let month = ref.getMonth() + 1;
  if (day > ref.getDate()) {
    const prev = new Date(ref.getFullYear(), ref.getMonth() - 1, 1);
    year = prev.getFullYear();
    month = prev.getMonth() + 1;
  }
  const iso = `${year}-${pad(month)}-${pad(day)}`;
  return { start: iso, end: iso };
}

function monthDayPastRange(month: number, day: number): RangeExp {
  let year = ref.getFullYear();
  if (new Date(year, month - 1, day) > ref) year -= 1;
  const iso = `${year}-${pad(month)}-${pad(day)}`;
  return { start: iso, end: iso };
}

function quarterRange(year: number, quarter: 1 | 2 | 3 | 4): RangeExp {
  const start = new Date(year, (quarter - 1) * 3, 1);
  return clampIfCurrent(start, endOfQuarter(start));
}

function quarterOffsetRange(offset: number): RangeExp {
  const start = addMonths(startOfQuarter(ref), offset * 3);
  return clampIfCurrent(start, endOfQuarter(start));
}

function halfRange(year: number, half: 1 | 2): RangeExp {
  const startMonth = half === 1 ? 0 : 6;
  const start = new Date(year, startMonth, 1);
  return clampIfCurrent(start, endOfMonth(new Date(year, startMonth + 5, 1)));
}

function explicitYearRange(year: number): RangeExp {
  return clampIfCurrent(new Date(year, 0, 1), new Date(year, 11, 31));
}

function explicitMonthRange(year: number, month: number): RangeExp {
  const start = new Date(year, month - 1, 1);
  return clampIfCurrent(start, endOfMonth(start));
}

function explicitDayRange(year: number, month: number, day: number): RangeExp {
  const iso = `${year}-${pad(month)}-${pad(day)}`;
  return { start: iso, end: iso };
}

function explicitRange(
  sy: number,
  sm: number,
  sd: number,
  ey: number,
  em: number,
  ed: number,
): RangeExp {
  return {
    start: `${sy}-${pad(sm)}-${pad(sd)}`,
    end: `${ey}-${pad(em)}-${pad(ed)}`,
  };
}

function listWeekdays(range: RangeExp): string[] {
  return eachDayOfInterval({
    start: parseISO(`${range.start}T00:00:00`),
    end: parseISO(`${range.end}T00:00:00`),
  })
    .filter((d) => {
      const day = d.getDay();
      return day >= 1 && day <= 5;
    })
    .map((d) => ymd(d));
}

function listHolidays(range: RangeExp): string[] {
  const out: string[] = [];
  const startYear = Number(range.start.slice(0, 4));
  const endYear = Number(range.end.slice(0, 4));
  for (let year = startYear; year <= endYear; year++) {
    for (const date of Object.keys(HOLIDAY_DATA[String(year)] ?? {})) {
      if (date >= range.start && date <= range.end) out.push(date);
    }
  }
  return out.sort();
}

function listBusinessDays(range: RangeExp): string[] {
  const holidays = new Set(listHolidays(range));
  return eachDayOfInterval({
    start: parseISO(`${range.start}T00:00:00`),
    end: parseISO(`${range.end}T00:00:00`),
  })
    .filter((d) => {
      const day = d.getDay();
      return day >= 1 && day <= 5 && !holidays.has(ymd(d));
    })
    .map((d) => ymd(d));
}

function lunarToSolar(year: number, month: number, day: number): string {
  const cal = new KoreanLunarCalendar();
  cal.setLunarDate(year, month, day, false);
  const solar = cal.getSolarCalendar();
  return `${solar.year}-${pad(solar.month)}-${pad(solar.day)}`;
}

function holidayDay(name: string): RangeExp {
  const year = 2025;
  switch (name) {
    case "설날":
    case "음력 1월 1일":
      return { start: lunarToSolar(year, 1, 1), end: lunarToSolar(year, 1, 1) };
    case "추석":
      return { start: lunarToSolar(year, 8, 15), end: lunarToSolar(year, 8, 15) };
    case "정월 대보름":
      return { start: lunarToSolar(year, 1, 15), end: lunarToSolar(year, 1, 15) };
    case "어린이날":
      return explicitDayRange(year, 5, 5);
    case "크리스마스":
      return explicitDayRange(year, 12, 25);
    case "삼일절":
      return explicitDayRange(year, 3, 1);
    case "광복절":
      return explicitDayRange(year, 8, 15);
    case "현충일":
      return explicitDayRange(year, 6, 6);
    case "한글날":
      return explicitDayRange(year, 10, 9);
    case "부처님오신날":
      return { start: lunarToSolar(year, 4, 8), end: lunarToSolar(year, 4, 8) };
    default:
      throw new Error(`Unsupported holiday: ${name}`);
  }
}

function isoDateTime(date: Date, hour: number, minute: number, second: number): string {
  return `${ymd(date)}T${pad(hour)}:${pad(minute)}:${pad(second)}+09:00`;
}

function pointDateTime(date: Date, hour: number, minute = 0): DateTimeExp {
  const iso = isoDateTime(date, hour, minute, 0);
  return { start: iso, end: iso };
}

function rangeDateTime(
  date: Date,
  sh: number,
  sm: number,
  eh: number,
  em: number,
  endSecond = 0,
): DateTimeExp {
  return {
    start: isoDateTime(date, sh, sm, 0),
    end: isoDateTime(date, eh, em, endSecond),
  };
}

function eveningDateTime(date: Date): DateTimeExp {
  return rangeDateTime(date, 18, 0, 21, 0);
}

function morningDateTime(date: Date): DateTimeExp {
  return rangeDateTime(date, 6, 0, 12, 0);
}

function buildCases(): Case[] {
  const cases: Case[] = [];

  const namedDayExprs = [
    ["오늘", dayRange(ref)],
    ["어제", dayRange(addDays(ref, -1))],
    ["내일", dayRange(addDays(ref, 1))],
    ["그제", dayRange(addDays(ref, -2))],
    ["그저께", dayRange(addDays(ref, -2))],
    ["엊그제", dayRange(addDays(ref, -2))],
    ["모레", dayRange(addDays(ref, 2))],
    ["글피", dayRange(addDays(ref, 3))],
    ["그글피", dayRange(addDays(ref, 4))],
    ["사흘 전", dayRange(addDays(ref, -3))],
    ["나흘 전", dayRange(addDays(ref, -4))],
    ["보름 전", dayRange(addDays(ref, -15))],
  ] as const;
  const namedDayScenarios = [
    "예적금 잔액 흐름 좀 보여줘",
    "외화 계좌에서 빠져나간 돈이 있었는지 봐줘",
    "신탁 입출금 내역만 따로 확인하고 싶어",
    "증권 거래내역을 바로 보고 싶어",
  ];
  namedDayExprs.forEach(([phrase, expected], i) => {
    namedDayScenarios.forEach((tail, j) => {
      cases.push({
        id: `named-${i + 1}-${j + 1}`,
        category: "named_day",
        text: `${phrase} ${tail}`,
        referenceDate: REFERENCE_DATE,
        presentRangeEnd: "today",
        outputMode: "range",
        expected: [expected],
      });
    });
  });

  const relativeExprs = [
    ["7일 전", dayRange(addDays(ref, -7))],
    ["30일 전", dayRange(addDays(ref, -30))],
    ["100일 뒤", dayRange(addDays(ref, 100))],
    ["2주 전", dayRange(addDays(ref, -14))],
    ["2주 뒤", dayRange(addDays(ref, 14))],
    ["1개월 전", dayRange(addMonths(ref, -1))],
    ["2개월 뒤", dayRange(addMonths(ref, 2))],
    ["1년 전", dayRange(addYears(ref, -1))],
    ["10년 전", dayRange(addYears(ref, -10))],
    ["최근 6개월간", { start: ymd(addMonths(ref, -6)), end: REFERENCE_DATE }],
  ] as const;
  const relativeScenarios = [
    "거래내역만 보여줘",
    "잔액 기준으로 무슨 변화가 있었는지 봐줘",
    "대출 쪽 흐름만 확인하고 싶어",
    "자금 움직임을 정리해줘",
  ];
  relativeExprs.forEach(([phrase, expected], i) => {
    relativeScenarios.forEach((tail, j) => {
      cases.push({
        id: `relative-${i + 1}-${j + 1}`,
        category: "relative_numeric",
        text: `${phrase} ${tail}`,
        referenceDate: REFERENCE_DATE,
        presentRangeEnd: "today",
        outputMode: "range",
        expected: [expected],
      });
    });
  });

  const weekExprs = [
    ["지난주", weekOffsetRange(-1)],
    ["이번 주", weekOffsetRange(0)],
    ["다음주", weekOffsetRange(1)],
    ["지지난주", weekOffsetRange(-2)],
    ["지난주 수요일", weekdayInOffsetWeek(-1, 3)],
    ["이번 주 금요일", weekdayInOffsetWeek(0, 5)],
    ["다음주 월요일", weekdayInOffsetWeek(1, 1)],
    ["다음주 일요일", weekdayInOffsetWeek(1, 7)],
    ["이번 주 월요일", weekdayInOffsetWeek(0, 1)],
    ["다음주 금요일", weekdayInOffsetWeek(1, 5)],
  ] as const;
  const weekScenarios = [
    "거래내역을 보고 싶어",
    "잔액만 따로 확인해줘",
    "입출금 흐름을 정리해줘",
    "자금 상황을 보여줘",
  ];
  weekExprs.forEach(([phrase, expected], i) => {
    weekScenarios.forEach((tail, j) => {
      cases.push({
        id: `week-${i + 1}-${j + 1}`,
        category: "week_weekday",
        text: `${phrase} ${tail}`,
        referenceDate: REFERENCE_DATE,
        presentRangeEnd: "today",
        outputMode: "range",
        expected: [expected],
      });
    });
  });

  const absoluteExprs = [
    ["2025-12-25", explicitDayRange(2025, 12, 25)],
    ["2025/12/25", explicitDayRange(2025, 12, 25)],
    ["2025.12.25", explicitDayRange(2025, 12, 25)],
    ["2025년 3월 1일", explicitDayRange(2025, 3, 1)],
    ["2024년 2월 29일", explicitDayRange(2024, 2, 29)],
    ["2025년", explicitYearRange(2025)],
    ["2024년 2월", explicitMonthRange(2024, 2)],
    ["2026년 8월", explicitMonthRange(2026, 8)],
    ["2025년 3월", explicitMonthRange(2025, 3)],
    ["2024년 10월 9일", explicitDayRange(2024, 10, 9)],
    ["2023년", explicitYearRange(2023)],
    ["2023년 12월", explicitMonthRange(2023, 12)],
    ["2020년 2월", explicitMonthRange(2020, 2)],
    ["2029년 12월", explicitMonthRange(2029, 12)],
    ["2026년 3월", explicitMonthRange(2026, 3)],
  ] as const;
  const absoluteScenarios = [
    "기준으로 거래내역을 뽑아줘",
    "잔액이 어땠는지 보고 싶어",
    "대출 쪽 흐름만 정리해줘",
    "증권 거래가 있었는지 확인해줘",
  ];
  absoluteExprs.forEach(([phrase, expected], i) => {
    absoluteScenarios.forEach((tail, j) => {
      cases.push({
        id: `absolute-${i + 1}-${j + 1}`,
        category: "absolute_calendar",
        text: `${phrase} ${tail}`,
        referenceDate: REFERENCE_DATE,
        presentRangeEnd: "today",
        outputMode: "range",
        expected: [expected],
      });
    });
  });

  const relMonthYearExprs = [
    ["지난달", monthOffsetRange(-1)],
    ["저번달", monthOffsetRange(-1)],
    ["이번달", monthOffsetRange(0)],
    ["다음달", monthOffsetRange(1)],
    ["지지난달", monthOffsetRange(-2)],
    ["3월", monthOnlyPastRange(3)],
    ["8월", monthOnlyPastRange(8)],
    ["올해", yearOffsetRange(0)],
    ["작년", yearOffsetRange(-1)],
    ["재작년", yearOffsetRange(-2)],
  ] as const;
  const relMonthYearScenarios = [
    "예적금 흐름만 보고 싶어",
    "외화 거래내역을 정리해줘",
    "자금 증감 현황을 보여줘",
    "삼성전자 거래 비중을 확인해줘",
    "운영비가 얼마나 나갔는지 봐줘",
  ];
  relMonthYearExprs.forEach(([phrase, expected], i) => {
    relMonthYearScenarios.forEach((tail, j) => {
      cases.push({
        id: `relyear-${i + 1}-${j + 1}`,
        category: "month_year_relative",
        text: `${phrase} ${tail}`,
        referenceDate: REFERENCE_DATE,
        presentRangeEnd: "today",
        outputMode: "range",
        expected: [expected],
      });
    });
  });

  const quarterExprs = [
    ["1분기", quarterRange(2025, 1)],
    ["2분기", quarterRange(2025, 2)],
    ["4분기", quarterRange(2025, 4)],
    ["이번분기", quarterOffsetRange(0)],
    ["지난분기", quarterOffsetRange(-1)],
    ["상반기", halfRange(2025, 1)],
    ["하반기", halfRange(2025, 2)],
    ["올해 상반기", halfRange(2025, 1)],
    ["작년 4분기", quarterRange(2024, 4)],
    ["올해 말", { start: "2025-10-01", end: "2025-12-31" }],
    ["월말", { start: "2025-11-30", end: "2025-11-30" }],
    ["월초", { start: "2025-11-01", end: "2025-11-01" }],
  ] as const;
  const quarterScenarios = [
    "거래내역을 보고 싶어",
    "잔액 흐름을 확인해줘",
    "입출금 변화가 어땠는지 보여줘",
    "외화 계좌 쪽만 따로 정리해줘",
  ];
  quarterExprs.forEach(([phrase, expected], i) => {
    quarterScenarios.forEach((tail, j) => {
      cases.push({
        id: `quarter-${i + 1}-${j + 1}`,
        category: "quarter_half_parts",
        text: `${phrase} ${tail}`,
        referenceDate: REFERENCE_DATE,
        presentRangeEnd: "today",
        outputMode: "range",
        expected: [expected],
      });
    });
  });

  const holidayExprs = [
    "설날",
    "추석",
    "어린이날",
    "크리스마스",
    "삼일절",
    "광복절",
    "현충일",
    "한글날",
    "음력 1월 1일",
    "정월 대보름",
  ] as const;
  const holidayScenarios = [
    "기준 거래내역을 보고 싶어",
    "잔액이 어땠는지 확인해줘",
    "그 시점 입출금 내역을 보여줘",
    "외화 계좌 흐름만 정리해줘",
  ];
  holidayExprs.forEach((phrase, i) => {
    holidayScenarios.forEach((tail, j) => {
      cases.push({
        id: `holiday-${i + 1}-${j + 1}`,
        category: "named_holiday",
        text: `${phrase} ${tail}`,
        referenceDate: REFERENCE_DATE,
        presentRangeEnd: "today",
        outputMode: "range",
        expected: [holidayDay(phrase)],
      });
    });
  });

  const rangeSpecs: Array<{ text: string; expected: RangeExp[] }> = [
    { text: "3월 4월 거래 흐름을 같이 보고 싶어", expected: [monthOnlyPastRange(3), monthOnlyPastRange(4)] },
    { text: "지난달과 이번 달 지출 차이를 비교해줘", expected: [monthOffsetRange(-1), monthOffsetRange(0)] },
    { text: "작년과 올해 자금 증감 현황을 나란히 보여줘", expected: [yearOffsetRange(-1), yearOffsetRange(0)] },
    { text: "지난분기랑 이번분기 외화 흐름을 비교해줘", expected: [quarterOffsetRange(-1), quarterOffsetRange(0)] },
    { text: "2024년과 2025년 거래 규모를 비교해줘", expected: [explicitYearRange(2024), explicitYearRange(2025)] },
    { text: "2024년 2월과 2024년 3월 잔액 흐름을 같이 보여줘", expected: [explicitMonthRange(2024, 2), explicitMonthRange(2024, 3)] },
    { text: "1분기와 2분기 대출 흐름을 같이 보자", expected: [quarterRange(2025, 1), quarterRange(2025, 2)] },
    { text: "2025년 3월 1일부터 5월 31일까지 거래내역만 보여줘", expected: [explicitRange(2025, 3, 1, 2025, 5, 31)] },
    { text: "2023년 1월 1일부터 10일까지 사이의 입출금만 확인하고 싶어", expected: [explicitRange(2023, 1, 1, 2023, 1, 10)] },
    { text: "2024년 상반기와 하반기 자금 상황을 비교해줘", expected: [halfRange(2024, 1), halfRange(2024, 2)] },
    { text: "지난주와 이번 주 거래량을 나란히 보여줘", expected: [weekOffsetRange(-1), weekOffsetRange(0)] },
    { text: "작년 4분기랑 올해 1분기 실적 흐름을 비교해줘", expected: [quarterRange(2024, 4), quarterRange(2025, 1)] },
  ];
  rangeSpecs.forEach((spec, i) => {
    cases.push({
      id: `range-${i + 1}`,
      category: "range_comparison",
      text: spec.text,
      referenceDate: REFERENCE_DATE,
      presentRangeEnd: "today",
      outputMode: "range",
      expected: spec.expected,
    });
  });
  const rangeScenarioTails = [
    "좀 더 자세히 보여줘",
    "잔액 기준으로도 비교해줘",
    "거래내역만 다시 정리해줘",
  ];
  rangeSpecs.slice(0, 8).forEach((spec, i) => {
    rangeScenarioTails.forEach((tail, j) => {
      cases.push({
        id: `range-extra-${i + 1}-${j + 1}`,
        category: "range_comparison",
        text: `${spec.text} ${tail}`,
        referenceDate: REFERENCE_DATE,
        presentRangeEnd: "today",
        outputMode: "range",
        expected: spec.expected,
      });
    });
  });

  const englishCases: Array<{ text: string; expected: RangeExp[] }> = [
    { text: "Show me the outflow from yesterday", expected: [dayRange(addDays(ref, -1))] },
    { text: "What changed by tomorrow for the cash balance?", expected: [dayRange(addDays(ref, 1))] },
    { text: "Pull the balance trend for last month", expected: [monthOffsetRange(-1)] },
    { text: "Show me the activity for next week", expected: [weekOffsetRange(1)] },
    { text: "I want to review what happened 3 days ago", expected: [dayRange(addDays(ref, -3))] },
    { text: "Can you check next Friday only?", expected: [weekdayInOffsetWeek(1, 5)] },
    { text: "Review March 15, 2025 transactions", expected: [explicitDayRange(2025, 3, 15)] },
    { text: "Show the balance on 3/15/2025", expected: [explicitDayRange(2025, 3, 15)] },
    { text: "Summarize Q2 2025 cash activity", expected: [quarterRange(2025, 2)] },
    { text: "I need the first half of 2024 trend", expected: [halfRange(2024, 1)] },
    { text: "Compare the past 30 days inflow and outflow", expected: [{ start: ymd(addDays(ref, -30)), end: REFERENCE_DATE }] },
    { text: "Show the movement for the day after tomorrow", expected: [dayRange(addDays(ref, 2))] },
  ];
  const englishTail = [
    "",
    " in detail",
    " for the finance report",
  ];
  englishCases.forEach((spec, i) => {
    englishTail.forEach((tail, j) => {
      cases.push({
        id: `en-${i + 1}-${j + 1}`,
        category: "english",
        text: `${spec.text}${tail}`,
        referenceDate: REFERENCE_DATE,
        presentRangeEnd: "today",
        outputMode: "range",
        expected: spec.expected,
      });
    });
  });

  const filterCases: Array<{ text: string; mode: OutputMode; expected: string[] }> = [
    { text: "이번 달 영업일만 뽑아줘", mode: "business_days", expected: listBusinessDays(monthOffsetRange(0)) },
    { text: "작년 공휴일 목록을 보여줘", mode: "holidays", expected: listHolidays(yearOffsetRange(-1)) },
    { text: "올해 공휴일이 언제였는지 정리해줘", mode: "holidays", expected: listHolidays(yearOffsetRange(0)) },
    { text: "다음달 공휴일이 있는지 보여줘", mode: "holidays", expected: listHolidays(monthOffsetRange(1)) },
    { text: "이번 달 평일만 보고 싶어", mode: "weekdays", expected: listWeekdays(monthOffsetRange(0)) },
    { text: "다음달 평일 리스트를 보여줘", mode: "weekdays", expected: listWeekdays(monthOffsetRange(1)) },
    { text: "지난달 영업일만 추려줘", mode: "business_days", expected: listBusinessDays(monthOffsetRange(-1)) },
    { text: "이번 주 영업일 일정이 궁금해", mode: "business_days", expected: listBusinessDays(weekOffsetRange(0)) },
    { text: "다음주 영업일만 알려줘", mode: "business_days", expected: listBusinessDays(weekOffsetRange(1)) },
    { text: "올해 공휴일 날짜를 쭉 보여줘", mode: "holidays", expected: listHolidays(yearOffsetRange(0)) },
  ];
  const filterTail = [
    "",
    " 빠짐없이",
    " 바로",
  ];
  filterCases.forEach((spec, i) => {
    filterTail.forEach((tail, j) => {
      cases.push({
        id: `filter-${i + 1}-${j + 1}`,
        category: "filters",
        text: `${spec.text}${tail}`,
        referenceDate: REFERENCE_DATE,
        presentRangeEnd: "today",
        outputMode: spec.mode,
        expected: [spec.expected],
      });
    });
  });

  const timeCases: Array<{ text: string; expected: DateTimeExp }> = [
    { text: "오후 3시에 빠져나간 돈이 있었는지 봐줘", expected: pointDateTime(ref, 15) },
    { text: "오전 9시 30분 입금 건만 보여줘", expected: pointDateTime(ref, 9, 30) },
    { text: "15:30 기준 거래내역이 궁금해", expected: pointDateTime(ref, 15, 30) },
    { text: "저녁에 자금이 얼마나 있었는지 보고 싶어", expected: eveningDateTime(ref) },
    { text: "새벽 2시에 처리된 건이 있었는지 확인해줘", expected: pointDateTime(ref, 2) },
    { text: "내일 오후 3시 기준 잔액을 보고 싶어", expected: pointDateTime(addDays(ref, 1), 15) },
    { text: "다음주 월요일 오전 10시 거래를 확인해줘", expected: pointDateTime(parseISO(`${weekdayInOffsetWeek(1, 1).start}T00:00:00`), 10) },
    { text: "tomorrow morning cash movement", expected: morningDateTime(addDays(ref, 1)) },
    { text: "next Friday 5pm balance check", expected: pointDateTime(parseISO(`${weekdayInOffsetWeek(1, 5).start}T00:00:00`), 17) },
    { text: "from 9am to 5pm cash activity", expected: rangeDateTime(ref, 9, 0, 17, 0) },
  ];
  const timeTail = [
    "",
    " 좀 자세히",
    " 바로",
    " 한번",
  ];
  timeCases.forEach((spec, i) => {
    timeTail.forEach((tail, j) => {
      cases.push({
        id: `time-${i + 1}-${j + 1}`,
        category: "time",
        text: `${spec.text}${tail}`,
        referenceDate: REFERENCE_DATE,
        presentRangeEnd: "today",
        outputMode: "datetime",
        expected: [spec.expected],
      });
    });
  });

  const ambiguousCases: Array<{ phrase: string; expected: RangeExp }> = [
    { phrase: "19일", expected: dayOnlyPastRange(19) },
    { phrase: "25일", expected: dayOnlyPastRange(25) },
    { phrase: "5일", expected: dayOnlyPastRange(5) },
    { phrase: "12월 25일", expected: monthDayPastRange(12, 25) },
    { phrase: "3월 1일", expected: monthDayPastRange(3, 1) },
    { phrase: "연말", expected: { start: "2025-12-31", end: "2025-12-31" } },
    { phrase: "연초", expected: { start: "2025-01-01", end: "2025-01-01" } },
    { phrase: "월말", expected: { start: "2025-11-30", end: "2025-11-30" } },
  ];
  const ambiguousScenarios = [
    "거래내역만 보여줘",
    "잔액을 확인하고 싶어",
    "자금 흐름을 정리해줘",
    "출금 내역을 보여줘",
  ];
  ambiguousCases.forEach((spec, i) => {
    ambiguousScenarios.forEach((tail, j) => {
      cases.push({
        id: `amb-${i + 1}-${j + 1}`,
        category: "ambiguous_day",
        text: `${spec.phrase} ${tail}`,
        referenceDate: REFERENCE_DATE,
        presentRangeEnd: "today",
        outputMode: "range",
        expected: [spec.expected],
      });
    });
  });

  if (cases.length !== 500) {
    throw new Error(`Expected 500 cases, got ${cases.length}`);
  }
  return cases;
}

function stable(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`)
    .join(",")}}`;
}

function sameMultiset(actual: unknown[], expected: unknown[]): boolean {
  if (actual.length !== expected.length) return false;
  const remaining = expected.map((x) => stable(x));
  for (const a of actual.map((x) => stable(x))) {
    const idx = remaining.indexOf(a);
    if (idx < 0) return false;
    remaining.splice(idx, 1);
  }
  return remaining.length === 0;
}

function pickValue(results: Array<{ mode: string; value: unknown }>, mode: OutputMode): unknown | null {
  return results.find((result) => result.mode === mode)?.value ?? null;
}

async function evaluateRuleOnlyCase(
  testCase: Case,
): Promise<{ pathName: string; actual: unknown[]; hasDate: boolean }> {
  const timezone = "Asia/Seoul";
  const referenceDate = parseReferenceDate(testCase.referenceDate);
  const ruleResult = runRules(testCase.text, "auto");
  const actual: unknown[] = [];

  for (const matched of ruleResult.expressions) {
    const range = resolveExpression(matched.expression, {
      referenceDate,
      timezone,
    });
    if (
      testCase.presentRangeEnd === "today" &&
      !isExplicitSubset(matched.expression) &&
      range.start <= referenceDate &&
      range.end > referenceDate
    ) {
      range.end = referenceDate;
    }

    const filter = getFilterKind(matched.expression);
    const value = await formatRange(range, testCase.outputMode, filter, {
      timezone,
      dateOnlyForDateModes: true,
    });
    if (value) actual.push(value.value);
  }

  const pathName =
    ruleResult.expressions.length === 0
      ? "rule_only:no_match"
      : ruleResult.confidence >= 1
        ? "rule_only:full"
        : "rule_only:partial";

  return {
    pathName,
    actual,
    hasDate: ruleResult.expressions.length > 0,
  };
}

async function evaluate(cases: Case[]): Promise<EvalReport> {
  const byCategory = new Map<Category, { total: number; passed: number }>();
  const byPath = new Map<string, number>();
  const failures: EvalReport["failures"] = [];
  let passed = 0;

  for (let i = 0; i < cases.length; i++) {
    const testCase = cases[i];
    cacheClear();
    let pathName = "unknown";
    let actual: unknown[] = [];
    let hasDate = false;
    const issues: string[] = [];
    let ok = true;

    try {
      if (RULE_ONLY) {
        const ruleOnlyRes = await evaluateRuleOnlyCase(testCase);
        pathName = ruleOnlyRes.pathName;
        actual = ruleOnlyRes.actual;
        hasDate = ruleOnlyRes.hasDate;
      } else {
        const res = await Promise.race([
          extract({
            text: testCase.text,
            referenceDate: testCase.referenceDate,
            outputModes: [testCase.outputMode],
            presentRangeEnd: testCase.presentRangeEnd,
          }),
          new Promise<never>((_, reject) => {
            setTimeout(() => reject(new Error(`timeout after ${CASE_TIMEOUT_MS}ms`)), CASE_TIMEOUT_MS);
          }),
        ]);

        pathName = res.meta.path;
        actual = res.expressions
          .map((expr) => pickValue(expr.results, testCase.outputMode))
          .filter((value) => value !== null);
        hasDate = res.hasDate;
      }

      if (testCase.expected.length === 0) {
        if (hasDate || actual.length > 0) {
          ok = false;
          issues.push("expected no date");
        }
      } else {
        if (!hasDate) {
          ok = false;
          issues.push("hasDate=false");
        }
        if (!sameMultiset(actual, testCase.expected)) {
          ok = false;
          issues.push(`expected=${stable(testCase.expected)} actual=${stable(actual)}`);
        }
      }
    } catch (error) {
      ok = false;
      pathName = "timeout";
      issues.push(error instanceof Error ? error.message : String(error));
    }

    const stats = byCategory.get(testCase.category) ?? { total: 0, passed: 0 };
    stats.total += 1;
    if (ok) {
      passed += 1;
      stats.passed += 1;
    } else if (failures.length < 40) {
      failures.push({
        id: testCase.id,
        category: testCase.category,
        text: testCase.text,
        path: pathName,
        outputMode: testCase.outputMode,
        expected: testCase.expected,
        actual,
        issues,
      });
    }
    byCategory.set(testCase.category, stats);
    byPath.set(pathName, (byPath.get(pathName) ?? 0) + 1);

    if ((i + 1) % 100 === 0 || i === cases.length - 1) {
      console.log(`evaluated ${i + 1}/${cases.length}`);
    }
  }

  return {
    total: cases.length,
    passed,
    accuracy: Number(((passed / cases.length) * 100).toFixed(2)),
    byCategory: [...byCategory.entries()]
      .map(([category, stats]) => ({
        category,
        total: stats.total,
        passed: stats.passed,
        accuracy: Number(((stats.passed / stats.total) * 100).toFixed(2)),
      }))
      .sort((a, b) => a.category.localeCompare(b.category)),
    byPath: [...byPath.entries()]
      .map(([pathName, count]) => ({ path: pathName, count }))
      .sort((a, b) => a.path.localeCompare(b.path)),
    failures,
  };
}

function writeArtifacts(cases: Case[], report: EvalReport) {
  ensureBenchmarkDirs();
  fs.writeFileSync(
    jsonPath,
    `${JSON.stringify(
      {
        referenceDate: REFERENCE_DATE,
        presentRangeEnd: "today",
        cases,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
}

async function main() {
  const cases = buildCases();
  const report = await evaluate(cases);
  writeArtifacts(cases, report);

  console.log(`\nwritten: ${jsonPath}`);
  console.log(`report: ${reportPath}`);
  console.log(`mode: ${RULE_ONLY ? "rule-only" : "hybrid"}`);
  console.log(`referenceDate: ${REFERENCE_DATE}`);
  console.log(`accuracy: ${report.passed}/${report.total} (${report.accuracy.toFixed(2)}%)`);
  console.log("by category:");
  for (const category of report.byCategory) {
    console.log(
      `  ${category.category.padEnd(20)} ${category.passed}/${category.total} (${category.accuracy.toFixed(2)}%)`,
    );
  }
  console.log("by path:");
  for (const pathEntry of report.byPath) {
    console.log(`  ${pathEntry.path.padEnd(10)} ${pathEntry.count}`);
  }
  if (report.failures.length > 0) {
    console.log("sample failures:");
    for (const failure of report.failures.slice(0, 15)) {
      console.log(`  - ${failure.text} [${failure.outputMode}, ${failure.path}]`);
      console.log(`    expected: ${stable(failure.expected)}`);
      console.log(`    actual:   ${stable(failure.actual)}`);
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
