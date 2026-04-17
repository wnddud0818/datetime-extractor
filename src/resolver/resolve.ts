import {
  addDays,
  addMonths,
  addWeeks,
  addYears,
  addQuarters,
  endOfMonth,
  endOfQuarter,
  endOfWeek,
  endOfYear,
  startOfDay,
  startOfMonth,
  startOfQuarter,
  startOfWeek,
  startOfYear,
  format,
  parseISO,
} from "date-fns";
import type {
  DateExpression,
  AbsoluteExpression,
  RelativeExpression,
  NamedExpression,
  RangeExpression,
  FilterExpression,
  OutputMode,
  ResolvedValue,
  AllModes,
} from "../types.js";
import { KOREAN_NUMERAL_OFFSETS, isDirectionalNumeral } from "./named.js";
import { resolveAmbiguity } from "./ambiguity.js";
import {
  listBusinessDays,
  listWeekdays,
  listWeekends,
  listSaturdays,
  listSundays,
  listHolidaysInRange,
} from "../calendar/business-days.js";
import KoreanLunarCalendar from "korean-lunar-calendar";

export interface ResolvedRange {
  start: Date;
  end: Date;
  granularity: "day" | "week" | "month" | "quarter" | "half" | "year";
}

export interface ResolveContext {
  referenceDate: Date;
  timezone: string;
}

function lunarToSolar(
  year: number,
  month: number,
  day: number,
): { year: number; month: number; day: number } {
  const cal = new KoreanLunarCalendar();
  cal.setLunarDate(year, month, day, false);
  const solar = cal.getSolarCalendar();
  return { year: solar.year, month: solar.month, day: solar.day };
}

function resolveAbsolute(
  expr: AbsoluteExpression,
  ctx: ResolveContext,
): ResolvedRange {
  const ref = ctx.referenceDate;
  const refYear = ref.getFullYear();
  const refMonth = ref.getMonth() + 1;

  let year = expr.year ?? refYear;
  let month = expr.month;
  let day = expr.day;

  // 연도 생략 시 모호성 해결: month만 있으면 "가장 가까운 미래 또는 현재"
  if (expr.year === undefined && month !== undefined && day === undefined) {
    // 월 단독: 현재 월 이전이면 내년이 아니라 "과거" (예: 4월에 "3월 잔액")
    // "지난 3월" 같은 표현은 LLM/rules가 relative로 처리.
    // 여기서는 단순히 현재 연도 사용.
    year = refYear;
  }
  if (expr.year === undefined && month !== undefined && day !== undefined) {
    const candidate = new Date(refYear, month - 1, day);
    if (candidate < ref) {
      // 기본적으로 과거 해석 (현재 연도 유지). "다음 3월 15일" 같은 미래 지향은 LLM이 +1 offset 추가.
      year = refYear;
    } else {
      year = refYear;
    }
  }

  // 음력 → 양력 변환
  if (expr.lunar && month !== undefined && day !== undefined) {
    const solar = lunarToSolar(year, month, day);
    year = solar.year;
    month = solar.month;
    day = solar.day;
  }

  // 구체성에 따라 range 구성
  if (day !== undefined && month !== undefined) {
    const d = new Date(year, month - 1, day);
    return { start: startOfDay(d), end: startOfDay(d), granularity: "day" };
  }
  if (month !== undefined) {
    const d = new Date(year, month - 1, 1);
    return {
      start: startOfMonth(d),
      end: endOfMonth(d),
      granularity: "month",
    };
  }
  const d = new Date(year, 0, 1);
  return { start: startOfYear(d), end: endOfYear(d), granularity: "year" };
}

function resolveRelative(
  expr: RelativeExpression,
  ctx: ResolveContext,
): ResolvedRange {
  const ref = ctx.referenceDate;
  const { unit, offset } = expr;

  switch (unit) {
    case "day": {
      const d = addDays(ref, offset);
      return { start: startOfDay(d), end: startOfDay(d), granularity: "day" };
    }
    case "week": {
      const d = addWeeks(ref, offset);
      return {
        start: startOfWeek(d, { weekStartsOn: 1 }),
        end: endOfWeek(d, { weekStartsOn: 1 }),
        granularity: "week",
      };
    }
    case "month": {
      const d = addMonths(ref, offset);
      return {
        start: startOfMonth(d),
        end: endOfMonth(d),
        granularity: "month",
      };
    }
    case "quarter": {
      const d = addQuarters(ref, offset);
      return {
        start: startOfQuarter(d),
        end: endOfQuarter(d),
        granularity: "quarter",
      };
    }
    case "half": {
      const d = addMonths(ref, offset * 6);
      const half = d.getMonth() < 6 ? 0 : 6;
      const startHalf = new Date(d.getFullYear(), half, 1);
      const endHalf = endOfMonth(new Date(d.getFullYear(), half + 5, 1));
      return { start: startHalf, end: endHalf, granularity: "half" };
    }
    case "year": {
      const d = addYears(ref, offset);
      return {
        start: startOfYear(d),
        end: endOfYear(d),
        granularity: "year",
      };
    }
  }
}

