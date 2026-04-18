import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
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
import { cacheClear, extract, warmUp } from "../src/index.js";
import { runRules } from "../src/rules/engine.js";
import {
  formatRange,
  getFilterKind,
  parseReferenceDate,
  resolveExpression,
} from "../src/resolver/resolve.js";
import type {
  DateExpression,
  ExtractRequest,
  ExtractResponse,
  OutputMode,
  ResolvedValue,
} from "../src/types.js";

process.loadEnvFile?.(".env");

type SuiteName = "default" | "force_llm";

interface ExpectedExpression {
  single?: string;
  range?: string | { start: string; end: string };
  datetime?: { start: string; end: string };
  business_days?: string[];
  weekdays?: string[];
  holidays?: string[];
}

interface ExpectedCase {
  hasDate: boolean;
  expressions: ExpectedExpression[];
}

interface EvalCase {
  id: string;
  suite: SuiteName;
  category: string;
  text: string;
  referenceDate: string;
  timezone: "Asia/Seoul";
  outputModes: OutputMode[];
  forceLLM?: boolean;
  dateOnlyForDateModes?: boolean;
  expected: ExpectedCase;
}

interface CaseTemplate {
  key: string;
  suite: SuiteName;
  category: string;
  build: (ref: Date) => Omit<EvalCase, "id" | "suite" | "category" | "referenceDate" | "timezone">;
}

