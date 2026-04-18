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
import { Ollama } from "ollama";
import { cacheClear, extract, warmUp } from "../../src/index.js";
import { runRules } from "../../src/rules/engine.js";
import {
  formatRange,
  getFilterKind,
  parseReferenceDate,
  resolveExpression,
} from "../../src/resolver/resolve.js";
import type {
  DateExpression,
  ExtractRequest,
  ExtractResponse,
  OutputMode,
  ResolvedValue,
} from "../../src/types.js";

class BenchExit extends Error {
  code: number;

  constructor(code = 0) {
    super(`Benchmark exited with code ${code}`);
    this.code = code;
  }
}

function createProcessShim(args: string[]) {
  return {
    argv: ["node", "bench.ts", ...args],
    env: globalThis.process.env,
    loadEnvFile: globalThis.process.loadEnvFile?.bind(globalThis.process),
    exitCode: 0,
    exit(code = 0): never {
      throw new BenchExit(code);
    },
  };
}

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const benchmarksDir = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(benchmarksDir, "..");
const datasetsDir = path.join(benchmarksDir, "datasets");
const reportsDir = path.join(benchmarksDir, "reports");
const sourceDatasetsDir = path.join(datasetsDir, "source");

function ensureBenchmarkDirs(): void {
  fs.mkdirSync(datasetsDir, { recursive: true });
  fs.mkdirSync(reportsDir, { recursive: true });
  fs.mkdirSync(sourceDatasetsDir, { recursive: true });
}

async function runPerf(cliArgs: string[]): Promise<void> {
  const process = createProcessShim(cliArgs);

  const queries = [
    "저번 달 잔액 알려줘",
    "3월 4월 잔액 알려줘",
    "사흘 전 날씨",
    "저번달 영업일",
    "이번 달 평일",
    "작년 공휴일",
    "어제 매출",
    "오늘 일정",
    "내일 날씨",
    "그저께 있었던 일",
    "보름 전",
    "7일 전",
    "2025-12-25 잔액",
    "2025년 3월 1일",
    "작년 매출",
    "올해 실적",
    "지난주 일정",
    "이번 주 일정",
    "last month sales",
    "what was the balance yesterday",
  ];

  function percentile(values: number[], p: number): number {
    const sorted = [...values].sort((a, b) => a - b);
    const idx = Math.ceil((p / 100) * sorted.length) - 1;
    return sorted[Math.max(0, idx)];
  }

  async function bench(label: string, iterations: number, fn: () => Promise<number>) {
    const samples: number[] = [];
    // warm-up
    for (let i = 0; i < 3; i++) await fn();
    for (let i = 0; i < iterations; i++) {
      samples.push(await fn());
    }
    const p50 = percentile(samples, 50);
    const p95 = percentile(samples, 95);
    const avg = samples.reduce((a, b) => a + b, 0) / samples.length;
    console.log(
      `  ${label.padEnd(22)} p50=${p50.toFixed(2)}ms  p95=${p95.toFixed(2)}ms  avg=${avg.toFixed(2)}ms  (n=${iterations})`,
    );
  }

  async function main() {
    console.log("datetime-extractor 벤치마크");
    console.log("reference: 2026-04-17, timezone: Asia/Seoul\n");

    console.log("[룰 경로 (LLM 미경유)]");
    for (const q of queries.slice(0, 6)) {
      cacheClear();
      await bench(
        q.slice(0, 20),
        20,
        async () => {
          const t0 = performance.now();
          await extract({
            text: q,
            referenceDate: "2026-04-17",
            outputModes: ["range", "single", "business_days", "weekdays", "holidays"],
          });
          return performance.now() - t0;
        },
      );
    }

    console.log("\n[캐시 hit]");
    const q = queries[0];
    await extract({ text: q, referenceDate: "2026-04-17", outputModes: ["range"] });
    await bench(
      "cache hit",
      1000,
      async () => {
        const t0 = performance.now();
        await extract({
          text: q,
          referenceDate: "2026-04-17",
          outputModes: ["range"],
        });
        return performance.now() - t0;
      },
    );

    console.log("\n[종합 통계]");
    cacheClear();
    const all: number[] = [];
    for (const q of queries) {
      const t0 = performance.now();
      await extract({
        text: q,
        referenceDate: "2026-04-17",
        outputModes: ["range", "single"],
      });
      all.push(performance.now() - t0);
    }
    console.log(
      `  전체 쿼리(n=${queries.length}) p50=${percentile(all, 50).toFixed(2)}ms  p95=${percentile(all, 95).toFixed(2)}ms`,
    );
  }

  await main();
}