function resolveNamed(
  expr: NamedExpression,
  ctx: ResolveContext,
): ResolvedRange {
  const offset = KOREAN_NUMERAL_OFFSETS[expr.name] ?? 0;
  const directional = isDirectionalNumeral(expr.name);
  const effectiveOffset = directional
    ? expr.direction === "future"
      ? offset
      : -offset
    : offset;
  const d = addDays(ctx.referenceDate, effectiveOffset);
  return { start: startOfDay(d), end: startOfDay(d), granularity: "day" };
}

function resolveRange(
  expr: RangeExpression,
  ctx: ResolveContext,
): ResolvedRange {
  const s = resolveExpression(expr.start, ctx);
  const e = resolveExpression(expr.end, ctx);
  return {
    start: s.start,
    end: e.end,
    granularity: "day",
  };
}

export function resolveExpression(
  raw: DateExpression,
  ctx: ResolveContext,
): ResolvedRange {
  const expr = resolveAmbiguity(raw, ctx);
  switch (expr.kind) {
    case "absolute":
      return resolveAbsolute(expr, ctx);
    case "relative":
      return resolveRelative(expr, ctx);
    case "named":
      return resolveNamed(expr, ctx);
    case "range":
      return resolveRange(expr, ctx);
    case "filter":
      // filter 자체는 base의 range를 그대로 사용. 출력 단계에서 필터 적용.
      return resolveExpression(expr.base, ctx);
  }
}

export function getFilterKind(expr: DateExpression): FilterExpression["filter"] | null {
  if (expr.kind === "filter") return expr.filter;
  return null;
}

export async function formatRange(
  range: ResolvedRange,
  mode: OutputMode,
  filter: FilterExpression["filter"] | null,
): Promise<ResolvedValue | null> {
  const fmt = (d: Date) => format(d, "yyyy-MM-dd");
  const isSingle =
    range.granularity === "day" &&
    fmt(range.start) === fmt(range.end);

  switch (mode) {
    case "single":
      return { mode: "single", value: fmt(range.start) };
    case "range":
      return {
        mode: "range",
        value: { start: fmt(range.start), end: fmt(range.end) },
      };
    case "list":
      if (filter === "business_days") {
        return { mode: "list", value: await listBusinessDays(range.start, range.end) };
      }
      if (filter === "weekdays") {
        return { mode: "list", value: listWeekdays(range.start, range.end) };
      }
      if (filter === "weekends") {
        return { mode: "list", value: listWeekends(range.start, range.end) };
      }
      if (filter === "holidays") {
        return { mode: "list", value: await listHolidaysInRange(range.start, range.end) };
      }
      if (filter === "saturdays") {
        return { mode: "list", value: listSaturdays(range.start, range.end) };
      }
      if (filter === "sundays") {
        return { mode: "list", value: listSundays(range.start, range.end) };
      }
      // 필터 없으면 전 기간 일자 나열 (단일 날짜면 하나)
      return {
        mode: "list",
        value: isSingle
          ? [fmt(range.start)]
          : enumerateDays(range.start, range.end),
      };
    case "business_days":
      return {
        mode: "business_days",
        value: await listBusinessDays(range.start, range.end),
      };
    case "weekdays":
      return { mode: "weekdays", value: listWeekdays(range.start, range.end) };
    case "holidays":
      return {
        mode: "holidays",
        value: await listHolidaysInRange(range.start, range.end),
      };
    case "all": {
      const all: AllModes = {
        single: fmt(range.start),
        range: { start: fmt(range.start), end: fmt(range.end) },
      };
      if (!isSingle) {
        all.list = enumerateDays(range.start, range.end);
        all.business_days = await listBusinessDays(range.start, range.end);
        all.weekdays = listWeekdays(range.start, range.end);
        all.holidays = await listHolidaysInRange(range.start, range.end);
      }
      return { mode: "all", value: all };
    }
  }
}

function enumerateDays(start: Date, end: Date): string[] {
  const out: string[] = [];
  let cur = startOfDay(start);
  const limit = startOfDay(end);
  let guard = 0;
  while (cur <= limit && guard < 2000) {
    out.push(format(cur, "yyyy-MM-dd"));
    cur = addDays(cur, 1);
    guard++;
  }
  return out;
}

export function parseReferenceDate(iso?: string): Date {
  if (!iso) return new Date();
  return parseISO(iso);
}
