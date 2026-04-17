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
  QuarterExpression,
  HalfExpression,
  DurationExpression,
  WeekdayInWeekExpression,
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
  ambiguityStrategy?: "past" | "future" | "both";
  fiscalYearStart?: number;
  weekStartsOn?: 0 | 1;
  contextDate?: Date;
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
  const baseDate = ctx.contextDate ?? ref;
  const refYear = ref.getFullYear();
  const baseYear = baseDate.getFullYear();
  const baseMonth = baseDate.getMonth() + 1;
  const strategy = ctx.ambiguityStrategy ?? "past";

  let year =
    expr.year ??
    (expr.yearOffset !== undefined ? refYear + expr.yearOffset : baseYear);
  let month = expr.month;
  let day = expr.day;

  // monthOffset: 기준월 + offset (월 경계 넘어가면 연도도 조정)
  if (month === undefined && expr.monthOffset !== undefined) {
    const refMonth0 = ref.getMonth(); // 0-indexed
    const abs = refMonth0 + expr.monthOffset;
    const yearShift = Math.floor(abs / 12);
    const m0 = ((abs % 12) + 12) % 12;
    month = m0 + 1;
    // yearOffset/year가 명시된 경우는 그대로 두고, 그 외에만 yearShift 적용
    if (expr.year === undefined && expr.yearOffset === undefined) {
      year = refYear + yearShift;
    }
  }

  // 연도 생략 시 모호성 해결 (yearOffset이 지정된 경우는 위에서 이미 계산됨)
  // contextDate가 있으면 그 연도를 우선 사용.
  // past(기본): 후보 날짜가 기준일 이후(미래)면 작년으로 shift → "가장 최근 과거" 선택
  // future:   후보 날짜가 기준일 이전(과거)이면 내년으로 shift → "가장 가까운 미래" 선택
  if (
    expr.year === undefined &&
    expr.yearOffset === undefined &&
    month !== undefined
  ) {
    year = ctx.contextDate ? baseYear : refYear;
    if (!ctx.contextDate) {
      const candidate = new Date(year, month - 1, day ?? 1);
      const refStart = startOfDay(ref);
      if (strategy === "future" && candidate < refStart) {
        year += 1;
      } else if (strategy === "past" && candidate > refStart) {
        year -= 1;
      }
    }
  }

  // 음력 → 양력 변환
  if (expr.lunar && month !== undefined && day !== undefined) {
    const solar = lunarToSolar(year, month, day);
    year = solar.year;
    month = solar.month;
    day = solar.day;
  }

  // yearPart: YYYY년 초(Q1) / 말(Q4) — day/month 없을 때만
  // start/end 는 단일 날짜 (연초=1/1, 연말=12/31)
  if (expr.yearPart && month === undefined && day === undefined) {
    if (expr.yearPart === "start") {
      const d = new Date(year, 0, 1);
      return { start: d, end: d, granularity: "day" };
    }
    if (expr.yearPart === "end") {
      const d = new Date(year, 11, 31);
      return { start: d, end: d, granularity: "day" };
    }
    const q = expr.yearPart === "early" ? 0 : 9;
    const start = new Date(year, q, 1);
    const end = endOfMonth(new Date(year, q + 2, 1));
    return { start, end, granularity: "quarter" };
  }

  // monthPart: M월 초/중/말, start(1일)/end(말일)
  if (expr.monthPart && month !== undefined && day === undefined) {
    const monthStart = new Date(year, month - 1, 1);
    const lastDay = endOfMonth(monthStart).getDate();
    if (expr.monthPart === "start") {
      return { start: monthStart, end: monthStart, granularity: "day" };
    }
    if (expr.monthPart === "end") {
      const d = new Date(year, month - 1, lastDay);
      return { start: d, end: d, granularity: "day" };
    }
    let sd: number;
    let ed: number;
    if (expr.monthPart === "early") {
      sd = 1;
      ed = 10;
    } else if (expr.monthPart === "mid") {
      sd = 11;
      ed = 20;
    } else {
      sd = 21;
      ed = lastDay;
    }
    return {
      start: new Date(year, month - 1, sd),
      end: new Date(year, month - 1, ed),
      granularity: "day",
    };
  }

  // firstWeek: M월 첫 주 (1-7)
  if (expr.firstWeek && month !== undefined && day === undefined) {
    return {
      start: new Date(year, month - 1, 1),
      end: new Date(year, month - 1, 7),
      granularity: "day",
    };
  }

  // day만 있고 month/year 모두 없는 경우 → contextDate 또는 기준일의 현재 월 사용
  if (
    day !== undefined &&
    month === undefined &&
    expr.year === undefined &&
    expr.yearOffset === undefined
  ) {
    month = baseMonth;
    if (ctx.contextDate) {
      year = baseYear;
    } else if (strategy === "future") {
      const refDay = ref.getDate();
      if (day < refDay) month = ref.getMonth() + 2;
    }
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

function resolveQuarter(
  expr: QuarterExpression,
  ctx: ResolveContext,
): ResolvedRange {
  const refYear = ctx.referenceDate.getFullYear();
  const fyStart = (ctx.fiscalYearStart ?? 1) - 1; // 0-indexed
  // quarterOffset이 있으면 기준일의 분기 + offset으로 계산. 연도 넘어가면 yearShift.
  let quarter: number;
  let year: number;
  if (expr.quarter !== undefined) {
    quarter = expr.quarter;
    year = expr.year ?? refYear + (expr.yearOffset ?? 0);
  } else {
    const refMonth0 = ctx.referenceDate.getMonth(); // 0-indexed
    // 현재 분기 (fiscalYearStart 고려)
    const monthsFromFy = ((refMonth0 - fyStart) + 12) % 12;
    const currentQ0 = Math.floor(monthsFromFy / 3); // 0~3
    const targetQ0 = currentQ0 + (expr.quarterOffset ?? 0);
    const yearShift = Math.floor(targetQ0 / 4);
    quarter = (((targetQ0 % 4) + 4) % 4) + 1;
    year = refYear + yearShift + (expr.yearOffset ?? 0);
  }
  const startMonthAbs = fyStart + (quarter - 1) * 3;
  const startYear = year + Math.floor(startMonthAbs / 12);
  const startMonth = ((startMonthAbs % 12) + 12) % 12;
  const endAbs = startMonthAbs + 2;
  const endYear = year + Math.floor(endAbs / 12);
  const endMonth = ((endAbs % 12) + 12) % 12;
  if (expr.part === "early") {
    // 분기 첫 월 1-10일
    return {
      start: new Date(startYear, startMonth, 1),
      end: new Date(startYear, startMonth, 10),
      granularity: "day",
    };
  }
  if (expr.part === "late") {
    // 분기 마지막 월 21일-말일
    const lastDay = endOfMonth(new Date(endYear, endMonth, 1)).getDate();
    return {
      start: new Date(endYear, endMonth, 21),
      end: new Date(endYear, endMonth, lastDay),
      granularity: "day",
    };
  }
  return {
    start: new Date(startYear, startMonth, 1),
    end: endOfMonth(new Date(endYear, endMonth, 1)),
    granularity: "quarter",
  };
}

function resolveHalf(
  expr: HalfExpression,
  ctx: ResolveContext,
): ResolvedRange {
  const ref = ctx.referenceDate;
  const fyStart = (ctx.fiscalYearStart ?? 1) - 1; // 0-indexed
  let year: number;
  if (expr.year !== undefined) {
    year = expr.year;
  } else if (expr.mostRecentPast) {
    const refYear = ref.getFullYear();
    const refMonth = ref.getMonth() + 1;
    if (expr.half === 1) {
      // 상반기 끝 = 상반기 마지막 월. refMonth > (fyStart+6) → current year.
      const h1EndMonth = fyStart + 6;
      year = refMonth > h1EndMonth ? refYear : refYear - 1;
    } else {
      year = refYear - 1;
    }
  } else {
    year = ref.getFullYear() + (expr.yearOffset ?? 0);
  }
  const startAbs = fyStart + (expr.half === 1 ? 0 : 6);
  const endAbs = startAbs + 5;
  const startYear = year + Math.floor(startAbs / 12);
  const startMonth = ((startAbs % 12) + 12) % 12;
  const endYear = year + Math.floor(endAbs / 12);
  const endMonth = ((endAbs % 12) + 12) % 12;
  return {
    start: new Date(startYear, startMonth, 1),
    end: endOfMonth(new Date(endYear, endMonth, 1)),
    granularity: "half",
  };
}

function resolveDuration(
  expr: DurationExpression,
  ctx: ResolveContext,
): ResolvedRange {
  const ref = ctx.referenceDate;
  const amt = expr.direction === "past" ? -expr.amount : expr.amount;
  let other: Date;
  switch (expr.unit) {
    case "day":
      other = addDays(ref, amt);
      break;
    case "week":
      other = addWeeks(ref, amt);
      break;
    case "month":
      other = addMonths(ref, amt);
      break;
    case "year":
      other = addYears(ref, amt);
      break;
  }
  const start = expr.direction === "past" ? other : ref;
  const end = expr.direction === "past" ? ref : other;
  return {
    start: startOfDay(start),
    end: startOfDay(end),
    granularity: "day",
  };
}

function resolveRelative(
  expr: RelativeExpression,
  ctx: ResolveContext,
): ResolvedRange {
  const ref = ctx.referenceDate;
  const { unit, offset, singleDay } = expr;

  // singleDay: "N주 전", "한 달 전", "일년 전" 등 점-시점 해석
  if (singleDay) {
    let d: Date;
    switch (unit) {
      case "day":
        d = addDays(ref, offset);
        break;
      case "week":
        d = addDays(ref, offset * 7);
        break;
      case "month":
        d = addMonths(ref, offset);
        break;
      case "year":
        d = addYears(ref, offset);
        break;
      default:
        d = addDays(ref, offset);
    }
    return { start: startOfDay(d), end: startOfDay(d), granularity: "day" };
  }

  switch (unit) {
    case "day": {
      const d = addDays(ref, offset);
      return { start: startOfDay(d), end: startOfDay(d), granularity: "day" };
    }
    case "week": {
      const d = addWeeks(ref, offset);
      const wso = ctx.weekStartsOn ?? 1;
      return {
        start: startOfWeek(d, { weekStartsOn: wso }),
        end: endOfWeek(d, { weekStartsOn: wso }),
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
  let d = addDays(ctx.referenceDate, effectiveOffset);
  if (expr.yearOffset !== undefined && expr.yearOffset !== 0) {
    d = addYears(d, expr.yearOffset);
  }
  return { start: startOfDay(d), end: startOfDay(d), granularity: "day" };
}

function resolveWeekdayInWeek(
  expr: WeekdayInWeekExpression,
  ctx: ResolveContext,
): ResolvedRange {
  const ref = ctx.referenceDate;
  const wso = ctx.weekStartsOn ?? 1;
  const weekRef = addDays(ref, expr.weekOffset * 7);
  const start = startOfWeek(weekRef, { weekStartsOn: wso });
  // start의 요일 = wso. weekday까지의 일수 오프셋 계산.
  const daysFromStart = (expr.weekday - wso + 7) % 7;
  const target = addDays(start, daysFromStart);
  return { start: startOfDay(target), end: startOfDay(target), granularity: "day" };
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
    case "quarter":
      return resolveQuarter(expr, ctx);
    case "half":
      return resolveHalf(expr, ctx);
    case "duration":
      return resolveDuration(expr, ctx);
    case "weekday_in_week":
      return resolveWeekdayInWeek(expr, ctx);
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

export function computeTemporality(
  range: ResolvedRange,
  referenceDate: Date,
): "past" | "present" | "future" {
  const ref = startOfDay(referenceDate);
  const start = startOfDay(range.start);
  const end = startOfDay(range.end);
  if (end < ref) return "past";
  if (start > ref) return "future";
  return "present";
}