interface CaseResult {
  testCase: EvalCase;
  pass: boolean;
  issues: string[];
  path: string;
  actual?: ExtractResponse;
  error?: string;
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");
const benchmarkDir = path.join(projectRoot, "benchmarks");
const datasetPath = path.join(benchmarkDir, "datetime-eval-suite.json");
const RULE_ONLY = process.argv.includes("--rule-only");
const reportPath = path.join(
  benchmarkDir,
  RULE_ONLY ? "datetime-eval-rule-only-report.json" : "datetime-eval-report.json",
);

const REF_DATES = [
  "2025-01-10",
  "2025-11-17",
  "2026-04-18",
  "2026-12-31",
  "2027-09-16",
  "2028-02-29",
  "2029-12-30",
] as const;

const HOLIDAY_DATA = JSON.parse(
  fs.readFileSync(
    path.join(projectRoot, "src", "calendar", "holidays-fallback.json"),
    "utf-8",
  ),
) as Record<string, Record<string, string>>;

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function ymd(date: Date): string {
  return format(date, "yyyy-MM-dd");
}

function parseYmd(iso: string): Date {
  return parseISO(`${iso}T00:00:00+09:00`);
}

function dayRange(date: Date): { start: string; end: string } {
  const iso = ymd(date);
  return { start: iso, end: iso };
}

function range(start: Date, end: Date): { start: string; end: string } {
  return { start: ymd(start), end: ymd(end) };
}

function yearRange(year: number): { start: string; end: string } {
  const start = new Date(year, 0, 1);
  return { start: ymd(start), end: ymd(endOfYear(start)) };
}

function monthRange(year: number, month: number): { start: string; end: string } {
  const start = new Date(year, month - 1, 1);
  return { start: ymd(start), end: ymd(endOfMonth(start)) };
}

function monthOffsetRange(ref: Date, offset: number): { start: string; end: string } {
  const d = addMonths(ref, offset);
  return range(startOfMonth(d), endOfMonth(d));
}

function weekOffsetRange(ref: Date, offset: number): { start: string; end: string } {
  const d = addWeeks(ref, offset);
  return range(
    startOfWeek(d, { weekStartsOn: 1 }),
    endOfWeek(d, { weekStartsOn: 1 }),
  );
}

function nthWeekdayInOffsetWeek(
  ref: Date,
  weekOffset: number,
  weekday: number,
): Date {
  const weekBase = addDays(ref, weekOffset * 7);
  const start = startOfWeek(weekBase, { weekStartsOn: 1 });
  const daysFromStart = (weekday - 1 + 7) % 7;
  return addDays(start, daysFromStart);
}

function quarterRange(year: number, quarter: 1 | 2 | 3 | 4): { start: string; end: string } {
  const start = new Date(year, (quarter - 1) * 3, 1);
  return { start: ymd(start), end: ymd(endOfQuarter(start)) };
}

function quarterLatePart(
  year: number,
  quarter: 1 | 2 | 3 | 4,
): { start: string; end: string } {
  const lastMonth = quarter * 3;
  const lastMonthStart = new Date(year, lastMonth - 1, 1);
  const lastDay = endOfMonth(lastMonthStart).getDate();
  return {
    start: ymd(new Date(year, lastMonth - 1, 21)),
    end: ymd(new Date(year, lastMonth - 1, lastDay)),
  };
}

function currentQuarter(ref: Date): 1 | 2 | 3 | 4 {
  return (Math.floor(ref.getMonth() / 3) + 1) as 1 | 2 | 3 | 4;
}

function halfRange(
  year: number,
  half: 1 | 2,
): { start: string; end: string } {
  const startMonth = half === 1 ? 0 : 6;
  const start = new Date(year, startMonth, 1);
  const end = endOfMonth(new Date(year, startMonth + 5, 1));
  return { start: ymd(start), end: ymd(end) };
}

function mostRecentPastHalfRange(
  ref: Date,
  half: 1 | 2,
): { start: string; end: string } {
  const year = ref.getFullYear();
  const month = ref.getMonth() + 1;
  if (half === 1) {
    return halfRange(month > 6 ? year : year - 1, 1);
  }
  return halfRange(year - 1, 2);
}

function monthOnlyPast(month: number, ref: Date): { start: string; end: string } {
  let year = ref.getFullYear();
  const candidate = new Date(year, month - 1, 1);
  if (candidate > ref) year -= 1;
  return monthRange(year, month);
}

function monthDayPast(month: number, day: number, ref: Date): string {
  let year = ref.getFullYear();
  const candidate = new Date(year, month - 1, day);
  if (candidate > ref) year -= 1;
  return ymd(new Date(year, month - 1, day));
}

function quarterRangeCurrentYear(
  ref: Date,
  quarter: 1 | 2 | 3 | 4,
): { start: string; end: string } {
  return quarterRange(ref.getFullYear(), quarter);
}

function durationRange(
  ref: Date,
  unit: "day" | "week" | "month" | "year",
  amount: number,
): { start: string; end: string } {
  let start: Date;
  switch (unit) {
    case "day":
      start = addDays(ref, -amount);
      break;
    case "week":
      start = addWeeks(ref, -amount);
      break;
    case "month":
      start = addMonths(ref, -amount);
      break;
    case "year":
      start = addYears(ref, -amount);
      break;
  }
  return { start: ymd(start), end: ymd(ref) };
}

function holidayDatesInRange(startIso: string, endIso: string): string[] {
  const out: string[] = [];
  const startYear = Number(startIso.slice(0, 4));
  const endYear = Number(endIso.slice(0, 4));
  for (let year = startYear; year <= endYear; year++) {
    const yearDates = Object.keys(HOLIDAY_DATA[String(year)] ?? {});
    for (const date of yearDates) {
      if (date >= startIso && date <= endIso) out.push(date);
    }
  }
  return out.sort();
}

function isWeekend(date: Date): boolean {
  const day = date.getDay();
  return day === 0 || day === 6;
}

function weekdaysInRange(startIso: string, endIso: string): string[] {
  return eachDayOfInterval({ start: parseYmd(startIso), end: parseYmd(endIso) })
    .filter((d) => {
      const day = d.getDay();
      return day >= 1 && day <= 5;
    })
    .map((d) => ymd(d));
}

function businessDaysInRange(startIso: string, endIso: string): string[] {
  const holidays = new Set(holidayDatesInRange(startIso, endIso));
  return eachDayOfInterval({ start: parseYmd(startIso), end: parseYmd(endIso) })
    .filter((d) => !isWeekend(d) && !holidays.has(ymd(d)))
    .map((d) => ymd(d));
}

function lunarToSolarIso(year: number, month: number, day: number): string {
  const cal = new KoreanLunarCalendar();
  cal.setLunarDate(year, month, day, false);
  const solar = cal.getSolarCalendar();
  return `${solar.year}-${pad(solar.month)}-${pad(solar.day)}`;
}

function namedHoliday(word: string, ref: Date): string {
  const year = ref.getFullYear();
  switch (word) {
    case "설날":
    case "구정":
    case "음력 1월 1일":
      return lunarToSolarIso(year, 1, 1);
    case "추석":
    case "한가위":
      return lunarToSolarIso(year, 8, 15);
    case "정월 대보름":
      return lunarToSolarIso(year, 1, 15);
    case "부처님오신날":
      return lunarToSolarIso(year, 4, 8);
    case "어린이날":
      return `${year}-05-05`;
    case "크리스마스":
      return `${year}-12-25`;
    case "삼일절":
      return `${year}-03-01`;
    case "광복절":
      return `${year}-08-15`;
    case "현충일":
      return `${year}-06-06`;
    case "한글날":
      return `${year}-10-09`;
    default:
      throw new Error(`Unsupported holiday word: ${word}`);
  }
}

function isoDateTime(
  date: Date,
  hour: number,
  minute: number,
  second: number,
): string {
  return `${ymd(date)}T${pad(hour)}:${pad(minute)}:${pad(second)}+09:00`;
}

function pointDateTime(
  date: Date,
  hour: number,
  minute = 0,
): { start: string; end: string } {
  const iso = isoDateTime(date, hour, minute, 0);
  return { start: iso, end: iso };
}

function rangedDateTime(
  date: Date,
  startHour: number,
  startMinute: number,
  endHour: number,
  endMinute: number,
  endSecond = 0,
): { start: string; end: string } {
  return {
    start: isoDateTime(date, startHour, startMinute, 0),
    end: isoDateTime(date, endHour, endMinute, endSecond),
  };
}

function periodDateTime(
  date: Date,
  period: "morning" | "evening",
): { start: string; end: string } {
  if (period === "morning") return rangedDateTime(date, 6, 0, 12, 0);
  return rangedDateTime(date, 18, 0, 21, 0);
}

function singleExpression(value: string): ExpectedCase {
  return { hasDate: true, expressions: [{ single: value }] };
}

function rangeExpression(start: string, end: string): ExpectedCase {
  return { hasDate: true, expressions: [{ range: { start, end } }] };
}

function rangeExpressions(
  values: Array<{ start: string; end: string }>,
): ExpectedCase {
  return {
    hasDate: true,
    expressions: values.map((value) => ({ range: value })),
  };
}

function datetimeExpression(value: { start: string; end: string }): ExpectedCase {
  return { hasDate: true, expressions: [{ datetime: value }] };
}

function rangeValueExpression(
  value: string | { start: string; end: string },
): ExpectedCase {
  return { hasDate: true, expressions: [{ range: value }] };
}

function businessDaysExpression(values: string[]): ExpectedCase {
  return { hasDate: true, expressions: [{ business_days: values }] };
}

function weekdaysExpression(values: string[]): ExpectedCase {
  return { hasDate: true, expressions: [{ weekdays: values }] };
}

function holidaysExpression(values: string[]): ExpectedCase {
  return { hasDate: true, expressions: [{ holidays: values }] };
}

function noDateCase(): ExpectedCase {
  return { hasDate: false, expressions: [] };
}

const defaultTemplates: CaseTemplate[] = [];

defaultTemplates.push(
  {
    key: "absolute_iso",
    suite: "default",
    category: "A.absolute",
    build: () => ({
      text: "2025-12-25",
      outputModes: ["single"],
      expected: singleExpression("2025-12-25"),
    }),
  },
  {
    key: "absolute_slash",
    suite: "default",
    category: "A.absolute",
    build: () => ({
      text: "2025/12/25",
      outputModes: ["single"],
      expected: singleExpression("2025-12-25"),
    }),
  },
  {
    key: "absolute_dot",
    suite: "default",
    category: "A.absolute",
    build: () => ({
      text: "2025.12.25",
      outputModes: ["single"],
      expected: singleExpression("2025-12-25"),
    }),
  },
  {
    key: "absolute_korean_full",
    suite: "default",
    category: "A.absolute",
    build: () => ({
      text: "2025년 3월 1일",
      outputModes: ["single"],
      expected: singleExpression("2025-03-01"),
    }),
  },
  {
    key: "absolute_year_only",
    suite: "default",
    category: "A.absolute",
    build: () => ({
      text: "2025년",
      outputModes: ["range"],
      expected: rangeExpression("2025-01-01", "2025-12-31"),
    }),
  },
  {
    key: "absolute_month_only",
    suite: "default",
    category: "A.absolute",
    build: (ref) => ({
      text: "3월",
      outputModes: ["range"],
      expected: rangeExpressions([monthOnlyPast(3, ref)]),
    }),
  },
  {
    key: "absolute_month_day",
    suite: "default",
    category: "A.absolute",
    build: (ref) => ({
      text: "3월 1일",
      outputModes: ["single"],
      expected: singleExpression(monthDayPast(3, 1, ref)),
    }),
  },
  {
    key: "absolute_month_day_dec25",
    suite: "default",
    category: "A.absolute",
    build: (ref) => ({
      text: "12월 25일",
      outputModes: ["single"],
      expected: singleExpression(monthDayPast(12, 25, ref)),
    }),
  },
  {
    key: "absolute_compact_ymd",
    suite: "default",
    category: "A.absolute",
    build: () => ({
      text: "20250412",
      outputModes: ["single"],
      expected: singleExpression("2025-04-12"),
    }),
  },
  {
    key: "absolute_compact_mmdd",
    suite: "default",
    category: "A.absolute",
    build: (ref) => ({
      text: "0412",
      outputModes: ["single"],
      expected: singleExpression(monthDayPast(4, 12, ref)),
    }),
  },
  {
    key: "absolute_english_month_date",
    suite: "default",
    category: "A.absolute",
    build: () => ({
      text: "March 15, 2025",
      outputModes: ["single"],
      expected: singleExpression("2025-03-15"),
    }),
  },
  {
    key: "absolute_us_slash_date",
    suite: "default",
    category: "A.absolute",
    build: () => ({
      text: "3/15/2025",
      outputModes: ["single"],
      expected: singleExpression("2025-03-15"),
    }),
  },
);

for (const [key, text, delta] of [
  ["relative_last_year", "작년", -1],
  ["relative_this_year", "올해", 0],
  ["relative_next_year", "내년", 1],
  ["relative_year_before_last", "재작년", -2],
] as const) {
  defaultTemplates.push({
    key,
    suite: "default",
    category: "B.year_month",
    build: (ref) => ({
      text,
      outputModes: ["range"],
      expected: rangeExpression(
        yearRange(ref.getFullYear() + delta).start,
        yearRange(ref.getFullYear() + delta).end,
      ),
    }),
  });
}

for (const [key, text, offset] of [
  ["relative_this_month", "이번달", 0],
  ["relative_last_month", "지난달", -1],
  ["relative_prev_month", "저번달", -1],
  ["relative_next_month", "다음달", 1],
  ["relative_two_months_ago", "지지난달", -2],
  ["relative_two_months_later", "다다음 달", 2],
] as const) {
  defaultTemplates.push({
    key,
    suite: "default",
    category: "B.year_month",
    build: (ref) => {
      const resolved = monthOffsetRange(ref, offset);
      return {
        text,
        outputModes: ["range"],
        expected: rangeExpression(resolved.start, resolved.end),
      };
    },
  });
}

for (const [key, text, offset] of [
  ["week_last", "지난주", -1],
  ["week_this", "이번주", 0],
  ["week_next", "다음주", 1],
  ["week_prev_prev", "지지난주", -2],
  ["week_next_next", "다다음 주", 2],
] as const) {
  defaultTemplates.push({
    key,
    suite: "default",
    category: "C.week",
    build: (ref) => {
      const resolved = weekOffsetRange(ref, offset);
      return {
        text,
        outputModes: ["range"],
        expected: rangeExpression(resolved.start, resolved.end),
      };
    },
  });
}

for (const [key, text, weekOffset, weekday] of [
  ["weekday_this_monday", "이번 주 월요일", 0, 1],
  ["weekday_this_friday", "이번 주 금요일", 0, 5],
  ["weekday_next_monday", "다음주 월요일", 1, 1],
  ["weekday_last_wednesday", "지난주 수요일", -1, 3],
  ["weekday_next_sunday", "다음주 일요일", 1, 0],
] as const) {
  defaultTemplates.push({
    key,
    suite: "default",
    category: "C.week",
    build: (ref) => ({
      text,
      outputModes: ["single"],
      expected: singleExpression(
        ymd(nthWeekdayInOffsetWeek(ref, weekOffset, weekday === 0 ? 7 : weekday)),
      ),
    }),
  });
}

for (const entry of [
  { key: "relative_7_days_ago", text: "7일 전", value: (ref: Date) => addDays(ref, -7) },
  { key: "relative_3_days_later", text: "3일 뒤", value: (ref: Date) => addDays(ref, 3) },
  { key: "relative_2_weeks_ago", text: "2주 전", value: (ref: Date) => addDays(ref, -14) },
  { key: "relative_2_weeks_later", text: "2주 뒤", value: (ref: Date) => addDays(ref, 14) },
  { key: "relative_1_month_ago", text: "1개월 전", value: (ref: Date) => addMonths(ref, -1) },
  { key: "relative_2_months_later", text: "2개월 뒤", value: (ref: Date) => addMonths(ref, 2) },
  { key: "relative_1_year_ago", text: "1년 전", value: (ref: Date) => addYears(ref, -1) },
  { key: "relative_10_years_ago", text: "10년 전", value: (ref: Date) => addYears(ref, -10) },
  { key: "relative_100_days_later", text: "100일 뒤", value: (ref: Date) => addDays(ref, 100) },
  { key: "relative_30_days_ago", text: "30일 전", value: (ref: Date) => addDays(ref, -30) },
]) {
  defaultTemplates.push({
    key: entry.key,
    suite: "default",
    category: "D.relative_numeric",
    build: (ref) => ({
      text: entry.text,
      outputModes: ["single"],
      expected: singleExpression(ymd(entry.value(ref))),
    }),
  });
}

for (const [key, text, offset] of [
  ["numeral_one_day_ago", "하루 전", -1],
  ["numeral_two_days_ago", "이틀 전", -2],
  ["numeral_three_days_ago", "사흘 전", -3],
  ["numeral_four_days_later", "나흘 뒤", 4],
  ["numeral_five_days_later", "닷새 뒤", 5],
  ["numeral_six_days_later", "엿새 뒤", 6],
  ["numeral_seven_days_later", "이레 뒤", 7],
  ["numeral_eight_days_later", "여드레 뒤", 8],
  ["numeral_ten_days_later", "열흘 뒤", 10],
  ["numeral_fifteen_days_ago", "보름 전", -15],
] as const) {
  defaultTemplates.push({
    key,
    suite: "default",
    category: "E.korean_numeral",
    build: (ref) => ({
      text,
      outputModes: ["single"],
      expected: singleExpression(ymd(addDays(ref, offset))),
    }),
  });
}

for (const [key, text, offset] of [
  ["named_today", "오늘", 0],
  ["named_yesterday", "어제", -1],
  ["named_tomorrow", "내일", 1],
  ["named_day_after_tomorrow", "모레", 2],
  ["named_three_days_later", "글피", 3],
  ["named_four_days_later", "그글피", 4],
  ["named_two_days_ago", "그저께", -2],
  ["named_two_days_ago_alt", "엊그제", -2],
  ["named_english_yesterday", "yesterday", -1],
  ["named_english_tomorrow", "tomorrow", 1],
  ["named_english_day_after_tomorrow", "day after tomorrow", 2],
  ["named_english_day_before_yesterday", "day before yesterday", -2],
] as const) {
  defaultTemplates.push({
    key,
    suite: "default",
    category: "F.named",
    build: (ref) => ({
      text,
      outputModes: ["single"],
      expected: singleExpression(ymd(addDays(ref, offset))),
    }),
  });
}

for (const template of [
  {
    key: "filter_last_month_business_days",
    text: "저번달 영업일",
    mode: "business_days" as OutputMode,
    values: (ref: Date) => {
      const r = monthOffsetRange(ref, -1);
      return businessDaysInRange(r.start, r.end);
    },
  },
  {
    key: "filter_this_month_weekdays",
    text: "이번 달 평일",
    mode: "weekdays" as OutputMode,
    values: (ref: Date) => {
      const r = monthOffsetRange(ref, 0);
      return weekdaysInRange(r.start, r.end);
    },
  },
  {
    key: "filter_last_year_holidays",
    text: "작년 공휴일",
    mode: "holidays" as OutputMode,
    values: (ref: Date) => {
      const r = yearRange(ref.getFullYear() - 1);
      return holidayDatesInRange(r.start, r.end);
    },
  },
  {
    key: "filter_this_year_holidays",
    text: "올해 공휴일",
    mode: "holidays" as OutputMode,
    values: (ref: Date) => {
      const r = yearRange(ref.getFullYear());
      return holidayDatesInRange(r.start, r.end);
    },
  },
  {
    key: "filter_next_month_holidays",
    text: "다음달 공휴일",
    mode: "holidays" as OutputMode,
    values: (ref: Date) => {
      const r = monthOffsetRange(ref, 1);
      return holidayDatesInRange(r.start, r.end);
    },
  },
  {
    key: "filter_this_month_holidays",
    text: "이번달 공휴일",
    mode: "holidays" as OutputMode,
    values: (ref: Date) => {
      const r = monthOffsetRange(ref, 0);
      return holidayDatesInRange(r.start, r.end);
    },
  },
  {
    key: "filter_this_week_business_days",
    text: "이번 주 영업일",
    mode: "business_days" as OutputMode,
    values: (ref: Date) => {
      const r = weekOffsetRange(ref, 0);
      return businessDaysInRange(r.start, r.end);
    },
  },
  {
    key: "filter_next_week_business_days",
    text: "다음주 영업일",
    mode: "business_days" as OutputMode,
    values: (ref: Date) => {
      const r = weekOffsetRange(ref, 1);
      return businessDaysInRange(r.start, r.end);
    },
  },
  {
    key: "filter_next_month_business_days_en",
    text: "next month business days",
    mode: "business_days" as OutputMode,
    values: (ref: Date) => {
      const r = monthOffsetRange(ref, 1);
      return businessDaysInRange(r.start, r.end);
    },
  },
  {
    key: "filter_this_week_weekdays",
    text: "이번 주 평일",
    mode: "weekdays" as OutputMode,
    values: (ref: Date) => {
      const r = weekOffsetRange(ref, 0);
      return weekdaysInRange(r.start, r.end);
    },
  },
  {
    key: "filter_next_month_weekdays",
    text: "다음달 평일",
    mode: "weekdays" as OutputMode,
    values: (ref: Date) => {
      const r = monthOffsetRange(ref, 1);
      return weekdaysInRange(r.start, r.end);
    },
  },
  {
    key: "filter_last_month_weekdays",
    text: "지난달 평일",
    mode: "weekdays" as OutputMode,
    values: (ref: Date) => {
      const r = monthOffsetRange(ref, -1);
      return weekdaysInRange(r.start, r.end);
    },
  },
]) {
  defaultTemplates.push({
    key: template.key,
    suite: "default",
    category: "G.filters",
    build: (ref) => {
      const values = template.values(ref);
      const expected =
        template.mode === "business_days"
          ? businessDaysExpression(values)
          : template.mode === "weekdays"
            ? weekdaysExpression(values)
            : holidaysExpression(values);
      return {
        text: template.text,
        outputModes: [template.mode],
        expected,
      };
    },
  });
}

for (const template of [
  {
    key: "quarter_q1",
    text: "1분기",
    expected: (ref: Date) => quarterRangeCurrentYear(ref, 1),
  },
  {
    key: "quarter_q2",
    text: "2분기",
    expected: (ref: Date) => quarterRangeCurrentYear(ref, 2),
  },
  {
    key: "quarter_last_year_q4",
    text: "작년 4분기",
    expected: (ref: Date) => quarterRange(ref.getFullYear() - 1, 4),
  },
  {
    key: "half_first_most_recent_past",
    text: "상반기",
    expected: (ref: Date) => halfRange(ref.getFullYear(), 1),
  },
  {
    key: "half_second_most_recent_past",
    text: "하반기",
    expected: (ref: Date) => halfRange(ref.getFullYear(), 2),
  },
  {
    key: "half_last_year_first",
    text: "작년 상반기",
    expected: (ref: Date) => halfRange(ref.getFullYear() - 1, 1),
  },
  {
    key: "quarter_next_year_q1",
    text: "내년 1분기",
    expected: (ref: Date) => quarterRange(ref.getFullYear() + 1, 1),
  },
  {
    key: "quarter_this_year_q1",
    text: "올해 1분기",
    expected: (ref: Date) => quarterRange(ref.getFullYear(), 1),
  },
  {
    key: "quarter_q4",
    text: "4분기",
    expected: (ref: Date) => quarterRange(ref.getFullYear(), 4),
  },
  {
    key: "half_this_year_first",
    text: "올해 상반기",
    expected: (ref: Date) => halfRange(ref.getFullYear(), 1),
  },
  {
    key: "quarter_english_q2_2025",
    text: "Q2 2025",
    expected: () => quarterRange(2025, 2),
  },
  {
    key: "half_english_first_half_2024",
    text: "first half of 2024",
    expected: () => halfRange(2024, 1),
  },
]) {
  defaultTemplates.push({
    key: template.key,
    suite: "default",
    category: "H.quarter_half",
    build: (ref) => {
      const resolved = template.expected(ref);
      return {
        text: template.text,
        outputModes: ["range"],
        expected: rangeExpression(resolved.start, resolved.end),
      };
    },
  });
}

for (const [key, text] of [
  ["holiday_seollal", "설날"],
  ["holiday_chuseok", "추석"],
  ["holiday_children_day", "어린이날"],
  ["holiday_christmas", "크리스마스"],
  ["holiday_samiljeol", "삼일절"],
  ["holiday_liberation_day", "광복절"],
  ["holiday_memorial_day", "현충일"],
  ["holiday_hangeul_day", "한글날"],
  ["holiday_lunar_new_year", "음력 1월 1일"],
  ["holiday_daeboreum", "정월 대보름"],
  ["holiday_buddha_birthday", "부처님오신날"],
  ["holiday_hangawee", "한가위"],
] as const) {
  defaultTemplates.push({
    key,
    suite: "default",
    category: "I.holidays",
    build: (ref) => ({
      text,
      outputModes: ["single"],
      expected: singleExpression(namedHoliday(text, ref)),
    }),
  });
}

defaultTemplates.push(
  {
    key: "edge_no_date",
    suite: "default",
    category: "J.edge",
    build: () => ({
      text: "안녕하세요",
      outputModes: ["single"],
      expected: noDateCase(),
    }),
  },
  {
    key: "edge_today_false_positive",
    suite: "default",
    category: "J.edge",
    build: (ref) => ({
      text: "오늘의 운세 말고 다른 거",
      outputModes: ["single"],
      expected: singleExpression(ymd(ref)),
    }),
  },
  {
    key: "edge_past_30_days",
    suite: "default",
    category: "J.edge",
    build: (ref) => {
      const resolved = durationRange(ref, "day", 30);
      return {
        text: "past 30 days",
        outputModes: ["range"],
        expected: rangeExpression(resolved.start, resolved.end),
      };
    },
  },
  {
    key: "edge_recent_7_days",
    suite: "default",
    category: "J.edge",
    build: (ref) => {
      const resolved = durationRange(ref, "day", 7);
      return {
        text: "최근 7일",
        outputModes: ["range"],
        expected: rangeExpression(resolved.start, resolved.end),
      };
    },
  },
  {
    key: "edge_past_2_weeks",
    suite: "default",
    category: "J.edge",
    build: (ref) => {
      const resolved = durationRange(ref, "week", 2);
      return {
        text: "지난 2주",
        outputModes: ["range"],
        expected: rangeExpression(resolved.start, resolved.end),
      };
    },
  },
  {
    key: "edge_multi_months",
    suite: "default",
    category: "J.edge",
    build: (ref) => ({
      text: "3월 4월 잔액",
      outputModes: ["range"],
      expected: rangeExpressions([monthOnlyPast(3, ref), monthOnlyPast(4, ref)]),
    }),
  },
  {
    key: "edge_multi_months_comma",
    suite: "default",
    category: "J.edge",
    build: (ref) => ({
      text: "2,3,4월 실적",
      outputModes: ["range"],
      expected: rangeExpressions([
        monthOnlyPast(2, ref),
        monthOnlyPast(3, ref),
        monthOnlyPast(4, ref),
      ]),
    }),
  },
  {
    key: "edge_multi_quarters",
    suite: "default",
    category: "J.edge",
    build: (ref) => ({
      text: "올해 1,2분기",
      outputModes: ["range"],
      expected: rangeExpressions([
        quarterRange(ref.getFullYear(), 1),
        quarterRange(ref.getFullYear(), 2),
      ]),
    }),
  },
  {
    key: "edge_fixed_multi_quarters",
    suite: "default",
    category: "J.edge",
    build: () => ({
      text: "2025년 3,4분기",
      outputModes: ["range"],
      expected: rangeExpressions([quarterRange(2025, 3), quarterRange(2025, 4)]),
    }),
  },
  {
    key: "edge_last_year_multi_months",
    suite: "default",
    category: "J.edge",
    build: (ref) => ({
      text: "작년 2,3,4월 실적",
      outputModes: ["range"],
      expected: rangeExpressions([
        monthRange(ref.getFullYear() - 1, 2),
        monthRange(ref.getFullYear() - 1, 3),
        monthRange(ref.getFullYear() - 1, 4),
      ]),
    }),
  },
  {
    key: "edge_fixed_year_multi_months",
    suite: "default",
    category: "J.edge",
    build: () => ({
      text: "2025년 2,3월 실적",
      outputModes: ["range"],
      expected: rangeExpressions([monthRange(2025, 2), monthRange(2025, 3)]),
    }),
  },
  {
    key: "edge_explicit_range",
    suite: "default",
    category: "J.edge",
    build: (ref) => ({
      text: "3월 1일부터 5월 31일까지",
      outputModes: ["range"],
      expected: rangeExpression(
        `${ref.getFullYear()}-03-01`,
        `${ref.getFullYear()}-05-31`,
      ),
    }),
  },
  {
    key: "edge_month_end",
    suite: "default",
    category: "J.edge",
    build: (ref) => ({
      text: "월말",
      outputModes: ["single"],
      expected: singleExpression(ymd(endOfMonth(ref))),
    }),
  },
  {
    key: "edge_year_end",
    suite: "default",
    category: "J.edge",
    build: (ref) => ({
      text: "연말",
      outputModes: ["single"],
      expected: singleExpression(`${ref.getFullYear()}-12-31`),
    }),
  },
  {
    key: "edge_month_start",
    suite: "default",
    category: "J.edge",
    build: (ref) => ({
      text: "월초",
      outputModes: ["single"],
      expected: singleExpression(ymd(startOfMonth(ref))),
    }),
  },
  {
    key: "edge_year_start",
    suite: "default",
    category: "J.edge",
    build: (ref) => ({
      text: "연초",
      outputModes: ["single"],
      expected: singleExpression(`${ref.getFullYear()}-01-01`),
    }),
  },
  {
    key: "edge_this_month_early",
    suite: "default",
    category: "J.edge",
    build: (ref) => ({
      text: "이번달 초",
      outputModes: ["range"],
      expected: rangeExpression(
        `${ref.getFullYear()}-${pad(ref.getMonth() + 1)}-01`,
        `${ref.getFullYear()}-${pad(ref.getMonth() + 1)}-10`,
      ),
    }),
  },
  {
    key: "edge_this_year_late",
    suite: "default",
    category: "J.edge",
    build: (ref) => ({
      text: "올해 말",
      outputModes: ["range"],
      expected: rangeExpression(
        `${ref.getFullYear()}-10-01`,
        `${ref.getFullYear()}-12-31`,
      ),
    }),
  },
  {
    key: "edge_this_quarter_late",
    suite: "default",
    category: "J.edge",
    build: (ref) => {
      const resolved = quarterLatePart(ref.getFullYear(), currentQuarter(ref));
      return {
        text: "이번 분기 말",
        outputModes: ["range"],
        expected: rangeExpression(resolved.start, resolved.end),
      };
    },
  },
  {
    key: "edge_recent_3_months",
    suite: "default",
    category: "J.edge",
    build: (ref) => {
      const resolved = durationRange(ref, "month", 3);
      return {
        text: "최근 3개월",
        outputModes: ["range"],
        expected: rangeExpression(resolved.start, resolved.end),
      };
    },
  },
);

const timePointTemplates: Array<{
  key: string;
  text: string;
  date: (ref: Date) => Date;
  mode?: "datetime" | "range";
  dateOnlyForDateModes?: boolean;
  time: (base: Date) => { start: string; end: string } | string | { start: string; end: string };
}> = [
  {
    key: "time_ko_pm3",
    text: "오후 3시에 만나",
    date: (ref) => ref,
    mode: "datetime",
    time: (base) => pointDateTime(base, 15),
  },
  {
    key: "time_ko_am930",
    text: "오전 9시 30분 회의",
    date: (ref) => ref,
    mode: "datetime",
    time: (base) => pointDateTime(base, 9, 30),
  },
  {
    key: "time_ko_half_past_three",
    text: "3시 반에 가자",
    date: (ref) => ref,
    mode: "datetime",
    time: (base) => pointDateTime(base, 3, 30),
  },
  {
    key: "time_24h_1530",
    text: "15:30 시작",
    date: (ref) => ref,
    mode: "datetime",
    time: (base) => pointDateTime(base, 15, 30),
  },
  {
    key: "time_dawn_two",
    text: "새벽 2시",
    date: (ref) => ref,
    mode: "datetime",
    time: (base) => pointDateTime(base, 2),
  },
  {
    key: "time_evening_period",
    text: "저녁에 전화해",
    date: (ref) => ref,
    mode: "datetime",
    time: (base) => periodDateTime(base, "evening"),
  },
  {
    key: "time_ko_range",
    text: "오전 9시부터 11시까지",
    date: (ref) => ref,
    mode: "datetime",
    time: (base) => rangedDateTime(base, 9, 0, 11, 0),
  },
  {
    key: "time_tomorrow_pm3",
    text: "내일 오후 3시 회의",
    date: (ref) => addDays(ref, 1),
    mode: "datetime",
    time: (base) => pointDateTime(base, 15),
  },
  {
    key: "time_next_monday_am10",
    text: "다음주 월요일 오전 10시",
    date: (ref) => nthWeekdayInOffsetWeek(ref, 1, 1),
    mode: "datetime",
    time: (base) => pointDateTime(base, 10),
  },
  {
    key: "time_today_evening",
    text: "오늘 저녁에 만나자",
    date: (ref) => ref,
    mode: "datetime",
    time: (base) => periodDateTime(base, "evening"),
  },
  {
    key: "time_en_3pm",
    text: "meeting at 3pm",
    date: (ref) => ref,
    mode: "datetime",
    time: (base) => pointDateTime(base, 15),
  },
  {
    key: "time_en_am930",
    text: "call at 9:30 AM",
    date: (ref) => ref,
    mode: "datetime",
    time: (base) => pointDateTime(base, 9, 30),
  },
  {
    key: "time_en_noon",
    text: "noon meeting",
    date: (ref) => ref,
    mode: "datetime",
    time: (base) => pointDateTime(base, 12),
  },
  {
    key: "time_en_range",
    text: "from 9am to 5pm",
    date: (ref) => ref,
    mode: "datetime",
    time: (base) => rangedDateTime(base, 9, 0, 17, 0),
  },
  {
    key: "time_en_half_past_three",
    text: "half past 3",
    date: (ref) => ref,
    mode: "datetime",
    time: (base) => pointDateTime(base, 3, 30),
  },
  {
    key: "time_tomorrow_morning",
    text: "tomorrow morning",
    date: (ref) => addDays(ref, 1),
    mode: "datetime",
    time: (base) => periodDateTime(base, "morning"),
  },
  {
    key: "time_next_friday_5pm",
    text: "next Friday 5pm",
    date: (ref) => nthWeekdayInOffsetWeek(ref, 1, 5),
    mode: "datetime",
    time: (base) => pointDateTime(base, 17),
  },
  {
    key: "time_range_opt_in",
    text: "내일 오후 3시",
    date: (ref) => addDays(ref, 1),
    mode: "range",
    dateOnlyForDateModes: false,
    time: (base) => pointDateTime(base, 15),
  },
  {
    key: "time_range_backcompat",
    text: "내일 오후 3시",
    date: (ref) => addDays(ref, 1),
    mode: "range",
    time: (base) => dayRange(base),
  },
];

for (const template of timePointTemplates) {
  defaultTemplates.push({
    key: template.key,
    suite: "default",
    category: "K.time",
    build: (ref) => {
      const base = template.date(ref);
      if (template.mode === "range") {
        return {
          text: template.text,
          outputModes: ["range"],
          dateOnlyForDateModes: template.dateOnlyForDateModes,
          expected: rangeValueExpression(template.time(base) as string | { start: string; end: string }),
        };
      }
      return {
        text: template.text,
        outputModes: ["datetime"],
        expected: datetimeExpression(template.time(base) as { start: string; end: string }),
      };
    },
  });
}

const forceLLMTemplates: CaseTemplate[] = [
  {
    key: "llm_last_month_sales",
    suite: "force_llm",
    category: "LLM.forced",
    build: (ref) => {
      const resolved = monthOffsetRange(ref, -1);
      return {
        text: "last month sales",
        outputModes: ["range"],
        forceLLM: true,
        expected: rangeExpression(resolved.start, resolved.end),
      };
    },
  },
  {
    key: "llm_yesterday_balance",
    suite: "force_llm",
    category: "LLM.forced",
    build: (ref) => ({
      text: "what was the balance yesterday",
      outputModes: ["single"],
      forceLLM: true,
      expected: singleExpression(ymd(addDays(ref, -1))),
    }),
  },
  {
    key: "llm_q2_2025",
    suite: "force_llm",
    category: "LLM.forced",
    build: () => ({
      text: "Q2 2025 revenue",
      outputModes: ["range"],
      forceLLM: true,
      expected: rangeExpression("2025-04-01", "2025-06-30"),
    }),
  },
  {
    key: "llm_march_15_2025",
    suite: "force_llm",
    category: "LLM.forced",
    build: () => ({
      text: "March 15, 2025 meeting",
      outputModes: ["single"],
      forceLLM: true,
      expected: singleExpression("2025-03-15"),
    }),
  },
  {
    key: "llm_past_30_days_sales",
    suite: "force_llm",
    category: "LLM.forced",
    build: (ref) => {
      const resolved = durationRange(ref, "day", 30);
      return {
        text: "past 30 days sales",
        outputModes: ["range"],
        forceLLM: true,
        expected: rangeExpression(resolved.start, resolved.end),
      };
    },
  },
  {
    key: "llm_meeting_3pm",
    suite: "force_llm",
    category: "LLM.forced",
    build: (ref) => ({
      text: "meeting at 3pm",
      outputModes: ["datetime"],
      forceLLM: true,
      expected: datetimeExpression(pointDateTime(ref, 15)),
    }),
  },
  {
    key: "llm_tomorrow_morning",
    suite: "force_llm",
    category: "LLM.forced",
    build: (ref) => ({
      text: "tomorrow morning",
      outputModes: ["datetime"],
      forceLLM: true,
      expected: datetimeExpression(periodDateTime(addDays(ref, 1), "morning")),
    }),
  },
  {
    key: "llm_next_friday_5pm",
    suite: "force_llm",
    category: "LLM.forced",
    build: (ref) => ({
      text: "next Friday 5pm",
      outputModes: ["datetime"],
      forceLLM: true,
      expected: datetimeExpression(pointDateTime(nthWeekdayInOffsetWeek(ref, 1, 5), 17)),
    }),
  },
  {
    key: "llm_multi_months",
    suite: "force_llm",
    category: "LLM.forced",
    build: (ref) => ({
      text: "3월 4월 잔액 알려줘",
      outputModes: ["range"],
      forceLLM: true,
      expected: rangeExpressions([monthOnlyPast(3, ref), monthOnlyPast(4, ref)]),
    }),
  },
  {
    key: "llm_three_days_ago",
    suite: "force_llm",
    category: "LLM.forced",
    build: (ref) => ({
      text: "사흘 전 날씨",
      outputModes: ["single"],
      forceLLM: true,
      expected: singleExpression(ymd(addDays(ref, -3))),
    }),
  },
];

function buildDataset(suiteFilter: SuiteName | "all"): EvalCase[] {
  const templates = [
    ...(suiteFilter === "force_llm" ? [] : defaultTemplates),
    ...(suiteFilter === "default" ? [] : forceLLMTemplates),
  ];
  const out: EvalCase[] = [];

  for (const template of templates) {
    for (const refIso of REF_DATES) {
      const ref = parseYmd(refIso);
      out.push({
        id: `${template.suite}:${template.key}:${refIso}`,
        suite: template.suite,
        category: template.category,
        referenceDate: refIso,
        timezone: "Asia/Seoul",
        ...template.build(ref),
      });
    }
  }

  return out;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a.localeCompare(b),
  );
  return `{${entries
    .map(([key, v]) => `${JSON.stringify(key)}:${stableStringify(v)}`)
    .join(",")}}`;
}