async function runEvalSuite(cliArgs: string[]): Promise<void> {
  const process = createProcessShim(cliArgs);

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

  const datasetPath = path.join(datasetsDir, "datetime-eval-suite.json");
  const RULE_ONLY = process.argv.includes("--rule-only");
  const reportPath = path.join(
    reportsDir,
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
      path.join(repoRoot, "src", "calendar", "holidays-fallback.json"),
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

    ensureBenchmarkDirs();
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

  await main();
}

async function runHumanlike500(cliArgs: string[]): Promise<void> {
  const process = createProcessShim(cliArgs);

  process.loadEnvFile?.(".env");

  type RangeExp = { start: string; end: string };

  interface Spec {
    id: string;
    category: "single_date" | "lifecycle" | "comparison" | "no_date";
    requiredPhrases: string[];
    expected: RangeExp[];
    scenario: string;
    styleHint: string;
  }

  interface GeneratedCase {
    id: string;
    category: Spec["category"];
    text: string;
    referenceDate: string;
    presentRangeEnd: "today";
    expected: RangeExp[];
    generation: "ollama" | "fallback";
    requiredPhrases: string[];
    scenario: string;
  }

  interface GenerationResponse {
    items: Array<{ id: string; text: string }>;
  }

  interface EvalResult {
    total: number;
    passed: number;
    accuracy: number;
    byCategory: Array<{
      category: Spec["category"];
      total: number;
      passed: number;
      accuracy: number;
    }>;
    byPath: Array<{ path: string; count: number }>;
    failures: Array<{
      id: string;
      text: string;
      category: Spec["category"];
      path: string;
      expected: RangeExp[];
      actual: RangeExp[];
      issues: string[];
    }>;
  }

  const DEFAULT_HOST = normalizeHost(
    process.env.OLLAMA_HOST ?? "http://localhost:11434",
  );
  const DEFAULT_MODEL = process.env.OLLAMA_MODEL ?? "gemma4:e2b";
  const REFERENCE_DATE = "2025-11-17";
  const ref = parseISO(`${REFERENCE_DATE}T00:00:00`);

  const client = new Ollama({ host: DEFAULT_HOST });

  const jsonPath = path.join(datasetsDir, "humanlike-500.json");
  const csvPath = path.join(datasetsDir, "humanlike-500.csv");
  const reportPath = path.join(reportsDir, "humanlike-500-report.json");
  const sourceCsvArg = process.argv.find((arg) => arg.startsWith("--source-csv="));
  const sourceCsvPath = sourceCsvArg
    ? path.resolve(sourceCsvArg.slice("--source-csv=".length))
    : path.join(sourceDatasetsDir, "test_results11111.csv");

  const outputSchema = {
    type: "object",
    properties: {
      items: {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: { type: "string" },
            text: { type: "string" },
          },
          required: ["id", "text"],
        },
      },
    },
    required: ["items"],
  } as const;

  const styleHints = [
    "짧고 단도직입적인 톤",
    "실무자가 급하게 물어보는 톤",
    "조금 공손한 질문형",
    "메신저에 치듯 자연스러운 톤",
    "보고서 확인 요청처럼 차분한 톤",
    "살짝 구어체인 톤",
    "분석을 부탁하는 톤",
    "간단히 확인만 요청하는 톤",
    "비교를 바로 하고 싶은 톤",
    "잔액을 바로 알고 싶은 톤",
  ];

  const singleTimePhrases: Array<{ phrase: string; expected: RangeExp[] }> = [
    { phrase: "오늘", expected: [dayRange(ref)] },
    { phrase: "어제", expected: [dayRange(addDays(ref, -1))] },
    { phrase: "그제", expected: [dayRange(addDays(ref, -2))] },
    { phrase: "그저께", expected: [dayRange(addDays(ref, -2))] },
    { phrase: "엊그제", expected: [dayRange(addDays(ref, -2))] },
    { phrase: "사흘 전", expected: [dayRange(addDays(ref, -3))] },
    { phrase: "나흘 전", expected: [dayRange(addDays(ref, -4))] },
    { phrase: "보름 전", expected: [dayRange(addDays(ref, -15))] },
    { phrase: "일주일 전", expected: [dayRange(addDays(ref, -7))] },
    { phrase: "지난주", expected: [weekOffsetRange(-1)] },
    { phrase: "이번 주", expected: [weekOffsetRange(0)] },
    { phrase: "지난달", expected: [monthOffsetRange(-1)] },
    { phrase: "이번 달", expected: [monthOffsetRange(0)] },
    { phrase: "3월", expected: [monthOnlyPastRange(3)] },
    { phrase: "8월", expected: [monthOnlyPastRange(8)] },
    { phrase: "올해", expected: [yearOffsetRange(0)] },
    { phrase: "작년", expected: [yearOffsetRange(-1)] },
    { phrase: "재작년", expected: [yearOffsetRange(-2)] },
    { phrase: "이번분기", expected: [quarterOffsetRange(0)] },
    { phrase: "지난분기", expected: [quarterOffsetRange(-1)] },
    { phrase: "4분기", expected: [quarterRange(ref.getFullYear(), 4)] },
    { phrase: "하반기", expected: [halfRange(ref.getFullYear(), 2)] },
    { phrase: "1분기", expected: [quarterRange(ref.getFullYear(), 1)] },
    { phrase: "2024년 2월", expected: [explicitMonthRange(2024, 2)] },
    { phrase: "2023년", expected: [explicitYearRange(2023)] },
  ];

  const singleScenarios = [
    "예적금 계좌 흐름이 어땠는지 보고 싶어",
    "대출 쪽 잔액만 따로 확인하고 싶어",
    "외화 계좌 거래 내역을 정리해서 보여줘",
    "증권 계좌에서 빠져나간 돈만 보고 싶어",
    "신탁 계좌 입출금 흐름을 확인해줘",
    "수시입출 계좌 움직임이 어땠는지 알고 싶어",
    "운영비 비중이 어느 정도였는지 보고 싶어",
    "삼성전자랑 거래한 비중이 얼마나 되는지 궁금해",
    "큰 금액 거래만 골라서 확인하고 싶어",
    "자금 증감 흐름을 한눈에 보고 싶어",
  ];

  const lifecyclePhrases: Array<{ phrases: string[]; expected: RangeExp[] }> = [
    { phrases: ["2024년 7월 31일"], expected: [explicitDayRange(2024, 7, 31)] },
    { phrases: ["2014년 7월 31일"], expected: [explicitDayRange(2014, 7, 31)] },
    { phrases: ["2027년 2월 1일부터 7일까지"], expected: [explicitRange(2027, 2, 1, 2027, 2, 7)] },
    { phrases: ["2027년 1월 31일"], expected: [explicitDayRange(2027, 1, 31)] },
    { phrases: ["2032년 1분기"], expected: [quarterRange(2032, 1)] },
    { phrases: ["2029년 12월"], expected: [explicitMonthRange(2029, 12)] },
    { phrases: ["2020년 2월"], expected: [explicitMonthRange(2020, 2)] },
    { phrases: ["2026년 8월"], expected: [explicitMonthRange(2026, 8)] },
    { phrases: ["2025년 3월 1일"], expected: [explicitDayRange(2025, 3, 1)] },
    { phrases: ["2024년 10월 9일"], expected: [explicitDayRange(2024, 10, 9)] },
    { phrases: ["2028년 상반기"], expected: [halfRange(2028, 1)] },
    { phrases: ["2028년 하반기"], expected: [halfRange(2028, 2)] },
    { phrases: ["2026년 1분기"], expected: [quarterRange(2026, 1)] },
    { phrases: ["2027년 4분기"], expected: [quarterRange(2027, 4)] },
    { phrases: ["2023년 1월 1일부터 10일까지"], expected: [explicitRange(2023, 1, 1, 2023, 1, 10)] },
    { phrases: ["2024년 5월"], expected: [explicitMonthRange(2024, 5)] },
    { phrases: ["2023년 12월"], expected: [explicitMonthRange(2023, 12)] },
    { phrases: ["2027년 2월"], expected: [explicitMonthRange(2027, 2)] },
    { phrases: ["2026년 3월"], expected: [explicitMonthRange(2026, 3)] },
    { phrases: ["2024년 2월"], expected: [explicitMonthRange(2024, 2)] },
  ];

  const lifecycleScenarios = [
    "에 만기되는 계좌만 추려줘",
    "에 개설된 계좌가 뭐였는지 찾아줘",
    "에 남아 있던 잔액을 보고 싶어",
    "에 신규 개설된 계좌 거래내역만 보고 싶어",
    "에 가입한 상품이 있었는지 확인해줘",
  ];

  const pairPhrases: Array<{ phrases: string[]; expected: RangeExp[] }> = [
    { phrases: ["지난달", "이번 달"], expected: [monthOffsetRange(-1), monthOffsetRange(0)] },
    { phrases: ["작년", "올해"], expected: [yearOffsetRange(-1), yearOffsetRange(0)] },
    { phrases: ["지난분기", "이번분기"], expected: [quarterOffsetRange(-1), quarterOffsetRange(0)] },
    { phrases: ["3월", "4월"], expected: [monthOnlyPastRange(3), monthOnlyPastRange(4)] },
    { phrases: ["재작년", "작년"], expected: [yearOffsetRange(-2), yearOffsetRange(-1)] },
    { phrases: ["지난주", "이번 주"], expected: [weekOffsetRange(-1), weekOffsetRange(0)] },
    { phrases: ["2024년", "2025년"], expected: [explicitYearRange(2024), explicitYearRange(2025)] },
    { phrases: ["2024년 2월", "2024년 3월"], expected: [explicitMonthRange(2024, 2), explicitMonthRange(2024, 3)] },
    { phrases: ["1분기", "2분기"], expected: [quarterRange(ref.getFullYear(), 1), quarterRange(ref.getFullYear(), 2)] },
    { phrases: ["작년 4분기", "올해 1분기"], expected: [quarterRange(2024, 4), quarterRange(2025, 1)] },
    { phrases: ["2025년 1분기", "2025년 2분기"], expected: [quarterRange(2025, 1), quarterRange(2025, 2)] },
    { phrases: ["2024년 상반기", "2024년 하반기"], expected: [halfRange(2024, 1), halfRange(2024, 2)] },
    { phrases: ["지난달", "올해"], expected: [monthOffsetRange(-1), yearOffsetRange(0)] },
    { phrases: ["지난분기", "올해"], expected: [quarterOffsetRange(-1), yearOffsetRange(0)] },
    { phrases: ["2023년", "2024년"], expected: [explicitYearRange(2023), explicitYearRange(2024)] },
    { phrases: ["2026년 3월", "2026년 8월"], expected: [explicitMonthRange(2026, 3), explicitMonthRange(2026, 8)] },
    { phrases: ["이번 주", "이번 달"], expected: [weekOffsetRange(0), monthOffsetRange(0)] },
    { phrases: ["작년", "올해 1분기"], expected: [yearOffsetRange(-1), quarterRange(2025, 1)] },
    { phrases: ["지난달", "4분기"], expected: [monthOffsetRange(-1), quarterRange(2025, 4)] },
    { phrases: ["2024년 10월", "2024년 12월"], expected: [explicitMonthRange(2024, 10), explicitMonthRange(2024, 12)] },
  ];

  const pairScenarios = [
    "지출 흐름이 어떻게 달라졌는지 비교해줘",
    "잔액 차이만 바로 보이게 정리해줘",
    "입출금 흐름을 나란히 비교하고 싶어",
    "어느 쪽 거래 규모가 더 컸는지 알고 싶어",
    "같은 거래처 기준으로 비중을 비교해줘",
  ];

  const noDateScenarios = [
    "예적금 잔액만 따로 보여줘",
    "대출 거래내역만 모아서 볼 수 있을까?",
    "외화 계좌가 몇 개인지 확인해줘",
    "증권 계좌 잔액을 큰 순서로 정렬해줘",
    "신탁 계좌에서 출금 큰 건만 보여줘",
    "수시입출 계좌 입금이 더 많은 계좌가 있는지 봐줘",
    "삼성전자랑 거래한 내역만 찾아줘",
    "은행별 잔액 현황을 보여줘",
    "달러 예수금이 얼마나 있는지 알려줘",
    "운용 가능한 자금이 얼마나 되는지 궁금해",
    "우리 회사가 보유한 상품 종류를 알려줘",
    "외화 계좌 잔액 합계가 얼마인지 봐줘",
    "거래가 제일 많은 계좌 하나만 보여줘",
    "입금이 없는 계좌가 있는지 확인해줘",
    "잔액이 큰 계좌부터 정렬해서 보여줘",
    "기업은행 쪽 거래내역만 따로 보고 싶어",
    "예금 금리가 높은 상품이 있는지 알려줘",
    "수수료 많이 나간 계좌를 찾아줘",
    "대출 계좌 중 금액이 큰 것만 보여줘",
    "증권 쪽 남은 돈이 얼마나 되는지 보고 싶어",
    "계좌별 잔액 합계를 계산해줘",
    "입출금 내역에서 이상 거래가 있는지 봐줘",
    "예적금 계좌 개수가 몇 개인지 알려줘",
    "웹케시랑 거래한 내역만 보고 싶어",
    "출금이 많은 순서대로 계좌를 보여줘",
    "외화 예적금 계좌만 따로 모아줘",
    "거래 적요별 개수를 정리해줘",
    "대출 원금이 큰 순서대로 보여줘",
    "신탁 상품별 잔액 현황을 보고 싶어",
    "증권 계좌 수익이 큰 것부터 보여줘",
    "은행별 자금 현황을 한눈에 보여줘",
    "계좌 중 비활성으로 보이는 게 있는지 알려줘",
    "입금만 있고 출금 없는 계좌를 찾아줘",
    "외화 대출이 있는지 확인해줘",
    "적금 계좌 잔액이 얼마나 남았는지 봐줘",
    "거래처별 비중을 정리해서 보여줘",
    "예수금이 많은 계좌만 골라줘",
    "상품별 거래내역을 나눠서 보고 싶어",
    "기업별 거래 금액 순위를 보여줘",
    "출금보다 입금이 많은 계좌를 보여줘",
    "예적금 해지 예정 계좌가 있는지 알려줘",
    "증권 거래내역을 최신순으로 정렬해줘",
    "대출 이자 납부 내역만 모아줘",
    "수시입출 계좌 잔액 합계를 계산해줘",
    "외화 거래가 있었던 계좌만 보여줘",
    "신탁 계좌가 몇 개나 있는지 궁금해",
    "잔액은 있는데 거래가 없는 계좌를 찾아줘",
    "보통예금 쪽 자금만 보고 싶어",
    "거래 많은 계좌를 상위 몇 개만 보여줘",
    "은행별 계좌 수를 알려줘",
  ];

  function ymd(date: Date): string {
    return format(date, "yyyy-MM-dd");
  }

  function dayRange(date: Date): RangeExp {
    const iso = ymd(date);
    return { start: iso, end: iso };
  }

  function clampIfCurrent(start: Date, end: Date): RangeExp {
    if (start <= ref && end >= ref) {
      return { start: ymd(start), end: REFERENCE_DATE };
    }
    return { start: ymd(start), end: ymd(end) };
  }

  function weekOffsetRange(offset: number): RangeExp {
    const target = addWeeks(ref, offset);
    return clampIfCurrent(
      startOfWeek(target, { weekStartsOn: 1 }),
      endOfWeek(target, { weekStartsOn: 1 }),
    );
  }

  function monthOffsetRange(offset: number): RangeExp {
    const target = addMonths(ref, offset);
    return clampIfCurrent(startOfMonth(target), endOfMonth(target));
  }

  function yearOffsetRange(offset: number): RangeExp {
    const targetYear = ref.getFullYear() + offset;
    return clampIfCurrent(
      startOfYear(new Date(targetYear, 0, 1)),
      endOfYear(new Date(targetYear, 0, 1)),
    );
  }

  function monthOnlyPastRange(month: number): RangeExp {
    let year = ref.getFullYear();
    if (new Date(year, month - 1, 1) > ref) year -= 1;
    return { start: `${year}-${pad(month)}-01`, end: ymd(endOfMonth(new Date(year, month - 1, 1))) };
  }

  function quarterRange(year: number, quarter: 1 | 2 | 3 | 4): RangeExp {
    const start = new Date(year, (quarter - 1) * 3, 1);
    return clampIfCurrent(start, endOfQuarter(start));
  }

  function quarterOffsetRange(offset: number): RangeExp {
    const target = addMonths(startOfQuarter(ref), offset * 3);
    return clampIfCurrent(target, endOfQuarter(target));
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
    return clampIfCurrent(new Date(year, month - 1, 1), endOfMonth(new Date(year, month - 1, 1)));
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

  function pad(n: number): string {
    return String(n).padStart(2, "0");
  }

  function buildSpecs(): Spec[] {
    const specs: Spec[] = [];

    for (let i = 0; i < singleTimePhrases.length; i++) {
      for (let j = 0; j < singleScenarios.length; j++) {
        specs.push({
          id: `single-${i + 1}-${j + 1}`,
          category: "single_date",
          requiredPhrases: [singleTimePhrases[i].phrase],
          expected: singleTimePhrases[i].expected,
          scenario: singleScenarios[j],
          styleHint: styleHints[(i + j) % styleHints.length],
        });
      }
    }

    for (let i = 0; i < lifecyclePhrases.length; i++) {
      for (let j = 0; j < lifecycleScenarios.length; j++) {
        specs.push({
          id: `life-${i + 1}-${j + 1}`,
          category: "lifecycle",
          requiredPhrases: lifecyclePhrases[i].phrases,
          expected: lifecyclePhrases[i].expected,
          scenario: lifecycleScenarios[j],
          styleHint: styleHints[(i * 2 + j) % styleHints.length],
        });
      }
    }

    for (let i = 0; i < pairPhrases.length; i++) {
      for (let j = 0; j < pairScenarios.length; j++) {
        specs.push({
          id: `pair-${i + 1}-${j + 1}`,
          category: "comparison",
          requiredPhrases: pairPhrases[i].phrases,
          expected: pairPhrases[i].expected,
          scenario: pairScenarios[j],
          styleHint: styleHints[(i + j * 3) % styleHints.length],
        });
      }
    }

    for (let i = 0; i < noDateScenarios.length; i++) {
      specs.push({
        id: `none-${i + 1}`,
        category: "no_date",
        requiredPhrases: [],
        expected: [],
        scenario: noDateScenarios[i],
        styleHint: styleHints[i % styleHints.length],
      });
    }

    if (specs.length !== 500) {
      throw new Error(`Expected 500 specs, got ${specs.length}`);
    }

    return specs;
  }

  function loadSourceTexts(): Set<string> {
    if (!fs.existsSync(sourceCsvPath)) {
      throw new Error(`source CSV not found: ${sourceCsvPath}`);
    }
    const raw = fs.readFileSync(sourceCsvPath, "utf8").replace(/^\uFEFF/, "");
    const lines = raw.trim().split(/\r?\n/).slice(1);
    const out = new Set<string>();
    for (const line of lines) {
      const [text] = parseCsvLine(line);
      if (text) out.add(text);
    }
    return out;
  }

  function parseCsvLine(line: string): string[] {
    const out: string[] = [];
    let cur = "";
    let inQuote = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (inQuote) {
        if (ch === '"' && line[i + 1] === '"') {
          cur += '"';
          i++;
        } else if (ch === '"') {
          inQuote = false;
        } else {
          cur += ch;
        }
      } else if (ch === '"') {
        inQuote = true;
      } else if (ch === ",") {
        out.push(cur);
        cur = "";
      } else {
        cur += ch;
      }
    }
    out.push(cur);
    return out;
  }

  async function generateBatch(batch: Spec[], batchIndex: number): Promise<Map<string, string>> {
    const examples = [
      "외화 대출 계좌 잔액",
      "이번 달 운영비의 비율은 어떻게 되나요?",
      "2029년 말에 만기되는 대출 계좌를 조회해줘.",
      "지난달에 원티드랩 이체 내역",
      "수시입출계좌와 예적금계좌의 이번 주 거래 내역",
    ];
    const prompt = [
      "샘플 문체(베끼지 말고 분위기만 참고):",
      ...examples.map((ex) => `- ${ex}`),
      "",
      "아래 items 각각에 대해 실제 한국어 금융 서비스 사용자가 입력할 법한 새 문장 1개씩 만들어라.",
      "규칙:",
      "- requiredPhrases의 문구는 문장에 그대로 포함한다.",
      "- 날짜 의미를 바꾸는 다른 시간 표현을 추가하지 않는다.",
      "- 문장은 자연스럽고 다양하게 쓴다. 템플릿 티가 나지 않게 한다.",
      "- 한 item당 한 문장만 만든다.",
      "- no_date 카테고리는 시간 표현을 절대 넣지 않는다.",
      "- 기존 샘플 문장을 그대로 복사하지 않는다.",
      "",
      "items:",
      ...batch.map((spec) =>
        JSON.stringify({
          id: spec.id,
          category: spec.category,
          requiredPhrases: spec.requiredPhrases,
          scenario: spec.scenario,
          styleHint: spec.styleHint,
        }),
      ),
    ].join("\n");

    const res = await client.chat({
      model: DEFAULT_MODEL,
      messages: [
        {
          role: "system",
          content:
            "당신은 한국의 기업금융/자금관리 서비스에서 사용자가 실제로 입력할 법한 자연스러운 질문 문장을 쓰는 도우미다. JSON만 출력한다.",
        },
        { role: "user", content: prompt },
      ],
      format: outputSchema as object,
      think: false as never,
      options: {
        temperature: 0.8,
        seed: 1000 + batchIndex,
        num_predict: 3200,
        num_ctx: 8192,
      },
      keep_alive: "10m",
    });

    const content = sanitizeJsonText(res.message?.content ?? "");
    const parsed = JSON.parse(content) as GenerationResponse;
    return new Map(parsed.items.map((item) => [item.id, item.text]));
  }

  function sanitizeJsonText(content: string): string {
    const trimmed = content.trim();
    if (trimmed.startsWith("```")) {
      const withoutFence = trimmed
        .replace(/^```(?:json)?\s*/i, "")
        .replace(/\s*```$/, "");
      return withoutFence.trim();
    }
    const firstBrace = trimmed.indexOf("{");
    const lastBrace = trimmed.lastIndexOf("}");
    if (firstBrace >= 0 && lastBrace > firstBrace) {
      return trimmed.slice(firstBrace, lastBrace + 1);
    }
    return trimmed;
  }

  function hasDateSignal(text: string): boolean {
    return /(오늘|어제|내일|그제|그저께|엊그제|사흘|나흘|보름|일주일|지난|이번|작년|올해|재작년|분기|상반기|하반기|\d{4}년|\d{1,2}월|\d{1,2}일|최근)/.test(
      text,
    );
  }

  function validateText(
    text: string,
    spec: Spec,
    existing: Set<string>,
    generated: Set<string>,
  ): boolean {
    const trimmed = text.trim();
    if (trimmed.length < 6) return false;
    if (existing.has(trimmed) || generated.has(trimmed)) return false;
    if (spec.category === "no_date") return !hasDateSignal(trimmed);
    return spec.requiredPhrases.every((phrase) => trimmed.includes(phrase));
  }

  function fallbackText(spec: Spec, attempt: number): string {
    const variants = [
      (base: string) => base,
      (base: string) => `${base} 한번 봐줘`,
      (base: string) => `${base} 확인 부탁해`,
      (base: string) => `${base} 궁금해`,
      (base: string) => `${base} 정리해줘`,
    ];

    let base: string;
    if (spec.category === "comparison") {
      base = `${spec.requiredPhrases[0]}랑 ${spec.requiredPhrases[1]} ${spec.scenario}`;
    } else if (spec.category === "no_date") {
      base = spec.scenario;
    } else if (spec.scenario.startsWith("에 ")) {
      base = `${spec.requiredPhrases[0]}${spec.scenario}`;
    } else {
      base = `${spec.requiredPhrases[0]} ${spec.scenario}`;
    }
    return variants[attempt % variants.length](base).replace(/\s+/g, " ").trim();
  }

  async function generateCases(specs: Spec[]): Promise<GeneratedCase[]> {
    const sourceTexts = loadSourceTexts();
    const generatedTexts = new Set<string>();
    const cases: GeneratedCase[] = [];
    const useOllama = process.argv.includes("--ollama");

    if (useOllama) {
      await warmUp();
    }

    const chunkSize = 25;
    for (let i = 0; i < specs.length; i += chunkSize) {
      const batch = specs.slice(i, i + chunkSize);
      console.log(`generating batch ${i / chunkSize + 1}/${Math.ceil(specs.length / chunkSize)}`);
      let outputs = new Map<string, string>();
      if (useOllama) {
        try {
          outputs = await generateBatch(batch, i / chunkSize);
        } catch (error) {
          console.log(`  ollama batch failed, using fallback: ${String(error)}`);
        }
      }

      for (let j = 0; j < batch.length; j++) {
        const spec = batch[j];
        let text = outputs.get(spec.id)?.trim() ?? "";
        let source: GeneratedCase["generation"] = "ollama";

        if (!validateText(text, spec, sourceTexts, generatedTexts)) {
          source = "fallback";
          let chosen = "";
          for (let attempt = 0; attempt < 8; attempt++) {
            const candidate = composeHumanlikeText(spec, attempt + j);
            if (validateText(candidate, spec, sourceTexts, generatedTexts)) {
              chosen = candidate;
              break;
            }
          }
          text = chosen || composeHumanlikeText(spec, j + 11);
        }

        generatedTexts.add(text);
        cases.push({
          id: spec.id,
          category: spec.category,
          text,
          referenceDate: REFERENCE_DATE,
          presentRangeEnd: "today",
          expected: spec.expected,
          generation: source,
          requiredPhrases: spec.requiredPhrases,
          scenario: spec.scenario,
        });
      }
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

  function eq(a: unknown, b: unknown): boolean {
    return stable(a) === stable(b);
  }

  function normalizeHost(host: string): string {
    return host.replace("://localhost", "://127.0.0.1");
  }

  function pickBestRange(results: Array<{ mode: string; value: unknown }>): RangeExp | null {
    for (const result of results) {
      if (result.mode === "range") return result.value as RangeExp;
    }
    for (const result of results) {
      if (result.mode === "single") {
        const v = result.value as string;
        return { start: v, end: v };
      }
    }
    return null;
  }

  async function evaluate(cases: GeneratedCase[]): Promise<EvalResult> {
    const byCategory = new Map<
      Spec["category"],
      { total: number; passed: number }
    >();
    const byPath = new Map<string, number>();
    const failures: EvalResult["failures"] = [];

    let passed = 0;

    for (let i = 0; i < cases.length; i++) {
      const testCase = cases[i];
      cacheClear();
      const res = await extract({
        text: testCase.text,
        referenceDate: testCase.referenceDate,
        outputModes: ["range", "single"],
        presentRangeEnd: testCase.presentRangeEnd,
      });

      const actualRanges = res.expressions
        .map((expr) => pickBestRange(expr.results))
        .filter(Boolean) as RangeExp[];
      const expectedRanges = testCase.expected;
      const issues: string[] = [];
      let ok = true;

      if (expectedRanges.length === 0) {
        if (res.hasDate || actualRanges.length > 0) {
          ok = false;
          issues.push("expected no date, but got date");
        }
      } else {
        if (!res.hasDate) {
          ok = false;
          issues.push("hasDate=false");
        }
        if (actualRanges.length !== expectedRanges.length) {
          ok = false;
          issues.push(
            `range count mismatch expected=${expectedRanges.length} actual=${actualRanges.length}`,
          );
        }
        for (const exp of expectedRanges) {
          const hit = actualRanges.some((act) => eq(act, exp));
          if (!hit) {
            ok = false;
            issues.push(`missing expected range ${stable(exp)}`);
          }
        }
      }

      const cat = byCategory.get(testCase.category) ?? { total: 0, passed: 0 };
      cat.total += 1;
      if (ok) {
        passed += 1;
        cat.passed += 1;
      } else if (failures.length < 30) {
        failures.push({
          id: testCase.id,
          text: testCase.text,
          category: testCase.category,
          path: res.meta.path,
          expected: expectedRanges,
          actual: actualRanges,
          issues,
        });
      }
      byCategory.set(testCase.category, cat);
      byPath.set(res.meta.path, (byPath.get(res.meta.path) ?? 0) + 1);

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

  function csvEscape(value: string): string {
    if (/[",\n]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
    return value;
  }

  function composeHumanlikeText(spec: Spec, variant: number): string {
    const tone = variant % 8;
    if (spec.category === "no_date") {
      const patterns = [
        `${spec.scenario}`,
        `${spec.scenario} 좀 확인해줘`,
        `${spec.scenario} 볼 수 있을까?`,
        `${spec.scenario} 먼저 보고 싶어`,
        `${spec.scenario} 한 번만 정리해줘`,
        `${spec.scenario} 바로 알려줘`,
        `${spec.scenario} 확인 부탁해`,
        `${spec.scenario} 간단히 보여줘`,
      ];
      return patterns[tone];
    }

    if (spec.category === "comparison") {
      const [a, b] = spec.requiredPhrases;
      const patterns = [
        `${a}이랑 ${b} ${spec.scenario}`,
        `${a}하고 ${b} ${spec.scenario}`,
        `${a} 기준이랑 ${b} 기준 ${spec.scenario}`,
        `${a} 때랑 ${b} 때 ${spec.scenario}`,
        `${a}하고 ${b}를 같이 놓고 ${spec.scenario}`,
        `${a}, ${b} 두 구간 ${spec.scenario}`,
        `${a} 쪽이랑 ${b} 쪽 ${spec.scenario}`,
        `${a}하고 ${b} 건 ${spec.scenario}`,
      ];
      return patterns[tone];
    }

    const phrase = spec.requiredPhrases[0];
    if (spec.category === "lifecycle") {
      const tail = spec.scenario.replace(/^에\s*/, "");
      const connector = phrase.includes("부터") && phrase.includes("까지")
        ? " 사이에 "
        : "에 ";
      const patterns = [
        `${phrase}${connector}${tail}`,
        `${phrase}${connector}${tail} 좀 볼 수 있을까?`,
        `${phrase}${connector}${tail} 먼저 확인해줘`,
        `${phrase}${connector}${tail} 한 번 정리해줘`,
        `${phrase}${connector}${tail} 있는지 알려줘`,
        `${phrase}${connector}${tail} 부탁해`,
        `${phrase}${connector}${tail} 바로 보고 싶어`,
        `${phrase}${connector}${tail} 체크해줘`,
      ];
      return patterns[tone];
    }

    const patterns = [
      `${phrase} ${spec.scenario}`,
      `${phrase} 기준으로 ${spec.scenario}`,
      `${phrase}만 놓고 ${spec.scenario}`,
      `${phrase} 기준 ${spec.scenario}`,
      `${phrase} 데이터로 ${spec.scenario}`,
      `${phrase} 시점으로 ${spec.scenario}`,
      `${phrase} 상황만 놓고 ${spec.scenario}`,
      `${phrase} 기준으로만 보면 ${spec.scenario}`,
    ];
    return patterns[tone];
  }

  function writeArtifacts(cases: GeneratedCase[], report: EvalResult) {
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

    const rows = ["text,final_start_date,final_end_date"];
    for (const testCase of cases) {
      if (testCase.expected.length === 0) {
        rows.push(`${csvEscape(testCase.text)},,`);
        continue;
      }
      for (const exp of testCase.expected) {
        rows.push(
          [
            csvEscape(testCase.text),
            csvEscape(exp.start),
            csvEscape(exp.end),
          ].join(","),
        );
      }
    }
    fs.writeFileSync(csvPath, `${rows.join("\n")}\n`, "utf8");
    fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  }

  async function main() {
    const specs = buildSpecs();
    const cases = await generateCases(specs);
    const report = await evaluate(cases);
    writeArtifacts(cases, report);

    const sourceBreakdown = cases.reduce<Record<string, number>>((acc, item) => {
      acc[item.generation] = (acc[item.generation] ?? 0) + 1;
      return acc;
    }, {});

    console.log(`\nwritten: ${jsonPath}`);
    console.log(`csv: ${csvPath}`);
    console.log(`report: ${reportPath}`);
    console.log(`model: ${DEFAULT_MODEL}`);
    console.log(`referenceDate: ${REFERENCE_DATE}`);
    console.log(`accuracy: ${report.passed}/${report.total} (${report.accuracy.toFixed(2)}%)`);
    console.log(`generation source: ${JSON.stringify(sourceBreakdown)}`);
    console.log("by category:");
    for (const category of report.byCategory) {
      console.log(
        `  ${category.category.padEnd(12)} ${category.passed}/${category.total} (${category.accuracy.toFixed(2)}%)`,
      );
    }
    console.log("by path:");
    for (const pathEntry of report.byPath) {
      console.log(`  ${pathEntry.path.padEnd(10)} ${pathEntry.count}`);
    }
    if (report.failures.length > 0) {
      console.log("sample failures:");
      for (const failure of report.failures.slice(0, 12)) {
        console.log(`  - ${failure.text} [${failure.path}]`);
        console.log(`    expected: ${failure.expected.map((x) => `${x.start}~${x.end}`).join(", ") || "(none)"}`);
        console.log(`    actual:   ${failure.actual.map((x) => `${x.start}~${x.end}`).join(", ") || "(none)"}`);
      }
    }
  }

  await main();
}

async function runDateDiversity500(cliArgs: string[]): Promise<void> {
  const process = createProcessShim(cliArgs);

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

  await main();
}

async function runAccuracy(cliArgs: string[]): Promise<void> {
  const process = createProcessShim(cliArgs);

  /**
   * test_results.csv에서 text/final_start_date/final_end_date를 읽어
   * 라이브러리 결과와 비교하여 정확도 측정.
   *
   * 규칙:
   *  - 같은 text가 여러 행으로 나오면 해당 행 수만큼의 expression을 기대
   *  - 기대 start/end가 비어있으면 hasDate=false 또는 결과 무시
   *  - 날짜 포맷: CSV는 "YYYY.M.D" → 비교 시 "YYYY-MM-DD"로 정규화
   */

  const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  const CSV = args[0] ?? path.join(sourceDatasetsDir, "test_results.csv");
  const REFERENCE_DATE = "2025-11-17";
  const DEFAULT_TO_TODAY = process.argv.includes("--default-to-today");
  const RULE_ONLY = process.argv.includes("--rule-only");
  const PRESENT_RANGE_END: "period" | "today" = process.argv.includes(
    "--present-today",
  )
    ? "today"
    : "period";

  interface Row {
    text: string;
    start: string | null;
    end: string | null;
  }

  function parseCSV(raw: string): Row[] {
    if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
    const lines: Row[] = [];
    const rows = raw.split(/\r?\n/).filter((l) => l.length > 0);
    const header = rows.shift()!;
    const headerCols = parseCsvLine(header);
    const iText = headerCols.indexOf("text");
    const iStart = headerCols.indexOf("final_start_date");
    const iEnd = headerCols.indexOf("final_end_date");
    for (const r of rows) {
      const cols = parseCsvLine(r);
      const text = cols[iText]?.trim() ?? "";
      if (!text) continue;
      lines.push({
        text,
        start: normalizeDate(cols[iStart]),
        end: normalizeDate(cols[iEnd]),
      });
    }
    return lines;
  }

  function parseCsvLine(line: string): string[] {
    const out: string[] = [];
    let cur = "";
    let inQuote = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (inQuote) {
        if (ch === '"' && line[i + 1] === '"') {
          cur += '"';
          i++;
        } else if (ch === '"') {
          inQuote = false;
        } else {
          cur += ch;
        }
      } else {
        if (ch === '"') inQuote = true;
        else if (ch === ",") {
          out.push(cur);
          cur = "";
        } else cur += ch;
      }
    }
    out.push(cur);
    return out;
  }

  function normalizeDate(s: string | undefined): string | null {
    if (!s) return null;
    const t = s.trim();
    if (!t) return null;
    const m = /^(\d{4})[./-](\d{1,2})[./-](\d{1,2})$/.exec(t);
    if (!m) return null;
    return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
  }

  function groupByText(rows: Row[]): Map<string, Row[]> {
    const m = new Map<string, Row[]>();
    for (const r of rows) {
      const arr = m.get(r.text);
      if (arr) arr.push(r);
      else m.set(r.text, [r]);
    }
    return m;
  }

  function rangesMatch(
    actualStart: string,
    actualEnd: string,
    expectedStart: string | null,
    expectedEnd: string | null,
  ): boolean {
    if (!expectedStart || !expectedEnd) return false;
    return actualStart === expectedStart && actualEnd === expectedEnd;
  }

  function pickBestRange(
    results: Array<{ mode: string; value: unknown }>,
  ): { start: string; end: string } | null {
    // range 모드 우선, 없으면 single을 {start,end} 동일로 취급
    for (const r of results) {
      if (r.mode === "range") {
        const v = r.value as { start: string; end: string };
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

  async function evaluateRuleOnly(text: string): Promise<{
    hasDate: boolean;
    path: string;
    actualRanges: Array<{ start: string; end: string }>;
  }> {
    const timezone = "Asia/Seoul";
    const referenceDate = parseReferenceDate(REFERENCE_DATE);
    const ruleResult = runRules(text, "auto");
    const actualRanges: Array<{ start: string; end: string }> = [];

    for (const matched of ruleResult.expressions) {
      const range = resolveExpression(matched.expression, {
        referenceDate,
        timezone,
      });
      if (
        PRESENT_RANGE_END === "today" &&
        !isExplicitSubset(matched.expression) &&
        range.start <= referenceDate &&
        range.end > referenceDate
      ) {
        range.end = referenceDate;
      }
      const filter = getFilterKind(matched.expression);
      const formatted = await formatRange(range, "range", filter, {
        timezone,
        dateOnlyForDateModes: true,
      });
      if (formatted?.mode === "range") {
        actualRanges.push(formatted.value);
      }
    }

    const path =
      ruleResult.expressions.length === 0
        ? "rule_only:no_match"
        : ruleResult.confidence >= 1
          ? "rule_only:full"
          : "rule_only:partial";

    return {
      hasDate: ruleResult.expressions.length > 0,
      path,
      actualRanges,
    };
  }

  async function main() {
    const raw = fs.readFileSync(CSV, "utf-8");
    const rows = parseCSV(raw);
    const grouped = groupByText(rows);

    let totalRows = rows.length;
    let correctRows = 0;
    let partialCorrectRows = 0;
    let noExpectedRows = 0;
    let missedRows = 0;
    const mismatches: Array<{
      text: string;
      expected: Array<{ start: string | null; end: string | null }>;
      actual: Array<{ start: string; end: string }>;
      hasDate: boolean;
      path: string;
    }> = [];

    let idx = 0;
    for (const [text, expectedRows] of grouped) {
      idx++;
      cacheClear();
      const evaluation = RULE_ONLY
        ? await evaluateRuleOnly(text)
        : await extract({
            text,
            referenceDate: REFERENCE_DATE,
            outputModes: ["range", "single"],
            defaultToToday: DEFAULT_TO_TODAY,
            presentRangeEnd: PRESENT_RANGE_END,
          }).then((res) => ({
            hasDate: res.hasDate,
            path: res.meta.path,
            actualRanges: res.expressions
              .map((e) => pickBestRange(e.results))
              .filter(Boolean) as Array<{ start: string; end: string }>,
          }));
      const actualRanges = evaluation.actualRanges;

      const expectedHasDate = expectedRows.some((r) => r.start && r.end);
      if (!expectedHasDate) {
        // 기대값이 비어있는 행 (애매하거나 날짜 없음)
        noExpectedRows += expectedRows.length;
        // 라이브러리가 hasDate=false 또는 무관한 결과면 "통과"로 취급
        continue;
      }

      // 각 expected row가 actualRanges 중 하나와 매치되는지 확인
      const matchedIdx = new Set<number>();
      let localCorrect = 0;
      for (const exp of expectedRows) {
        if (!exp.start || !exp.end) continue;
        const hit = actualRanges.findIndex(
          (a, i) =>
            !matchedIdx.has(i) && rangesMatch(a.start, a.end, exp.start, exp.end),
        );
        if (hit >= 0) {
          matchedIdx.add(hit);
          localCorrect++;
        }
      }
      correctRows += localCorrect;
      const dateExpectedCount = expectedRows.filter(
        (r) => r.start && r.end,
      ).length;
      if (localCorrect < dateExpectedCount) {
        missedRows += dateExpectedCount - localCorrect;
        if (localCorrect > 0) partialCorrectRows++;
        mismatches.push({
          text,
          expected: expectedRows.map((r) => ({ start: r.start, end: r.end })),
          actual: actualRanges,
          hasDate: evaluation.hasDate,
          path: evaluation.path,
        });
      }

      if (idx % 100 === 0 || idx === grouped.size) {
        console.log(`processed ${idx}/${grouped.size}`);
      }
    }

    const expectedDateRows = totalRows - noExpectedRows;
    console.log(`\n=== 채점 결과 (refDate: ${REFERENCE_DATE}, mode: ${RULE_ONLY ? "rule-only" : "hybrid"}) ===`);
    console.log(`전체 행:            ${totalRows}`);
    console.log(`unique text:       ${grouped.size}`);
    console.log(`기대값 없는 행 (스킵): ${noExpectedRows}`);
    console.log(`기대값 있는 행:      ${expectedDateRows}`);
    console.log(`정답 행:            ${correctRows} (${((correctRows / expectedDateRows) * 100).toFixed(1)}%)`);
    console.log(`오답 행:            ${missedRows}`);
    console.log(`부분 정답 텍스트:    ${partialCorrectRows}개`);

    // 오답 상위 30개 샘플
    console.log(`\n=== 오답 샘플 (최대 30개) ===`);
    for (const m of mismatches.slice(0, 30)) {
      console.log(`"${m.text}" [path=${m.path}, hasDate=${m.hasDate}]`);
      console.log(
        `  expected: ${m.expected.map((e) => `${e.start}~${e.end}`).join(", ")}`,
      );
      console.log(
        `  actual:   ${m.actual.map((a) => `${a.start}~${a.end}`).join(", ") || "(없음)"}`,
      );
    }

    // 오답 카테고리 분석
    console.log(`\n=== 오답 카테고리 분석 ===`);
    const noDateInQuery = mismatches.filter(
      (m) => !m.hasDate && m.actual.length === 0,
    );
    const wrongDate = mismatches.filter((m) => m.hasDate && m.actual.length > 0);
    console.log(`  날짜 전혀 감지 못 함: ${noDateInQuery.length}개`);
    console.log(`  날짜 감지했으나 값 틀림: ${wrongDate.length}개`);

    // 만약 "날짜 없음 → 오늘" 규칙을 적용한다면?
    const todayIso = REFERENCE_DATE;
    const wouldBeFixedByDefault = noDateInQuery.filter((m) =>
      m.expected.every((e) => e.start === todayIso && e.end === todayIso),
    );
    console.log(
      `  └ '오늘' 기본값 적용 시 정답으로 전환될 케이스: ${wouldBeFixedByDefault.length}개`,
    );

    const stillMissed =
      noDateInQuery.length - wouldBeFixedByDefault.length;
    console.log(
      `  └ '오늘' 기본값 적용해도 여전히 오답: ${stillMissed}개 (기간 쿼리지만 룰 미커버)`,
    );

    const wouldBeAccuracy =
      ((correctRows + wouldBeFixedByDefault.length) / expectedDateRows) * 100;
    console.log(
      `\n 💡 'defaultToToday' 옵션 추가 시 예상 정확도: ${wouldBeAccuracy.toFixed(1)}%`,
    );

    // wrong 카테고리 세부 분석
    console.log(`\n=== 값 틀림 세부 분류 ===`);
    let monthWideRange = 0;
    let wrongYear = 0;
    let wrongQuarter = 0;
    let other = 0;
    for (const m of wrongDate) {
      const exp = m.expected[0];
      const act = m.actual[0];
      if (!exp.start || !exp.end) continue;
      // 이번달 전체 vs 이번달~오늘
      if (
        act.start === exp.start &&
        act.end !== exp.end &&
        act.end.slice(0, 7) === exp.end.slice(0, 7)
      ) {
        monthWideRange++;
      } else if (act.start.slice(0, 4) !== exp.start.slice(0, 4)) {
        wrongYear++;
      } else if (
        exp.end &&
        (exp.end.slice(5, 7) === "03" || exp.end.slice(5, 7) === "12") &&
        act.end.slice(5, 7) === "12"
      ) {
        wrongQuarter++;
      } else {
        other++;
      }
    }
    console.log(`  이번달/이번년 전체 범위 반환 (기대: 오늘까지): ${monthWideRange}개`);
    console.log(`  연도 해석 오류 (YYYY년 무시): ${wrongYear}개`);
    console.log(`  분기/"초/말" 해석 오류: ${wrongQuarter}개`);
    console.log(`  기타: ${other}개`);
  }

  await main();
}

async function runProbe100(cliArgs: string[]): Promise<void> {
  const process = createProcessShim(cliArgs);

  /**
   * 100개 하드 케이스 정확도 프로브.
   * 기준일: 2026-04-18 (Saturday).
   *
   * 실행: npx tsx benchmarks/scripts/bench.ts probe-100
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

  await main();
}

async function runRealisticProbe(cliArgs: string[]): Promise<void> {
  const process = createProcessShim(cliArgs);

  type Expected =
    | { mode: "single"; value: string }
    | { mode: "range"; value: { start: string; end: string } }
    | { mode: "datetime"; value: { start: string; end: string } };

  interface Case {
    text: string;
    expected: Expected;
  }

  const REF = "2026-04-18"; // Saturday
  const TZ = "Asia/Seoul";

  // 모두 정답이 명확한 표현만 포함. "쯤/근처/늦게/매주/요즘/연휴" 등 모호 표현은 제외.
  const CASES: Case[] = [
    // 이미 통과 (회귀 감시)
    { text: "다음 주", expected: { mode: "range", value: { start: "2026-04-20", end: "2026-04-26" } } },
    { text: "다다음주 목요일 저녁", expected: { mode: "datetime", value: { start: "2026-04-30T18:00:00+09:00", end: "2026-04-30T21:00:00+09:00" } } },
    { text: "내일 새벽 1시", expected: { mode: "datetime", value: { start: "2026-04-19T01:00:00+09:00", end: "2026-04-19T01:00:00+09:00" } } },
    { text: "오늘 밤 9시", expected: { mode: "datetime", value: { start: "2026-04-18T21:00:00+09:00", end: "2026-04-18T21:00:00+09:00" } } },
    { text: "담주 화요일", expected: { mode: "single", value: "2026-04-21" } },

    // 현재 실패 — 수정 대상
    // 공휴일 ±1일
    { text: "크리스마스 전날", expected: { mode: "single", value: "2026-12-24" } },
    { text: "크리스마스 다음날", expected: { mode: "single", value: "2026-12-26" } },
    { text: "추석 다음날", expected: { mode: "single", value: "2026-09-26" } },
    { text: "설날 전날", expected: { mode: "single", value: "2026-02-16" } },

    // weekOfMonth 연도 선택 (현재 2025로 감)
    { text: "6월 첫째 주", expected: { mode: "range", value: { start: "2026-06-01", end: "2026-06-07" } } },

    // weekOfMonth + 주말 필터
    { text: "6월 첫째 주 주말", expected: { mode: "range", value: { start: "2026-06-06", end: "2026-06-07" } } },

    // 이번/다음 주말 (range 모드에서 토-일만 반환)
    { text: "이번 주 주말", expected: { mode: "range", value: { start: "2026-04-18", end: "2026-04-19" } } },
    { text: "다음 주 주말", expected: { mode: "range", value: { start: "2026-04-25", end: "2026-04-26" } } },

    // 날짜 + 기간 결합
    { text: "오늘부터 일주일간", expected: { mode: "range", value: { start: "2026-04-18", end: "2026-04-24" } } },
  ];

  function eq(a: unknown, b: unknown): boolean {
    return JSON.stringify(a) === JSON.stringify(b);
  }

  async function runOne(tc: Case) {
    const ref = parseReferenceDate(REF);
    const rule = runRules(tc.text, "auto");
    if (rule.expressions.length === 0) {
      return { pass: false, got: null as ResolvedValue | null, confidence: rule.confidence, matchedText: null as string | null };
    }

    // 첫 매치 기준 비교. 다중 매치는 탐지 안 됨.
    const matched = rule.expressions[0];
    const range = resolveExpression(matched.expression, { referenceDate: ref, timezone: TZ });
    const filter = getFilterKind(matched.expression);
    const formatted = await formatRange(range, tc.expected.mode, filter, { timezone: TZ });
    const pass = eq(formatted?.value, tc.expected.value);
    return { pass, got: formatted, confidence: rule.confidence, matchedText: matched.text };
  }

  async function main() {
    console.log(`reference=${REF}  tz=${TZ}\n`);
    let passed = 0;
    for (const tc of CASES) {
      const r = await runOne(tc);
      const badge = r.pass ? "PASS" : "FAIL";
      console.log(`[${badge}] ${tc.text}`);
      console.log(`  expect : ${tc.expected.mode}=${JSON.stringify(tc.expected.value)}`);
      if (r.got) {
        console.log(`  got    : ${r.got.mode}=${JSON.stringify(r.got.value)}   (match="${r.matchedText}", conf=${r.confidence.toFixed(2)})`);
      } else {
        console.log(`  got    : NO MATCH   (conf=${r.confidence.toFixed(2)})`);
      }
      if (r.pass) passed++;
    }
    const pct = ((passed / CASES.length) * 100).toFixed(1);
    console.log(`\n${passed}/${CASES.length} (${pct}%)`);
    process.exit(passed === CASES.length ? 0 : 1);
  }

  await main();
}

async function runRealisticRule100(cliArgs: string[]): Promise<void> {
  const process = createProcessShim(cliArgs);

  type RangeExp = { start: string; end: string };

  interface Case {
    id: number;
    category: string;
    text: string;
    mode: OutputMode;
    expectNone?: boolean;
    expectedRanges?: RangeExp[];
    expectedList?: string[];
    expectedListContains?: string[];
    expectedCount?: number;
    note?: string;
  }

  interface Result {
    tc: Case;
    pass: boolean;
    reason: string;
    path: "full" | "partial" | "no_match";
    actualSummary: string;
  }

  const REF_ISO = "2026-04-18";
  const TZ = "Asia/Seoul";
  const OFFSET = "+09:00";
  const REF = parseISO(`${REF_ISO}T00:00:00`);
  const REF_DATE = parseReferenceDate(REF_ISO);

  function fmt(date: Date): string {
    return format(date, "yyyy-MM-dd");
  }

  function dayRange(date: Date): RangeExp {
    return { start: fmt(date), end: fmt(date) };
  }

  function exactDay(year: number, month: number, day: number): RangeExp {
    return dayRange(new Date(year, month - 1, day));
  }

  function range(start: Date, end: Date): RangeExp {
    return { start: fmt(start), end: fmt(end) };
  }

  function weekRange(offset: number): RangeExp {
    const base = addWeeks(REF, offset);
    return range(
      startOfWeek(base, { weekStartsOn: 1 }),
      endOfWeek(base, { weekStartsOn: 1 }),
    );
  }

  function monthRange(offset: number): RangeExp {
    const base = addMonths(REF, offset);
    return range(startOfMonth(base), endOfMonth(base));
  }

  function yearRange(offset: number): RangeExp {
    const base = addYears(REF, offset);
    return range(startOfYear(base), endOfYear(base));
  }

  function explicitMonthRange(year: number, month: number): RangeExp {
    const base = new Date(year, month - 1, 1);
    return range(startOfMonth(base), endOfMonth(base));
  }

  function explicitYearRange(year: number): RangeExp {
    const base = new Date(year, 0, 1);
    return range(startOfYear(base), endOfYear(base));
  }

  function explicitRange(
    sy: number,
    sm: number,
    sd: number,
    ey: number,
    em: number,
    ed: number,
  ): RangeExp {
    return range(new Date(sy, sm - 1, sd), new Date(ey, em - 1, ed));
  }

  function quarterRange(year: number, quarter: 1 | 2 | 3 | 4): RangeExp {
    const startMonth = (quarter - 1) * 3;
    const start = new Date(year, startMonth, 1);
    return range(startOfQuarter(start), endOfQuarter(start));
  }

  function quarterPartRange(
    year: number,
    quarter: 1 | 2 | 3 | 4,
    part: "early" | "late",
  ): RangeExp {
    const startMonth = (quarter - 1) * 3;
    if (part === "early") {
      return explicitRange(year, startMonth + 1, 1, year, startMonth + 1, 10);
    }
    const endMonth = startMonth + 3;
    const lastDay = endOfMonth(new Date(year, endMonth - 1, 1)).getDate();
    return explicitRange(year, endMonth, 21, year, endMonth, lastDay);
  }

  function halfRange(year: number, half: 1 | 2): RangeExp {
    const startMonth = half === 1 ? 1 : 7;
    const endMonth = half === 1 ? 6 : 12;
    return explicitRange(
      year,
      startMonth,
      1,
      year,
      endMonth,
      endOfMonth(new Date(year, endMonth - 1, 1)).getDate(),
    );
  }

  function yearPartRange(year: number, part: "early" | "late"): RangeExp {
    return part === "early"
      ? explicitRange(year, 1, 1, year, 3, 31)
      : explicitRange(year, 10, 1, year, 12, 31);
  }

  function monthPartRange(
    year: number,
    month: number,
    part: "start" | "end" | "mid",
  ): RangeExp {
    if (part === "start") return exactDay(year, month, 1);
    if (part === "mid") return explicitRange(year, month, 11, year, month, 20);
    const lastDay = endOfMonth(new Date(year, month - 1, 1)).getDate();
    return exactDay(year, month, lastDay);
  }

  function weekOfMonthRange(
    year: number,
    month: number,
    week: 1 | 2 | 3 | 4 | 5,
  ): RangeExp {
    const startDay = (week - 1) * 7 + 1;
    const lastDay = endOfMonth(new Date(year, month - 1, 1)).getDate();
    const endDay = week === 5 ? lastDay : Math.min(startDay + 6, lastDay);
    return explicitRange(year, month, startDay, year, month, endDay);
  }

  function dateTimeRange(
    year: number,
    month: number,
    day: number,
    startHour: number,
    startMinute: number,
    endHour: number,
    endMinute: number,
    endSecond = 0,
  ): RangeExp {
    const date = `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    const start = `${date}T${String(startHour).padStart(2, "0")}:${String(startMinute).padStart(2, "0")}:00${OFFSET}`;
    const end = `${date}T${String(endHour).padStart(2, "0")}:${String(endMinute).padStart(2, "0")}:${String(endSecond).padStart(2, "0")}${OFFSET}`;
    return { start, end };
  }

  function pointTime(
    year: number,
    month: number,
    day: number,
    hour: number,
    minute = 0,
  ): RangeExp {
    return dateTimeRange(year, month, day, hour, minute, hour, minute, 0);
  }

  function countWeekdays(start: Date, end: Date): number {
    let count = 0;
    for (
      let cur = new Date(start.getFullYear(), start.getMonth(), start.getDate());
      cur <= end;
      cur = addDays(cur, 1)
    ) {
      const day = cur.getDay();
      if (day >= 1 && day <= 5) count++;
    }
    return count;
  }

  const cases: Case[] = [
    // 1. 일상 단일일
    { id: 1, category: "1.named_day", text: "오늘 입금 내역 보여줘", mode: "range", expectedRanges: [dayRange(REF)] },
    { id: 2, category: "1.named_day", text: "어제 카드 승인건만 찾아줘", mode: "range", expectedRanges: [dayRange(addDays(REF, -1))] },
    { id: 3, category: "1.named_day", text: "그저께 거래내역 보여줘", mode: "range", expectedRanges: [dayRange(addDays(REF, -2))] },
    { id: 4, category: "1.named_day", text: "엊그제 뭐 나갔는지 봐줘", mode: "range", expectedRanges: [dayRange(addDays(REF, -2))] },
    { id: 5, category: "1.named_day", text: "내일 일정 다시 알려줘", mode: "range", expectedRanges: [dayRange(addDays(REF, 1))] },
    { id: 6, category: "1.named_day", text: "모레 미팅 잡아줘", mode: "range", expectedRanges: [dayRange(addDays(REF, 2))] },
    { id: 7, category: "1.named_day", text: "글피 일정 비워놔", mode: "range", expectedRanges: [dayRange(addDays(REF, 3))] },
    { id: 8, category: "1.named_day", text: "그글피에 출국이야", mode: "range", expectedRanges: [dayRange(addDays(REF, 4))] },
    { id: 9, category: "1.named_day", text: "작년 오늘 매출 어땠어?", mode: "range", expectedRanges: [dayRange(addYears(REF, -1))] },
    { id: 10, category: "1.named_day", text: "내년 오늘은 무슨 요일이야?", mode: "range", expectedRanges: [dayRange(addYears(REF, 1))] },

    // 2. 상대 오프셋
    { id: 11, category: "2.offset", text: "하루 전 알림만 보여줘", mode: "range", expectedRanges: [dayRange(addDays(REF, -1))] },
    { id: 12, category: "2.offset", text: "이틀 전 문의 다시 찾아줘", mode: "range", expectedRanges: [dayRange(addDays(REF, -2))] },
    { id: 13, category: "2.offset", text: "사흘 전 로그 확인해줘", mode: "range", expectedRanges: [dayRange(addDays(REF, -3))] },
    { id: 14, category: "2.offset", text: "나흘 뒤 일정 잡아줘", mode: "range", expectedRanges: [dayRange(addDays(REF, 4))] },
    { id: 15, category: "2.offset", text: "보름 전 데이터 보여줘", mode: "range", expectedRanges: [dayRange(addDays(REF, -15))] },
    { id: 16, category: "2.offset", text: "7일 전 매출만 보자", mode: "range", expectedRanges: [dayRange(addDays(REF, -7))] },
    { id: 17, category: "2.offset", text: "3일 뒤 배송 예정이야", mode: "range", expectedRanges: [dayRange(addDays(REF, 3))] },
    { id: 18, category: "2.offset", text: "2주 전 회의록 찾아줘", mode: "range", expectedRanges: [dayRange(addDays(REF, -14))] },
    { id: 19, category: "2.offset", text: "1개월 전 잔액 확인해줘", mode: "range", expectedRanges: [dayRange(addMonths(REF, -1))] },
    { id: 20, category: "2.offset", text: "2개월 뒤 만기 상품 보여줘", mode: "range", expectedRanges: [dayRange(addMonths(REF, 2))] },

    // 3. 주 / 요일
    { id: 21, category: "3.week", text: "지난주 매출 비교해줘", mode: "range", expectedRanges: [weekRange(-1)] },
    { id: 22, category: "3.week", text: "이번주 일정 한 번에 보여줘", mode: "range", expectedRanges: [weekRange(0)] },
    { id: 23, category: "3.week", text: "다음주 회의 잡아줘", mode: "range", expectedRanges: [weekRange(1)] },
    { id: 24, category: "3.week", text: "저저번주 이슈 정리해줘", mode: "range", expectedRanges: [weekRange(-2)] },
    { id: 25, category: "3.week", text: "다다음 주 휴가 계획 짜야 해", mode: "range", expectedRanges: [weekRange(2)] },
    { id: 26, category: "3.week", text: "이번주 월요일 입금건만 봐줘", mode: "range", expectedRanges: [exactDay(2026, 4, 13)] },
    { id: 27, category: "3.week", text: "지난주 금요일 회의 메모 찾아줘", mode: "range", expectedRanges: [exactDay(2026, 4, 10)] },
    { id: 28, category: "3.week", text: "다음주 화요일 가능해?", mode: "range", expectedRanges: [exactDay(2026, 4, 21)] },
    { id: 29, category: "3.week", text: "담주 목요일로 옮겨줘", mode: "range", expectedRanges: [exactDay(2026, 4, 23)] },
    { id: 30, category: "3.week", text: "이번주 토요일 일정 다시 보여줘", mode: "range", expectedRanges: [exactDay(2026, 4, 18)] },

    // 4. 월 / 연 / 복수
    { id: 31, category: "4.month_year", text: "지난달 매출만 보여줘", mode: "range", expectedRanges: [monthRange(-1)] },
    { id: 32, category: "4.month_year", text: "이번달 지출 추이 봐줘", mode: "range", expectedRanges: [monthRange(0)] },
    { id: 33, category: "4.month_year", text: "다음달 일정 미리 볼래", mode: "range", expectedRanges: [monthRange(1)] },
    { id: 34, category: "4.month_year", text: "저저번달 정산서 찾아줘", mode: "range", expectedRanges: [monthRange(-2)] },
    { id: 35, category: "4.month_year", text: "다다음 달 휴가비 계산해줘", mode: "range", expectedRanges: [monthRange(2)] },
    { id: 36, category: "4.month_year", text: "작년 실적 다시 보여줘", mode: "range", expectedRanges: [yearRange(-1)] },
    { id: 37, category: "4.month_year", text: "올해 목표 대비 얼마야?", mode: "range", expectedRanges: [yearRange(0)] },
    { id: 38, category: "4.month_year", text: "내년 예산 짜야 해", mode: "range", expectedRanges: [yearRange(1)] },
    { id: 39, category: "4.month_year", text: "재작년 자료도 같이 보여줘", mode: "range", expectedRanges: [yearRange(-2)] },
    {
      id: 40,
      category: "4.month_year",
      text: "3월이랑 4월 매출 비교해줘",
      mode: "range",
      expectedRanges: [explicitMonthRange(2026, 3), explicitMonthRange(2026, 4)],
    },

    // 5. 절대 날짜
    { id: 41, category: "5.absolute", text: "2025-12-25 일정 있어?", mode: "range", expectedRanges: [exactDay(2025, 12, 25)] },
    { id: 42, category: "5.absolute", text: "2026/05/01 휴무 맞지?", mode: "range", expectedRanges: [exactDay(2026, 5, 1)] },
    { id: 43, category: "5.absolute", text: "2026.03.15 매출만 뽑아줘", mode: "range", expectedRanges: [exactDay(2026, 3, 15)] },
    { id: 44, category: "5.absolute", text: "2025년 3월 1일에 뭐 했지?", mode: "range", expectedRanges: [exactDay(2025, 3, 1)] },
    { id: 45, category: "5.absolute", text: "2024년 2월 29일 로그 보여줘", mode: "range", expectedRanges: [exactDay(2024, 2, 29)] },
    { id: 46, category: "5.absolute", text: "2026년 4월 18일 회의였지?", mode: "range", expectedRanges: [exactDay(2026, 4, 18)] },
    { id: 47, category: "5.absolute", text: "20250412 거래내역", mode: "range", expectedRanges: [exactDay(2025, 4, 12)] },
    { id: 48, category: "5.absolute", text: "20241231 결산 자료", mode: "range", expectedRanges: [exactDay(2024, 12, 31)] },
    {
      id: 49,
      category: "5.absolute",
      text: "12월 25일 휴무 맞아?",
      mode: "range",
      expectedRanges: [exactDay(2026, 12, 25)],
      note: "사람 기준으로는 다가오는 2026-12-25 기대",
    },
    {
      id: 50,
      category: "5.absolute",
      text: "5월 5일 쉬는 날이지?",
      mode: "range",
      expectedRanges: [exactDay(2026, 5, 5)],
      note: "사람 기준으로는 다가오는 2026-05-05 기대",
    },

    // 6. 명시적 범위
    { id: 51, category: "6.range", text: "3월 1일부터 3월 5일까지 출장", mode: "range", expectedRanges: [explicitRange(2026, 3, 1, 2026, 3, 5)] },
    { id: 52, category: "6.range", text: "2025년 3월 1일부터 5일까지 기록", mode: "range", expectedRanges: [explicitRange(2025, 3, 1, 2025, 3, 5)] },
    { id: 53, category: "6.range", text: "4월 1일부터 4월 18일까지 매출", mode: "range", expectedRanges: [explicitRange(2026, 4, 1, 2026, 4, 18)] },
    { id: 54, category: "6.range", text: "2026년 4월 10일부터 2026년 4월 12일까지", mode: "range", expectedRanges: [explicitRange(2026, 4, 10, 2026, 4, 12)] },
    { id: 55, category: "6.range", text: "2026년 5월 1일부터 2026년 5월 7일까지", mode: "range", expectedRanges: [explicitRange(2026, 5, 1, 2026, 5, 7)] },
    { id: 56, category: "6.range", text: "3월 1일부터 5월 31일까지 실적 비교", mode: "range", expectedRanges: [explicitRange(2026, 3, 1, 2026, 5, 31)] },
    { id: 57, category: "6.range", text: "2024년 12월 30일부터 2025년 1월 2일까지", mode: "range", expectedRanges: [explicitRange(2024, 12, 30, 2025, 1, 2)] },
    { id: 58, category: "6.range", text: "2026년 2월 1일부터 7일까지 휴가", mode: "range", expectedRanges: [explicitRange(2026, 2, 1, 2026, 2, 7)] },
    { id: 59, category: "6.range", text: "2026년 11월 29일부터 12월 3일까지", mode: "range", expectedRanges: [explicitRange(2026, 11, 29, 2026, 12, 3)] },
    { id: 60, category: "6.range", text: "2025년 1월 1일부터 2025년 12월 31일까지", mode: "range", expectedRanges: [explicitRange(2025, 1, 1, 2025, 12, 31)] },

    // 7. 기간 일부 / 분기 / 반기
    { id: 61, category: "7.parts", text: "이번달 초 매출", mode: "range", expectedRanges: [monthPartRange(2026, 4, "start")] },
    { id: 62, category: "7.parts", text: "지난달 말 잔액", mode: "range", expectedRanges: [monthPartRange(2026, 3, "end")] },
    { id: 63, category: "7.parts", text: "3월 중순 매출", mode: "range", expectedRanges: [monthPartRange(2026, 3, "mid")] },
    {
      id: 64,
      category: "7.parts",
      text: "6월 첫째주 일정",
      mode: "range",
      expectedRanges: [weekOfMonthRange(2026, 6, 1)],
      note: "일반 사용자라면 보통 다가오는 2026년 6월로 이해",
    },
    { id: 65, category: "7.parts", text: "다음달 둘째주 보고서", mode: "range", expectedRanges: [weekOfMonthRange(2026, 5, 2)] },
    { id: 66, category: "7.parts", text: "올해 2분기 실적", mode: "range", expectedRanges: [quarterRange(2026, 2)] },
    { id: 67, category: "7.parts", text: "작년 4분기 실적", mode: "range", expectedRanges: [quarterRange(2025, 4)] },
    { id: 68, category: "7.parts", text: "상반기 누적 매출", mode: "range", expectedRanges: [halfRange(2026, 1)] },
    { id: 69, category: "7.parts", text: "내년 1분기 초 실적", mode: "range", expectedRanges: [quarterPartRange(2027, 1, "early")] },
    { id: 70, category: "7.parts", text: "올해 초 실적", mode: "range", expectedRanges: [yearPartRange(2026, "early")] },

    // 8. 필터 / 공휴일
    {
      id: 71,
      category: "8.filter",
      text: "이번 주 영업일만 보여줘",
      mode: "business_days",
      expectedList: ["2026-04-13", "2026-04-14", "2026-04-15", "2026-04-16", "2026-04-17"],
    },
    {
      id: 72,
      category: "8.filter",
      text: "다음주 영업일 알려줘",
      mode: "business_days",
      expectedList: ["2026-04-20", "2026-04-21", "2026-04-22", "2026-04-23", "2026-04-24"],
    },
    { id: 73, category: "8.filter", text: "이번달 공휴일 있어?", mode: "holidays", expectedList: [] },
    {
      id: 74,
      category: "8.filter",
      text: "다음달 공휴일만 보여줘",
      mode: "holidays",
      expectedList: ["2026-05-05", "2026-05-24", "2026-05-25"],
    },
    {
      id: 75,
      category: "8.filter",
      text: "작년 공휴일 정리해줘",
      mode: "holidays",
      expectedListContains: ["2025-01-01", "2025-05-05", "2025-12-25"],
    },
    {
      id: 76,
      category: "8.filter",
      text: "이번달 평일만 뽑아줘",
      mode: "weekdays",
      expectedCount: countWeekdays(startOfMonth(REF), endOfMonth(REF)),
    },
    {
      id: 77,
      category: "8.filter",
      text: "다음달 평일 기준으로 보여줘",
      mode: "weekdays",
      expectedCount: countWeekdays(
        startOfMonth(addMonths(REF, 1)),
        endOfMonth(addMonths(REF, 1)),
      ),
    },
    {
      id: 78,
      category: "8.filter",
      text: "이번주 주말 일정",
      mode: "list",
      expectedList: ["2026-04-18", "2026-04-19"],
    },
    {
      id: 79,
      category: "8.filter",
      text: "다음주 주말 예약",
      mode: "list",
      expectedList: ["2026-04-25", "2026-04-26"],
    },
    {
      id: 80,
      category: "8.filter",
      text: "2026년 공휴일 달력 보여줘",
      mode: "holidays",
      expectedListContains: ["2026-02-17", "2026-05-05", "2026-09-25", "2026-12-25"],
    },

    // 9. 시간 / datetime
    { id: 81, category: "9.datetime", text: "오늘 오후 3시에 미팅 잡아줘", mode: "datetime", expectedRanges: [pointTime(2026, 4, 18, 15)] },
    { id: 82, category: "9.datetime", text: "내일 오전 9시 30분에 깨워줘", mode: "datetime", expectedRanges: [pointTime(2026, 4, 19, 9, 30)] },
    { id: 83, category: "9.datetime", text: "새벽 2시에 알림 줘", mode: "datetime", expectedRanges: [pointTime(2026, 4, 18, 2)] },
    { id: 84, category: "9.datetime", text: "오늘 저녁에 통화 가능해?", mode: "datetime", expectedRanges: [dateTimeRange(2026, 4, 18, 18, 0, 21, 0)] },
    { id: 85, category: "9.datetime", text: "오전 9시부터 11시까지 비워줘", mode: "datetime", expectedRanges: [dateTimeRange(2026, 4, 18, 9, 0, 11, 0)] },
    { id: 86, category: "9.datetime", text: "15:30에 다시 연락줘", mode: "datetime", expectedRanges: [pointTime(2026, 4, 18, 15, 30)] },
    { id: 87, category: "9.datetime", text: "다음주 월요일 오전 10시 회의 잡아줘", mode: "datetime", expectedRanges: [pointTime(2026, 4, 20, 10)] },
    { id: 88, category: "9.datetime", text: "2025-12-25 오후 3시 일정", mode: "datetime", expectedRanges: [pointTime(2025, 12, 25, 15)] },
    { id: 89, category: "9.datetime", text: "내일 저녁에 전화해줘", mode: "datetime", expectedRanges: [dateTimeRange(2026, 4, 19, 18, 0, 21, 0)] },
    { id: 90, category: "9.datetime", text: "오늘 밤 9시에 출발해", mode: "datetime", expectedRanges: [pointTime(2026, 4, 18, 21)] },

    // 10. 영어 / 노데이트
    { id: 91, category: "10.mixed", text: "last month sales 보여줘", mode: "range", expectedRanges: [monthRange(-1)] },
    { id: 92, category: "10.mixed", text: "next Friday 미팅 가능?", mode: "range", expectedRanges: [exactDay(2026, 4, 24)] },
    { id: 93, category: "10.mixed", text: "3 days ago 로그 봐줘", mode: "range", expectedRanges: [exactDay(2026, 4, 15)] },
    { id: 94, category: "10.mixed", text: "tomorrow morning call 해줘", mode: "datetime", expectedRanges: [dateTimeRange(2026, 4, 19, 6, 0, 12, 0)] },
    { id: 95, category: "10.mixed", text: "from 9am to 5pm 운영 시간", mode: "datetime", expectedRanges: [dateTimeRange(2026, 4, 18, 9, 0, 17, 0)] },
    { id: 96, category: "10.mixed", text: "잔액 큰 계좌만 보여줘", mode: "range", expectNone: true },
    { id: 97, category: "10.mixed", text: "카드 한도만 알려줘", mode: "range", expectNone: true },
    { id: 98, category: "10.mixed", text: "환율 알림 설정해줘", mode: "range", expectNone: true },
    { id: 99, category: "10.mixed", text: "미수금 많은 거래처만 보여줘", mode: "range", expectNone: true },
    { id: 100, category: "10.mixed", text: "로그인 안 되는 계정만 찾아줘", mode: "range", expectNone: true },
  ];

  function summarizeRanges(items: RangeExp[]): string {
    return items.map((v) => `${v.start}~${v.end}`).join(" | ") || "(none)";
  }

  function summarizeList(items: string[]): string {
    if (items.length === 0) return "[]";
    if (items.length <= 6) return `[${items.join(", ")}]`;
    return `[${items.slice(0, 6).join(", ")}, ...] (${items.length})`;
  }

  function classifyPath(confidence: number, count: number): "full" | "partial" | "no_match" {
    if (count === 0) return "no_match";
    return confidence >= 1 ? "full" : "partial";
  }

  function sameRanges(expected: RangeExp[], actual: RangeExp[]): boolean {
    if (expected.length !== actual.length) return false;
    const used = new Set<number>();
    for (const exp of expected) {
      const idx = actual.findIndex(
        (item, i) =>
          !used.has(i) &&
          item.start === exp.start &&
          item.end === exp.end,
      );
      if (idx < 0) return false;
      used.add(idx);
    }
    return true;
  }

  function sameList(expected: string[], actual: string[]): boolean {
    return (
      expected.length === actual.length &&
      expected.every((item, idx) => item === actual[idx])
    );
  }

  async function runOne(tc: Case): Promise<Result> {
    const rule = runRules(tc.text, "auto");
    const path = classifyPath(rule.confidence, rule.expressions.length);

    if (tc.expectNone) {
      const pass = rule.expressions.length === 0;
      return {
        tc,
        pass,
        reason: pass ? "ok" : "expected no date but got match",
        path,
        actualSummary:
          rule.expressions.length === 0
            ? "(none)"
            : rule.expressions.map((expr) => expr.text).join(" | "),
      };
    }

    if (rule.expressions.length === 0) {
      return {
        tc,
        pass: false,
        reason: "no rule match",
        path,
        actualSummary: "(none)",
      };
    }

    if (tc.mode === "range" || tc.mode === "datetime") {
      const actuals: RangeExp[] = [];
      for (const expr of rule.expressions) {
        const resolved = resolveExpression(expr.expression, {
          referenceDate: REF_DATE,
          timezone: TZ,
        });
        const formatted = await formatRange(
          resolved,
          tc.mode,
          getFilterKind(expr.expression),
          {
            timezone: TZ,
            dateOnlyForDateModes: false,
          },
        );
        if (
          formatted &&
          (formatted.mode === "range" || formatted.mode === "datetime")
        ) {
          actuals.push(formatted.value);
        }
      }
      const pass = sameRanges(tc.expectedRanges ?? [], actuals);
      return {
        tc,
        pass,
        reason: pass
          ? "ok"
          : `expected ${summarizeRanges(tc.expectedRanges ?? [])}`,
        path,
        actualSummary: summarizeRanges(actuals),
      };
    }

    if (
      tc.mode === "business_days" ||
      tc.mode === "weekdays" ||
      tc.mode === "holidays" ||
      tc.mode === "list"
    ) {
      const actual: string[] = [];
      for (const expr of rule.expressions) {
        const resolved = resolveExpression(expr.expression, {
          referenceDate: REF_DATE,
          timezone: TZ,
        });
        const formatted = await formatRange(
          resolved,
          tc.mode,
          getFilterKind(expr.expression),
          {
            timezone: TZ,
            dateOnlyForDateModes: true,
          },
        );
        if (
          formatted &&
          (formatted.mode === "business_days" ||
            formatted.mode === "weekdays" ||
            formatted.mode === "holidays" ||
            formatted.mode === "list")
        ) {
          actual.push(...formatted.value);
        }
      }

      if (tc.expectedList) {
        const pass = sameList(tc.expectedList, actual);
        return {
          tc,
          pass,
          reason: pass ? "ok" : `expected ${summarizeList(tc.expectedList)}`,
          path,
          actualSummary: summarizeList(actual),
        };
      }

      if (tc.expectedListContains) {
        const missing = tc.expectedListContains.filter(
          (item) => !actual.includes(item),
        );
        const pass = missing.length === 0;
        return {
          tc,
          pass,
          reason: pass ? "ok" : `missing ${missing.join(", ")}`,
          path,
          actualSummary: summarizeList(actual),
        };
      }

      if (tc.expectedCount !== undefined) {
        const pass = actual.length === tc.expectedCount;
        return {
          tc,
          pass,
          reason: pass ? "ok" : `expected count ${tc.expectedCount}`,
          path,
          actualSummary: `count=${actual.length}`,
        };
      }
    }

    return {
      tc,
      pass: false,
      reason: "unsupported expectation",
      path,
      actualSummary: "(n/a)",
    };
  }

  async function main() {
    const results: Result[] = [];
    for (const tc of cases) {
      results.push(await runOne(tc));
    }

    const total = results.length;
    const passed = results.filter((r) => r.pass).length;
    const failed = results.filter((r) => !r.pass);

    console.log(`referenceDate=${REF_ISO} timezone=${TZ}`);
    console.log(`rule-only realistic benchmark`);
    console.log(`overall: ${passed}/${total} (${((passed / total) * 100).toFixed(1)}%)`);

    const byCategory = new Map<string, { total: number; pass: number }>();
    for (const result of results) {
      const bucket = byCategory.get(result.tc.category) ?? { total: 0, pass: 0 };
      bucket.total += 1;
      if (result.pass) bucket.pass += 1;
      byCategory.set(result.tc.category, bucket);
    }

    console.log(`\nby category:`);
    for (const [category, stat] of [...byCategory.entries()].sort()) {
      console.log(
        `  ${category.padEnd(14)} ${String(stat.pass).padStart(2)}/${stat.total} (${((stat.pass / stat.total) * 100).toFixed(0)}%)`,
      );
    }

    const byPath = new Map<string, { total: number; pass: number }>();
    for (const result of results) {
      const bucket = byPath.get(result.path) ?? { total: 0, pass: 0 };
      bucket.total += 1;
      if (result.pass) bucket.pass += 1;
      byPath.set(result.path, bucket);
    }

    console.log(`\nby path:`);
    for (const [path, stat] of [...byPath.entries()].sort()) {
      console.log(
        `  ${path.padEnd(14)} ${String(stat.pass).padStart(2)}/${stat.total} (${((stat.pass / stat.total) * 100).toFixed(0)}%)`,
      );
    }

    if (failed.length > 0) {
      console.log(`\nfailures (${failed.length}):`);
      for (const result of failed) {
        console.log(
          `  #${String(result.tc.id).padStart(3, " ")} [${result.tc.category}] ${result.tc.text}`,
        );
        console.log(`     expected: ${result.reason.replace(/^expected /, "")}`);
        console.log(`     actual  : ${result.actualSummary} (${result.path})`);
        if (result.tc.note) console.log(`     note    : ${result.tc.note}`);
      }
    }
  }

  await main();
}

async function runGenerateCsvStyle(cliArgs: string[]): Promise<void> {
  const process = createProcessShim(cliArgs);

  type RangeSpec = {
    text: string;
    start: string;
    end: string;
  };

  type Row = {
    text: string;
    final_start_date: string;
    final_end_date: string;
  };

  const REFERENCE_DATE = "2025-11-17";
  const ref = parseISO(`${REFERENCE_DATE}T00:00:00`);

  const outputPath = path.join(datasetsDir, "csv-style-mimic-1000.csv");

  const products = [
    "예적금",
    "대출",
    "외화",
    "증권",
    "신탁",
    "수시입출",
    "정기예금",
    "적금",
    "보통예금",
    "달러 예수금",
  ];

  const productGroups = [
    ["외화", "대출"],
    ["수시입출", "예적금"],
    ["증권", "신탁"],
    ["외화", "증권"],
    ["예적금", "대출"],
    ["수시입출", "외화"],
  ];

  const companies = [
    "웹케시",
    "삼성전자",
    "빙그레",
    "원티드랩",
    "네이버",
    "카카오",
    "현대차",
    "LG전자",
    "기업은행",
    "신한은행",
  ];

  const costLabels = [
    "임대료",
    "마케팅 비용",
    "연구비",
    "인건비",
    "운영비",
    "광고비",
    "복리후생비",
    "출장비",
    "서버비",
    "수수료",
  ];

  const costTriples = [
    ["연구비", "인건비", "마케팅비"],
    ["임대료", "광고비", "운영비"],
    ["복리후생비", "출장비", "서버비"],
    ["인건비", "수수료", "광고비"],
  ];

  const amounts = [
    "1,000만원",
    "4,000만원",
    "7,000만원",
    "1억원",
    "2억원",
    "6억원",
    "9억원",
    "5천만원",
  ];

  function ymd(date: Date): string {
    return format(date, "yyyy-MM-dd");
  }

  function clampIfCurrent(start: Date, end: Date): { start: string; end: string } {
    if (start <= ref && end >= ref) {
      return { start: ymd(start), end: REFERENCE_DATE };
    }
    return { start: ymd(start), end: ymd(end) };
  }

  function daySpec(text: string, offsetDays: number): RangeSpec {
    const d = addDays(ref, offsetDays);
    const iso = ymd(d);
    return { text, start: iso, end: iso };
  }

  function weekOffsetSpec(text: string, offsetWeeks: number): RangeSpec {
    const d = addWeeks(ref, offsetWeeks);
    const start = startOfWeek(d, { weekStartsOn: 1 });
    const end = endOfWeek(d, { weekStartsOn: 1 });
    const r = clampIfCurrent(start, end);
    return { text, ...r };
  }

  function monthOffsetSpec(text: string, offsetMonths: number): RangeSpec {
    const d = addMonths(ref, offsetMonths);
    const start = startOfMonth(d);
    const end = endOfMonth(d);
    const r = clampIfCurrent(start, end);
    return { text, ...r };
  }

  function monthOnlyPastSpec(text: string, month: number): RangeSpec {
    let year = ref.getFullYear();
    const candidate = new Date(year, month - 1, 1);
    if (candidate > ref) year -= 1;
    const start = new Date(year, month - 1, 1);
    const end = endOfMonth(start);
    return { text, start: ymd(start), end: ymd(end) };
  }

  function quarterSpec(
    text: string,
    year: number,
    quarter: 1 | 2 | 3 | 4,
  ): RangeSpec {
    const start = new Date(year, (quarter - 1) * 3, 1);
    const end = endOfQuarter(start);
    const r = clampIfCurrent(start, end);
    return { text, ...r };
  }

  function quarterOffsetSpec(text: string, offsetQuarters: number): RangeSpec {
    const currentQuarterStart = startOfQuarter(ref);
    const targetStart = addMonths(currentQuarterStart, offsetQuarters * 3);
    const end = endOfQuarter(targetStart);
    const r = clampIfCurrent(targetStart, end);
    return { text, ...r };
  }

  function yearOffsetSpec(text: string, offsetYears: number): RangeSpec {
    const targetYear = ref.getFullYear() + offsetYears;
    const start = startOfYear(new Date(targetYear, 0, 1));
    const end = endOfYear(start);
    const r = clampIfCurrent(start, end);
    return { text, ...r };
  }

  function halfSpec(
    text: string,
    year: number,
    half: 1 | 2,
  ): RangeSpec {
    const startMonth = half === 1 ? 0 : 6;
    const start = new Date(year, startMonth, 1);
    const end = endOfMonth(new Date(year, startMonth + 5, 1));
    const r = clampIfCurrent(start, end);
    return { text, ...r };
  }

  function monthYearSpec(text: string, year: number, month: number): RangeSpec {
    const start = new Date(year, month - 1, 1);
    const end = endOfMonth(start);
    const r = clampIfCurrent(start, end);
    return { text, ...r };
  }

  function monthPartSpec(
    text: string,
    year: number,
    month: number,
    part: "early" | "end",
  ): RangeSpec {
    if (part === "early") {
      return {
        text,
        start: `${year}-${String(month).padStart(2, "0")}-01`,
        end: `${year}-${String(month).padStart(2, "0")}-10`,
      };
    }
    const lastDay = endOfMonth(new Date(year, month - 1, 1)).getDate();
    const iso = `${year}-${String(month).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`;
    return { text, start: iso, end: iso };
  }

  function yearPartSpec(
    text: string,
    year: number,
    part: "early" | "late",
  ): RangeSpec {
    if (part === "early") {
      return {
        text,
        start: `${year}-01-01`,
        end: `${year}-03-31`,
      };
    }
    return {
      text,
      start: `${year}-10-01`,
      end: `${year}-12-31`,
    };
  }

  function firstWeekSpec(text: string, year: number, month: number): RangeSpec {
    return {
      text,
      start: `${year}-${String(month).padStart(2, "0")}-01`,
      end: `${year}-${String(month).padStart(2, "0")}-07`,
    };
  }

  function durationMonthsSpec(text: string, months: number): RangeSpec {
    return {
      text,
      start: ymd(addMonths(ref, -months)),
      end: REFERENCE_DATE,
    };
  }

  function durationYearsSpec(text: string, years: number): RangeSpec {
    return {
      text,
      start: ymd(addYears(ref, -years)),
      end: REFERENCE_DATE,
    };
  }

  function absoluteDaySpec(text: string, year: number, month: number, day: number): RangeSpec {
    const iso = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    return { text, start: iso, end: iso };
  }

  function csvEscape(value: string): string {
    if (/[",\n]/.test(value)) {
      return `"${value.replace(/"/g, '""')}"`;
    }
    return value;
  }

  const genericDateSpecs: RangeSpec[] = [
    daySpec("오늘", 0),
    daySpec("어제", -1),
    daySpec("그제", -2),
    daySpec("그저께", -2),
    daySpec("엊그제", -2),
    daySpec("사흘전", -3),
    daySpec("나흘전", -4),
    daySpec("보름전", -15),
    daySpec("일주일 전", -7),
    weekOffsetSpec("지난주", -1),
    weekOffsetSpec("이번 주", 0),
    monthOffsetSpec("지난달", -1),
    monthOffsetSpec("저번달", -1),
    monthOffsetSpec("이번달", 0),
    monthOnlyPastSpec("3월", 3),
    monthOnlyPastSpec("8월", 8),
    yearOffsetSpec("올해", 0),
    yearOffsetSpec("작년", -1),
    yearOffsetSpec("재작년", -2),
    quarterSpec("1분기", 2025, 1),
    quarterSpec("2분기", 2025, 2),
    quarterSpec("4분기", 2025, 4),
    quarterOffsetSpec("이번분기", 0),
    quarterOffsetSpec("지난분기", -1),
    halfSpec("하반기", 2025, 2),
    halfSpec("지난 상반기", 2025, 1),
    yearOffsetSpec("2023년", -2),
    monthYearSpec("2024년 2월", 2024, 2),
    durationMonthsSpec("최근 6개월간", 6),
    durationYearsSpec("지난 1년간", 1),
  ];

  const lifecycleDateSpecs: RangeSpec[] = [
    yearPartSpec("2032년 초", 2032, "early"),
    yearPartSpec("2029년 말", 2029, "late"),
    monthPartSpec("2024년 7월 말", 2024, 7, "end"),
    monthPartSpec("2023년 1월 초", 2023, 1, "early"),
    monthYearSpec("2020년 2월", 2020, 2),
    monthPartSpec("2014년 7월 말", 2014, 7, "end"),
    monthYearSpec("2026년 3월", 2026, 3),
    firstWeekSpec("2027년 2월 첫 주", 2027, 2),
    monthYearSpec("2024년 5월", 2024, 5),
    monthYearSpec("2023년 12월", 2023, 12),
    halfSpec("2028년 상반기", 2028, 1),
    halfSpec("2028년 하반기", 2028, 2),
    quarterSpec("내년 1분기", 2026, 1),
    quarterSpec("내년 2분기", 2026, 2),
    quarterSpec("2026년 1분기", 2026, 1),
    quarterSpec("2027년 4분기", 2027, 4),
    absoluteDaySpec("2025년 3월 1일", 2025, 3, 1),
    absoluteDaySpec("2024년 10월 9일", 2024, 10, 9),
    monthYearSpec("2026년 8월", 2026, 8),
    monthPartSpec("2027년 1월 말", 2027, 1, "end"),
  ];

  const pairSpecs: Array<[RangeSpec, RangeSpec]> = [
    [monthOffsetSpec("지난달", -1), monthOffsetSpec("이번달", 0)],
    [yearOffsetSpec("작년", -1), yearOffsetSpec("올해", 0)],
    [quarterOffsetSpec("지난분기", -1), quarterOffsetSpec("이번분기", 0)],
    [quarterSpec("1분기", 2025, 1), quarterSpec("2분기", 2025, 2)],
    [monthOnlyPastSpec("3월", 3), monthOnlyPastSpec("4월", 4)],
    [yearOffsetSpec("재작년", -2), yearOffsetSpec("작년", -1)],
    [weekOffsetSpec("지난주", -1), weekOffsetSpec("이번 주", 0)],
    [yearOffsetSpec("2024년", -1), yearOffsetSpec("2025년", 0)],
    [monthYearSpec("2024년 2월", 2024, 2), monthYearSpec("2024년 3월", 2024, 3)],
    [halfSpec("상반기", 2025, 1), halfSpec("하반기", 2025, 2)],
  ];

  const genericTemplates = [
    (date: RangeSpec, i: number) => `${date.text} ${products[i % products.length]} 거래내역`,
    (date: RangeSpec, i: number) => `${date.text} ${products[i % products.length]} 잔액`,
    (date: RangeSpec, i: number) => `${date.text} ${products[i % products.length]} 남은 돈`,
    (date: RangeSpec, i: number) => `${date.text} ${products[i % products.length]} 입출금 내역`,
    (date: RangeSpec, i: number) => `${date.text} ${products[i % products.length]} 계좌 잔액`,
    (date: RangeSpec, i: number) => `${date.text} ${products[i % products.length]} 계좌의 자세한 거래 내역은?`,
    (date: RangeSpec, i: number) => `${date.text} ${products[i % products.length]} 거래내역 보여줘`,
    (date: RangeSpec, i: number) => `${date.text} ${products[i % products.length]} 출금 내역 보여 줘`,
    (date: RangeSpec, i: number) => `${date.text} ${costLabels[i % costLabels.length]} 비용 비중은?`,
    (date: RangeSpec) => `${date.text} 자금 증감 현황`,
    (date: RangeSpec, i: number) => `${date.text} 월별 ${products[i % products.length]} 거래내역`,
    (date: RangeSpec, i: number) => `${date.text} ${companies[i % companies.length]}와의 거래 비중이 어떻게 돼?`,
    (date: RangeSpec, i: number) => `${date.text} ${products[i % products.length]} 계좌 잔액 오름차순으로 조회`,
    (date: RangeSpec, i: number) => `${date.text} ${products[i % products.length]} 계좌 잔액 내림차순으로 조회`,
    (date: RangeSpec, i: number) => `${date.text} ${amounts[i % amounts.length]} 이상 ${products[i % products.length]} 거래내역`,
    (date: RangeSpec, i: number) => `${date.text} ${amounts[i % amounts.length]} 이하 ${products[i % products.length]} 계좌 잔액`,
    (date: RangeSpec, i: number) => `${date.text} ${products[i % products.length]} 계좌에서 ${amounts[i % amounts.length]} 가량의 금액이 거래된 내역을 확인하고 싶어.`,
    (date: RangeSpec, i: number) => {
      const pair = productGroups[i % productGroups.length];
      return `${date.text} ${pair[0]}, ${pair[1]} 잔액 보여줘`;
    },
    (date: RangeSpec, i: number) => {
      const pair = productGroups[i % productGroups.length];
      return `${date.text} ${pair[0]}과 ${pair[1]}의 거래 내역을 모두 알려주세요.`;
    },
    (date: RangeSpec, i: number) => {
      const triple = costTriples[i % costTriples.length];
      return `${date.text} ${triple[0]}, ${triple[1]}, ${triple[2]} 비중을 한번에 비교해줘`;
    },
  ] as const;

  const lifecycleTemplates = [
    (date: RangeSpec, i: number) => `${date.text}에 만기되는 ${products[i % products.length]} 계좌를 조회해줘.`,
    (date: RangeSpec, i: number) => `${date.text}에 개설된 ${products[i % products.length]} 계좌를 조회해줘.`,
    (date: RangeSpec, i: number) => `${date.text}에 만기된 ${products[i % products.length]} 계좌를 조회해줘.`,
    (date: RangeSpec, i: number) => `${date.text}에 개설한 ${products[i % products.length]} 계좌 목록은?`,
    (date: RangeSpec, i: number) => `${date.text}에 개설된 ${products[i % products.length]} 계좌 잔액`,
    (date: RangeSpec, i: number) => `${date.text}에 만기 도래하는 ${products[i % products.length]} 계좌가 있는가?`,
    (date: RangeSpec, i: number) => `${date.text}에 신규 개설된 ${products[i % products.length]} 계좌의 거래내역`,
    (date: RangeSpec, i: number) => `${date.text}에 종료된 ${products[i % products.length]} 계좌를 보여줘`,
    (date: RangeSpec, i: number) => `${date.text}에 가입한 ${products[i % products.length]} 계좌 알려줘`,
    (date: RangeSpec, i: number) => `${date.text}에 만기된 ${products[i % products.length]} 계좌의 남은 돈`,
  ] as const;

  const comparisonTemplates = [
    (a: RangeSpec, b: RangeSpec) => `${a.text} 대비 ${b.text} 지출 증가율`,
    (a: RangeSpec, b: RangeSpec, i: number) => `${a.text}과 ${b.text} 각각 ${products[i % products.length]} 거래내역`,
    (a: RangeSpec, b: RangeSpec, i: number) => `${a.text} ${products[i % products.length]} 잔액과 ${b.text} ${products[i % products.length]} 잔액 비교`,
    (a: RangeSpec, b: RangeSpec, i: number) => `${a.text} ${companies[i % companies.length]} 거래 비중과 ${b.text} ${companies[i % companies.length]} 거래 비중 비교`,
    (a: RangeSpec, b: RangeSpec, i: number) => `${a.text} ${costLabels[i % costLabels.length]} 비용을 ${b.text}하고 비교해줘`,
    (a: RangeSpec, b: RangeSpec, i: number) => `${a.text} ${products[i % products.length]} 입출금 내역과 ${b.text} ${products[i % products.length]} 입출금 내역`,
    (a: RangeSpec, b: RangeSpec) => `${a.text} 자금 현황과 ${b.text} 자금 현황 비교`,
    (a: RangeSpec, b: RangeSpec, i: number) => `${a.text} ${products[i % products.length]} 남은 돈하고 ${b.text} ${products[i % products.length]} 남은 돈 비교`,
    (a: RangeSpec, b: RangeSpec) => `${a.text} 출금 내역과 ${b.text} 출금 내역을 함께 보여줘`,
    (a: RangeSpec, b: RangeSpec) => `${a.text} 거래내역과 ${b.text} 거래내역 중 뭐가 더 많아?`,
  ] as const;

  function uniquePush(rows: Row[], seen: Set<string>, row: Row) {
    const key = `${row.text}__${row.final_start_date}__${row.final_end_date}`;
    if (seen.has(key)) return;
    seen.add(key);
    rows.push(row);
  }

  function buildRows(): Row[] {
    const rows: Row[] = [];
    const seen = new Set<string>();

    for (let templateIndex = 0; templateIndex < genericTemplates.length; templateIndex++) {
      const template = genericTemplates[templateIndex];
      for (let dateIndex = 0; dateIndex < genericDateSpecs.length; dateIndex++) {
        const date = genericDateSpecs[dateIndex];
        uniquePush(rows, seen, {
          text: template(date, templateIndex + dateIndex),
          final_start_date: date.start,
          final_end_date: date.end,
        });
      }
    }

    for (let templateIndex = 0; templateIndex < lifecycleTemplates.length; templateIndex++) {
      const template = lifecycleTemplates[templateIndex];
      for (let dateIndex = 0; dateIndex < lifecycleDateSpecs.length; dateIndex++) {
        const date = lifecycleDateSpecs[dateIndex];
        uniquePush(rows, seen, {
          text: template(date, templateIndex + dateIndex),
          final_start_date: date.start,
          final_end_date: date.end,
        });
      }
    }

    for (let templateIndex = 0; templateIndex < comparisonTemplates.length; templateIndex++) {
      const template = comparisonTemplates[templateIndex];
      for (let pairIndex = 0; pairIndex < pairSpecs.length; pairIndex++) {
        const [a, b] = pairSpecs[pairIndex];
        const text = template(a, b, templateIndex + pairIndex);
        uniquePush(rows, seen, {
          text,
          final_start_date: a.start,
          final_end_date: a.end,
        });
        uniquePush(rows, seen, {
          text,
          final_start_date: b.start,
          final_end_date: b.end,
        });
      }
    }

    return rows;
  }

  function writeCsv(rows: Row[]) {
    ensureBenchmarkDirs();
    const header = "text,final_start_date,final_end_date";
    const body = rows
      .map((row) =>
        [
          csvEscape(row.text),
          csvEscape(row.final_start_date),
          csvEscape(row.final_end_date),
        ].join(","),
      )
      .join("\n");
    fs.writeFileSync(outputPath, `${header}\n${body}\n`, "utf8");
  }

  function main() {
    const rows = buildRows();
    if (rows.length !== 1000) {
      throw new Error(`Expected 1000 rows, got ${rows.length}`);
    }
    writeCsv(rows);
    const uniqueTexts = new Set(rows.map((row) => row.text)).size;
    console.log(`written: ${outputPath}`);
    console.log(`rows: ${rows.length}`);
    console.log(`unique texts: ${uniqueTexts}`);
    console.log(`referenceDate: ${REFERENCE_DATE}`);
  }

  main();

  await main();
}

type CommandSpec = {
  description: string;
  run: (args: string[]) => Promise<void>;
};

const commands: Record<string, CommandSpec> = {
  perf: {
    description: "기본 성능 벤치마크",
    run: runPerf,
  },
  "eval-suite": {
    description: "종합 평가 스위트",
    run: runEvalSuite,
  },
  "humanlike-500": {
    description: "LLM 생성 humanlike 500 평가",
    run: runHumanlike500,
  },
  "date-diversity-500": {
    description: "표현 다양성 500 평가",
    run: runDateDiversity500,
  },
  accuracy: {
    description: "CSV 기반 정확도 측정 도구",
    run: runAccuracy,
  },
  "probe-100": {
    description: "100개 하드 케이스 프로브",
    run: runProbe100,
  },
  "realistic-probe": {
    description: "현실형 룰 프로브",
    run: runRealisticProbe,
  },
  "realistic-rule-100": {
    description: "룰 전용 realistic 100 프로브",
    run: runRealisticRule100,
  },
  "generate-csv-style": {
    description: "CSV 스타일 데이터셋 생성기",
    run: runGenerateCsvStyle,
  },
};

const aliases: Record<string, string> = {
  humanlike: "humanlike-500",
  "date-diversity": "date-diversity-500",
  suite: "eval-suite",
};

function printHelp(): void {
  console.log("Usage: tsx benchmarks/scripts/bench.ts <command> [...args]\n");
  console.log("Commands:");
  for (const [name, spec] of Object.entries(commands)) {
    console.log(`  ${name.padEnd(20)} ${spec.description}`);
  }
  console.log("\nExamples:");
  console.log("  npm run bench");
  console.log("  npm run bench -- eval-suite --rule-only");
  console.log("  npm run bench:humanlike");
}

async function runCli(): Promise<void> {
  const [rawCommand = "perf", ...args] = globalThis.process.argv.slice(2);

  if (rawCommand === "--help" || rawCommand === "-h" || rawCommand === "help") {
    printHelp();
    return;
  }

  const commandName = aliases[rawCommand] ?? rawCommand;
  const command = commands[commandName];

  if (!command) {
    console.error(`Unknown benchmark command: ${rawCommand}`);
    printHelp();
    globalThis.process.exitCode = 1;
    return;
  }

  try {
    await command.run(args);
  } catch (error) {
    if (error instanceof BenchExit) {
      globalThis.process.exitCode = error.code;
      return;
    }
    throw error;
  }
}

runCli().catch((error) => {
  console.error(error);
  globalThis.process.exit(1);
});