function valuesEqual(a: unknown, b: unknown): boolean {
  return stableStringify(a) === stableStringify(b);
}

function compareCase(testCase: EvalCase, actual: ExtractResponse): CaseResult {
  const issues: string[] = [];

  if (actual.hasDate !== testCase.expected.hasDate) {
    issues.push(
      `hasDate mismatch: expected=${testCase.expected.hasDate}, actual=${actual.hasDate}`,
    );
  }

  if (!testCase.expected.hasDate) {
    if (actual.expressions.length !== 0) {
      issues.push(`expected no expressions, got ${actual.expressions.length}`);
    }
    return {
      testCase,
      pass: issues.length === 0,
      issues,
      path: actual.meta.path,
      actual,
    };
  }

  if (actual.expressions.length !== testCase.expected.expressions.length) {
    issues.push(
      `expression count mismatch: expected=${testCase.expected.expressions.length}, actual=${actual.expressions.length}`,
    );
  }

  const count = Math.min(
    actual.expressions.length,
    testCase.expected.expressions.length,
  );

  for (let i = 0; i < count; i++) {
    const expectedExpr = testCase.expected.expressions[i];
    const actualExpr = actual.expressions[i];
    const actualResults = new Map(
      actualExpr.results.map((result) => [result.mode, result.value] as const),
    );

    for (const [field, expectedValue] of Object.entries(expectedExpr)) {
      const mode = field as keyof ExpectedExpression;
      const actualValue = actualResults.get(
        mode === "business_days"
          ? "business_days"
          : mode === "weekdays"
            ? "weekdays"
            : mode === "holidays"
              ? "holidays"
              : mode === "datetime"
                ? "datetime"
                : mode,
      );
      if (!valuesEqual(actualValue, expectedValue)) {
        issues.push(
          `expression[${i}] ${mode} mismatch: expected=${stableStringify(expectedValue)}, actual=${stableStringify(actualValue)}`,
        );
      }
    }
  }

  return {
    testCase,
    pass: issues.length === 0,
    issues,
    path: actual.meta.path,
    actual,
  };
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

async function evaluateCaseRuleOnly(testCase: EvalCase): Promise<CaseResult> {
  cacheClear();
  const referenceDate = parseReferenceDate(testCase.referenceDate);
  const ruleResult = runRules(testCase.text, "auto");
  const expressions: ExtractResponse["expressions"] = [];

  for (const matched of ruleResult.expressions) {
    const range = resolveExpression(matched.expression, {
      referenceDate,
      timezone: testCase.timezone,
    });

    const filter = getFilterKind(matched.expression);
    const results: ResolvedValue[] = [];
    for (const mode of testCase.outputModes) {
      const formatted = await formatRange(range, mode, filter, {
        timezone: testCase.timezone,
        dateOnlyForDateModes: testCase.dateOnlyForDateModes,
      });
      if (formatted) results.push(formatted);
    }

    expressions.push({
      text: matched.text,
      expression: matched.expression,
      results,
      confidence: ruleResult.confidence,
    });
  }

  const actual: ExtractResponse = {
    hasDate: expressions.length > 0,
    expressions,
    meta: {
      referenceDate: testCase.referenceDate,
      timezone: testCase.timezone,
      model: "rules",
      path: "rule",
      latencyMs: 0,
      ruleConfidence: ruleResult.confidence,
    },
  };

  const compared = compareCase(testCase, actual);
  return {
    ...compared,
    path:
      expressions.length === 0
        ? "rule_only:no_match"
        : ruleResult.confidence >= 1
          ? "rule_only:full"
          : "rule_only:partial",
  };
}

async function evaluateCase(testCase: EvalCase): Promise<CaseResult> {
  if (RULE_ONLY) {
    try {
      return await evaluateCaseRuleOnly(testCase);
    } catch (error) {
      return {
        testCase,
        pass: false,
        issues: [],
        path: "error",
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  cacheClear();
  const request: ExtractRequest = {
    text: testCase.text,
    referenceDate: testCase.referenceDate,
    timezone: testCase.timezone,
    outputModes: testCase.outputModes,
    forceLLM: testCase.forceLLM,
    dateOnlyForDateModes: testCase.dateOnlyForDateModes,
  };

  try {
    const actual = await extract(request);
    return compareCase(testCase, actual);
  } catch (error) {
    return {
      testCase,
      pass: false,
      issues: [],
      path: "error",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function summarize(results: CaseResult[]) {
  const suites = Array.from(new Set(results.map((result) => result.testCase.suite)));
  const bySuite = suites.map((suite) => {
    const suiteResults = results.filter((result) => result.testCase.suite === suite);
    const passed = suiteResults.filter((result) => result.pass).length;
    const byCategory = Object.entries(
      suiteResults.reduce<Record<string, { total: number; passed: number }>>(
        (acc, result) => {
          const current = acc[result.testCase.category] ?? { total: 0, passed: 0 };
          current.total += 1;
          if (result.pass) current.passed += 1;
          acc[result.testCase.category] = current;
          return acc;
        },
        {},
      ),
    )
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([category, stats]) => ({
        category,
        total: stats.total,
        passed: stats.passed,
        accuracy: Number(((stats.passed / stats.total) * 100).toFixed(2)),
      }));
    const byPath = Object.entries(
      suiteResults.reduce<Record<string, number>>((acc, result) => {
        acc[result.path] = (acc[result.path] ?? 0) + 1;
        return acc;
      }, {}),
    )
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([pathName, count]) => ({ path: pathName, count }));

    return {
      suite,
      total: suiteResults.length,
      passed,
      accuracy: Number(((passed / suiteResults.length) * 100).toFixed(2)),
      byCategory,
      byPath,
      failures: suiteResults
        .filter((result) => !result.pass)
        .slice(0, 30)
        .map((result) => ({
          id: result.testCase.id,
          text: result.testCase.text,
          referenceDate: result.testCase.referenceDate,
          category: result.testCase.category,
          path: result.path,
          issues: result.error ? [result.error] : result.issues,
          actual:
            result.actual?.expressions.map((expr) => ({
              results: expr.results,
            })) ?? null,
          expected: result.testCase.expected,
        })),
    };
  });

  return {
    generatedAt: new Date().toISOString(),
    refDates: REF_DATES,
    total: results.length,
    suites: bySuite,
  };
}

async function main() {
  const args = new Set(process.argv.slice(2));
  const suiteFilter = args.has("--force-llm-only")
    ? "force_llm"
    : args.has("--default-only")
      ? "default"
      : "all";
  const writeOnly = args.has("--write-only");

  fs.mkdirSync(benchmarkDir, { recursive: true });
  const dataset = buildDataset(suiteFilter);
  fs.writeFileSync(datasetPath, `${JSON.stringify(dataset, null, 2)}\n`, "utf-8");

  console.log(`dataset written: ${datasetPath}`);
  console.log(`cases: ${dataset.length}`);

  if (writeOnly) return;

  if (dataset.some((testCase) => testCase.forceLLM || !testCase.expected.hasDate)) {
    await warmUp();
  }

  const results: CaseResult[] = [];
  for (let i = 0; i < dataset.length; i++) {
    const testCase = dataset[i];
    const result = await evaluateCase(testCase);
    results.push(result);
    if ((i + 1) % 100 === 0 || i === dataset.length - 1) {
      console.log(`evaluated ${i + 1}/${dataset.length}`);
    }
  }

  const report = summarize(results);
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf-8");

  console.log(`report written: ${reportPath}`);
  for (const suite of report.suites) {
    console.log(
      `\n[${suite.suite}] ${suite.passed}/${suite.total} (${suite.accuracy.toFixed(2)}%)`,
    );
    for (const category of suite.byCategory) {
      console.log(
        `  ${category.category.padEnd(18)} ${category.passed}/${category.total} (${category.accuracy.toFixed(2)}%)`,
      );
    }
    console.log("  path breakdown:");
    for (const pathEntry of suite.byPath) {
      console.log(`    ${pathEntry.path.padEnd(12)} ${pathEntry.count}`);
    }
    if (suite.failures.length > 0) {
      console.log("  sample failures:");
      for (const failure of suite.failures.slice(0, 10)) {
        console.log(
          `    - ${failure.id} :: ${failure.text} @ ${failure.referenceDate} [${failure.path}]`,
        );
        for (const issue of failure.issues) {
          console.log(`      ${issue}`);
        }
      }
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
