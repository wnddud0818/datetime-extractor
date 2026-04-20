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
  DateTimeExpression,
  OutputMode,
  ResolvedValue,
  AllModes,
  TimeOfDay,
  TimePeriod,
  TimePeriodBounds,
} from "../types.js";
import { KOREAN_NUMERAL_OFFSETS, isDirectionalNumeral } from "./named.js";
import { resolveAmbiguity } from "./ambiguity.js";
import {
  resolveTimeOfDay,
  formatHm,
} from "../rules/time-patterns.js";
import {
  listBusinessDays,
  listWeekdays,
  listWeekends,
  listSaturdays,
  listSundays,
  listHolidaysInRange,
  isWeekend,
} from "../calendar/business-days.js";
import KoreanLunarCalendar from "korean-lunar-calendar";

export interface ResolvedTime {
  startHour: number;
  startMinute: number;
  endHour: number;
  endMinute: number;
  period?: TimePeriod;
  /** point (startHour===endHour && startMinute===endMinute) 여부. */
  isPoint: boolean;
}

export interface ResolvedRange {
  start: Date;
  end: Date;
  granularity: "day" | "week" | "month" | "quarter" | "half" | "year";
  /** DateTimeExpression을 통해 시간이 부여된 경우 설정됨. */
  time?: ResolvedTime;
}

export interface ResolveContext {
  referenceDate: Date;
  timezone: string;
  ambiguityStrategy?: "past" | "future" | "both";
  fiscalYearStart?: number;
  weekStartsOn?: 0 | 1;
  contextDate?: Date;
  defaultMeridiem?: "am" | "pm";
  timePeriodBounds?: Partial<Record<TimePeriod, TimePeriodBounds>>;
  /** "이달 말" 등 기간 경계의 해석 모드. "single" 기본, "range"면 하순/상순으로 확장. */
  monthBoundaryMode?: "single" | "range";
  /** 퍼지 표현("N일쯤")의 ± 일수 창. 기본 3. */
  fuzzyDayWindow?: number;
  /** 미리 로드한 연도별 공휴일 맵. next/prev business day 같은 sync 해석에 사용. */
  holidaysByYear?: Record<number, Record<string, unknown>>;
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
  // monthOffset이 지정된 경우 month/year를 이미 고정했으므로 ambiguity shift 금지.
  if (
    expr.year === undefined &&
    expr.yearOffset === undefined &&
    expr.monthOffset === undefined &&
    // weekOfMonth 표현은 "N월 K주차"처럼 미래를 지시하는 경우가 많아 past-shift 하지 않음.
    expr.weekOfMonth === undefined &&
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
  // start/end 는 단일 날짜 (연초=1/1, 연말=12/31); monthBoundaryMode=range면 1/1~1/10 / 12/21~12/31.
  if (expr.yearPart && month === undefined && day === undefined) {
    const rangeMode = ctx.monthBoundaryMode === "range";
    if (expr.yearPart === "start") {
      if (rangeMode) {
        return applyFuzzy(
          {
            start: new Date(year, 0, 1),
            end: new Date(year, 0, 10),
            granularity: "day",
          },
          expr.fuzzy,
          ctx,
        );
      }
      const d = new Date(year, 0, 1);
      return applyFuzzy(
        { start: d, end: d, granularity: "day" },
        expr.fuzzy,
        ctx,
      );
    }
    if (expr.yearPart === "end") {
      if (rangeMode) {
        return applyFuzzy(
          {
            start: new Date(year, 11, 21),
            end: new Date(year, 11, 31),
            granularity: "day",
          },
          expr.fuzzy,
          ctx,
        );
      }
      const d = new Date(year, 11, 31);
      return applyFuzzy(
        { start: d, end: d, granularity: "day" },
        expr.fuzzy,
        ctx,
      );
    }
    const q = expr.yearPart === "early" ? 0 : 9;
    const start = new Date(year, q, 1);
    const end = endOfMonth(new Date(year, q + 2, 1));
    return { start, end, granularity: "quarter" };
  }

  // weekOfYear: 해당 연도의 마지막 주 (12/31 기준 주 시작 ~ 12/31, 연도 내로 클램프)
  if (expr.weekOfYear === "last" && month === undefined && day === undefined) {
    const wso = (ctx.weekStartsOn ?? 1) as 0 | 1;
    const yearEnd = new Date(year, 11, 31);
    const weekStart = startOfWeek(yearEnd, { weekStartsOn: wso });
    return { start: startOfDay(weekStart), end: startOfDay(yearEnd), granularity: "week" };
  }

  // monthPart: M월 초/중/말, start(1일)/end(말일)
  if (expr.monthPart && month !== undefined && day === undefined) {
    const monthStart = new Date(year, month - 1, 1);
    const lastDay = endOfMonth(monthStart).getDate();
    const rangeMode = ctx.monthBoundaryMode === "range";
    if (expr.monthPart === "start") {
      // single(기본): 1일 단일 / range: 1-10일
      if (rangeMode) {
        return applyFuzzy(
          {
            start: monthStart,
            end: new Date(year, month - 1, Math.min(10, lastDay)),
            granularity: "day",
          },
          expr.fuzzy,
          ctx,
        );
      }
      return applyFuzzy(
        { start: monthStart, end: monthStart, granularity: "day" },
        expr.fuzzy,
        ctx,
      );
    }
    if (expr.monthPart === "end") {
      // single(기본): 말일 단일 / range: 21-말일
      if (rangeMode) {
        return applyFuzzy(
          {
            start: new Date(year, month - 1, 21),
            end: new Date(year, month - 1, lastDay),
            granularity: "day",
          },
          expr.fuzzy,
          ctx,
        );
      }
      const d = new Date(year, month - 1, lastDay);
      return applyFuzzy(
        { start: d, end: d, granularity: "day" },
        expr.fuzzy,
        ctx,
      );
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
    return applyFuzzy(
      {
        start: new Date(year, month - 1, sd),
        end: new Date(year, month - 1, ed),
        granularity: "day",
      },
      expr.fuzzy,
      ctx,
    );
  }

  // weekOfMonth: M월 N주차 (1:1-7, 2:8-14, 3:15-21, 4:22-28, 5:29-말일)
  // + weekday가 같이 주어지면 그 주차 내 특정 요일을 단일 날짜로 선택.
  if (expr.weekOfMonth && month !== undefined && day === undefined) {
    const n = expr.weekOfMonth;
    const sd = (n - 1) * 7 + 1;
    const monthStart = new Date(year, month - 1, 1);
    const lastDay = endOfMonth(monthStart).getDate();
    const ed = n === 5 ? lastDay : Math.min(sd + 6, lastDay);
    if (sd > lastDay) {
      return { start: monthStart, end: monthStart, granularity: "day" };
    }
    if (expr.weekday !== undefined) {
      for (let dd = sd; dd <= ed; dd++) {
        const candidate = new Date(year, month - 1, dd);
        if (candidate.getDay() === expr.weekday) {
          return { start: candidate, end: candidate, granularity: "day" };
        }
      }
      // 해당 주차에 target weekday가 없으면 주차의 시작일로 fallback.
      const fb = new Date(year, month - 1, sd);
      return { start: fb, end: fb, granularity: "day" };
    }
    return {
      start: new Date(year, month - 1, sd),
      end: new Date(year, month - 1, ed),
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
    } else {
      const refDay = ref.getDate();
      if (strategy === "future" && day < refDay) {
        const d = new Date(ref.getFullYear(), ref.getMonth() + 1, 1);
        year = d.getFullYear();
        month = d.getMonth() + 1;
      } else if (strategy === "past" && day > refDay) {
        const d = new Date(ref.getFullYear(), ref.getMonth() - 1, 1);
        year = d.getFullYear();
        month = d.getMonth() + 1;
      }
    }
  }

  // 구체성에 따라 range 구성
  if (day !== undefined && month !== undefined) {
    let d = new Date(year, month - 1, day);
    if (expr.dayOffset) d = addDays(d, expr.dayOffset);
    return applyFuzzy(
      { start: startOfDay(d), end: startOfDay(d), granularity: "day" },
      expr.fuzzy,
      ctx,
    );
  }
  if (month !== undefined) {
    const d = new Date(year, month - 1, 1);
    return applyFuzzy(
      {
        start: startOfMonth(d),
        end: endOfMonth(d),
        granularity: "month",
      },
      expr.fuzzy,
      ctx,
    );
  }
  const d = new Date(year, 0, 1);
  return applyFuzzy(
    { start: startOfYear(d), end: endOfYear(d), granularity: "year" },
    expr.fuzzy,
    ctx,
  );
}

/** 퍼지 플래그가 켜진 표현의 범위를 ± fuzzyDayWindow 일수 만큼 확장. */
function applyFuzzy(
  range: ResolvedRange,
  fuzzy: boolean | undefined,
  ctx: ResolveContext,
): ResolvedRange {
  if (!fuzzy) return range;
  const w = ctx.fuzzyDayWindow ?? 3;
  if (w <= 0) return range;
  return {
    ...range,
    start: startOfDay(addDays(range.start, -w)),
    end: startOfDay(addDays(range.end, w)),
    granularity: "day",
  };
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
  let half: 1 | 2 = expr.half;
  if (expr.halfOffset !== undefined) {
    // 기준일의 현재 반기 계산 (fiscal-year 기준).
    const refYear = ref.getFullYear();
    const refMonth0 = ref.getMonth();
    const fiscalIndex = ((refMonth0 - fyStart) % 12 + 12) % 12;
    const currentHalf: 1 | 2 = fiscalIndex < 6 ? 1 : 2;
    const currentFiscalYear = refMonth0 < fyStart ? refYear - 1 : refYear;
    // 반기 단위 절대 인덱스: fiscalYear*2 + (half===1?0:1)
    const currentAbs = currentFiscalYear * 2 + (currentHalf === 1 ? 0 : 1);
    const targetAbs = currentAbs + expr.halfOffset;
    year = Math.floor(targetAbs / 2);
    half = (targetAbs % 2 === 0 ? 1 : 2) as 1 | 2;
  } else if (expr.year !== undefined) {
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
  const startAbs = fyStart + (half === 1 ? 0 : 6);
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

function isBusinessDaySync(date: Date, ctx: ResolveContext): boolean {
  if (isWeekend(date)) return false;
  const iso = format(date, "yyyy-MM-dd");
  const y = date.getFullYear();
  const holidays = ctx.holidaysByYear?.[y];
  if (holidays && iso in holidays) return false;
  return true;
}

function isHolidaySync(date: Date, ctx: ResolveContext): boolean {
  const iso = format(date, "yyyy-MM-dd");
  const y = date.getFullYear();
  const holidays = ctx.holidaysByYear?.[y];
  return !!holidays && iso in holidays;
}

function scanBusinessDay(
  start: Date,
  step: 1 | -1,
  ctx: ResolveContext,
  includeStart: boolean,
): Date {
  let d = includeStart ? start : addDays(start, step);
  for (let i = 0; i < 30; i++) {
    if (isBusinessDaySync(d, ctx)) return d;
    d = addDays(d, step);
  }
  return d;
}

function scanHoliday(
  start: Date,
  step: 1 | -1,
  ctx: ResolveContext,
  includeStart: boolean,
): Date {
  let d = includeStart ? start : addDays(start, step);
  for (let i = 0; i < 370; i++) {
    if (isHolidaySync(d, ctx)) return d;
    d = addDays(d, step);
  }
  return d;
}

function resolveNamed(
  expr: NamedExpression,
  ctx: ResolveContext,
): ResolvedRange {
  if (
    expr.name === "next_business_day" ||
    expr.name === "prev_business_day" ||
    expr.name === "today_or_next_business_day"
  ) {
    const ref = ctx.referenceDate;
    const step = expr.name === "prev_business_day" ? -1 : 1;
    const includeStart = expr.name === "today_or_next_business_day";
    const d = scanBusinessDay(ref, step, ctx, includeStart);
    return {
      start: startOfDay(d),
      end: startOfDay(d),
      granularity: "day",
    };
  }
  if (
    expr.name === "next_holiday" ||
    expr.name === "prev_holiday" ||
    expr.name === "today_or_next_holiday"
  ) {
    const ref = ctx.referenceDate;
    const step = expr.name === "prev_holiday" ? -1 : 1;
    const includeStart = expr.name === "today_or_next_holiday";
    const d = scanHoliday(ref, step, ctx, includeStart);
    return {
      start: startOfDay(d),
      end: startOfDay(d),
      granularity: "day",
    };
  }
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
  return applyFuzzy(
    { start: startOfDay(d), end: startOfDay(d), granularity: "day" },
    expr.fuzzy,
    ctx,
  );
}

function resolveWeekdayInWeek(
  expr: WeekdayInWeekExpression,
  ctx: ResolveContext,
): ResolvedRange {
  const ref = ctx.referenceDate;
  // nearestFuture: "오는/돌아오는/다가오는 X요일" — 기준일 이후 가장 가까운 해당 요일.
  // 기준일이 target 요일과 같으면 7일 뒤(다음 해당 요일)로 해석 (strictly future).
  if (expr.nearestFuture) {
    const refWeekday = ref.getDay();
    const daysAhead = ((expr.weekday - refWeekday + 6) % 7) + 1;
    const target = addDays(ref, daysAhead);
    return {
      start: startOfDay(target),
      end: startOfDay(target),
      granularity: "day",
    };
  }
  // nearest: 단독 요일("목요일") — ambiguityStrategy에 따라 과거/미래 결정.
  // future: 오늘 포함 가장 가까운 해당 요일(오늘이 해당 요일이면 오늘).
  // past(기본): 오늘 포함 가장 최근 해당 요일.
  if (expr.nearest) {
    const strategy = ctx.ambiguityStrategy ?? "past";
    const refWeekday = ref.getDay();
    let target: Date;
    if (strategy === "future") {
      const daysAhead = (expr.weekday - refWeekday + 7) % 7;
      target = addDays(ref, daysAhead);
    } else {
      const daysBehind = (refWeekday - expr.weekday + 7) % 7;
      target = addDays(ref, -daysBehind);
    }
    return { start: startOfDay(target), end: startOfDay(target), granularity: "day" };
  }
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
  if (expr.durationDays !== undefined) {
    // "오늘부터 일주일간" → start + (N-1) 일. 경계 포함.
    const endDate = addDays(s.start, expr.durationDays - 1);
    return {
      start: s.start,
      end: startOfDay(endDate),
      granularity: "day",
    };
  }
  if (!expr.end) {
    return { start: s.start, end: s.end, granularity: "day" };
  }
  let e = resolveExpression(expr.end, ctx);
  if (expr.end.kind === "absolute") {
    const endHasExplicitYear =
      expr.end.year !== undefined || expr.end.yearOffset !== undefined;
    if (!endHasExplicitYear) {
      e = resolveExpression(expr.end, { ...ctx, contextDate: s.start });

      // "11월부터 2월까지"처럼 끝 월/일이 시작보다 앞서면 다음 해로 넘긴다.
      if (e.end < s.start) {
        e = resolveExpression(expr.end, {
          ...ctx,
          contextDate: addYears(s.start, 1),
        });
      }
    }
  }
  return {
    start: s.start,
    end: e.end,
    granularity: "day",
  };
}

function resolveDateTime(
  expr: DateTimeExpression,
  ctx: ResolveContext,
): ResolvedRange {
  const baseRange = resolveExpression(expr.base, ctx);
  const t = resolveTimeOfDay(expr.time, {
    defaultMeridiem: ctx.defaultMeridiem,
    periodBounds: ctx.timePeriodBounds,
  });
  const isPoint =
    t.startHour === t.endHour && t.startMinute === t.endMinute;
  return {
    ...baseRange,
    time: { ...t, isPoint },
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
    case "datetime":
      return resolveDateTime(expr, ctx);
  }
}

export function getFilterKind(expr: DateExpression): FilterExpression["filter"] | null {
  if (expr.kind === "filter") return expr.filter;
  if (expr.kind === "datetime") return getFilterKind(expr.base);
  return null;
}

export function getFilterOutputMode(
  filter: FilterExpression["filter"] | null,
): OutputMode | null {
  if (filter === "weekdays") return "weekdays";
  if (filter === "business_days") return "business_days";
  if (filter === "holidays") return "holidays";
  if (filter === "weekends" || filter === "saturdays" || filter === "sundays") {
    return "list";
  }
  return null;
}

/**
 * ResolvedRange + time을 ISO 8601 (오프셋 포함) 문자열 2개로 포맷한다.
 * 시간이 없으면 날짜의 00:00 / 23:59:59로 fallback.
 */
export function formatIsoDateTimeRange(
  range: ResolvedRange,
  timezone: string,
): { start: string; end: string } {
  const t = range.time;
  let startHour = 0;
  let startMinute = 0;
  let endHour = 23;
  let endMinute = 59;
  let endSecond = 59;

  if (t) {
    startHour = t.startHour;
    startMinute = t.startMinute;
    if (t.isPoint) {
      endHour = t.endHour;
      endMinute = t.endMinute;
      endSecond = 0;
    } else {
      // 24시는 다음날 00:00이지만 여기서는 같은 날 23:59로 클램프
      if (t.endHour === 24) {
        endHour = 23;
        endMinute = 59;
        endSecond = 59;
      } else {
        endHour = t.endHour;
        endMinute = t.endMinute;
        endSecond = 0;
      }
    }
  }

  return {
    start: formatIsoWithOffset(
      range.start,
      startHour,
      startMinute,
      0,
      timezone,
    ),
    end: formatIsoWithOffset(range.end, endHour, endMinute, endSecond, timezone),
  };
}

/**
 * 주어진 날짜(로컬 날짜 정보만 사용)와 시/분/초를 받아 timezone 오프셋이 포함된 ISO 문자열을 반환.
 * 예: "2026-04-18T15:30:00+09:00"
 */
export function formatIsoWithOffset(
  date: Date,
  hour: number,
  minute: number,
  second: number,
  timezone: string,
): string {
  const y = date.getFullYear();
  const mo = date.getMonth();
  const d = date.getDate();
  // 해당 로컬 시각의 UTC 등가를 만든 뒤, timezone의 해당 시점 offset을 조회.
  const localAsUtc = new Date(Date.UTC(y, mo, d, hour, minute, second));
  const offsetMin = getTimezoneOffsetMinutes(timezone, localAsUtc);
  const actualUtcMs = localAsUtc.getTime() - offsetMin * 60 * 1000;
  const actual = new Date(actualUtcMs);

  // 출력은 로컬 시각(y/mo/d, hour/minute/second) + offset.
  const yyyy = String(y).padStart(4, "0");
  const mm = String(mo + 1).padStart(2, "0");
  const dd = String(d).padStart(2, "0");
  const hh = String(hour).padStart(2, "0");
  const mi = String(minute).padStart(2, "0");
  const ss = String(second).padStart(2, "0");
  const sign = offsetMin >= 0 ? "+" : "-";
  const absOff = Math.abs(offsetMin);
  const offH = String(Math.floor(absOff / 60)).padStart(2, "0");
  const offM = String(absOff % 60).padStart(2, "0");
  void actual; // actual은 디버깅용, 현재는 오프셋 문자열만 사용
  return `${yyyy}-${mm}-${dd}T${hh}:${mi}:${ss}${sign}${offH}:${offM}`;
}

/**
 * Intl.DateTimeFormat을 이용해 지정 timezone의 주어진 UTC 시각에 대한 오프셋(분)을 계산.
 */
function getTimezoneOffsetMinutes(timezone: string, utcDate: Date): number {
  try {
    const dtf = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    });
    const parts = dtf.formatToParts(utcDate);
    const map: Record<string, string> = {};
    for (const p of parts) map[p.type] = p.value;
    const asUtc = Date.UTC(
      Number(map.year),
      Number(map.month) - 1,
      Number(map.day),
      Number(map.hour === "24" ? "0" : map.hour),
      Number(map.minute),
      Number(map.second),
    );
    return Math.round((asUtc - utcDate.getTime()) / 60000);
  } catch {
    return 0; // fallback UTC
  }
}

export async function formatRange(
  range: ResolvedRange,
  mode: OutputMode,
  filter: FilterExpression["filter"] | null,
  opts: { timezone?: string; dateOnlyForDateModes?: boolean; select?: "last" | "first" } = {},
): Promise<ResolvedValue | null> {
  const fmt = (d: Date) => format(d, "yyyy-MM-dd");
  const isSingle =
    range.granularity === "day" &&
    fmt(range.start) === fmt(range.end);
  const tz = opts.timezone ?? "UTC";
  const includeTime =
    !!range.time && opts.dateOnlyForDateModes === false;

  switch (mode) {
    case "single": {
      if (includeTime) {
        const iso = formatIsoDateTimeRange(range, tz);
        return { mode: "single", value: iso.start };
      }
      // select: "last"/"first" — 필터링 결과에서 마지막/첫 날짜를 단일 값으로 반환.
      if (opts.select && filter) {
        let days: string[];
        if (filter === "business_days") days = await listBusinessDays(range.start, range.end);
        else if (filter === "weekdays") days = listWeekdays(range.start, range.end);
        else if (filter === "weekends") days = listWeekends(range.start, range.end);
        else if (filter === "holidays") days = await listHolidaysInRange(range.start, range.end);
        else if (filter === "saturdays") days = listSaturdays(range.start, range.end);
        else if (filter === "sundays") days = listSundays(range.start, range.end);
        else days = [];
        if (days.length === 0) return null;
        return { mode: "single", value: opts.select === "last" ? days[days.length - 1] : days[0] };
      }
      return { mode: "single", value: fmt(range.start) };
    }
    case "range": {
      if (includeTime) {
        return { mode: "range", value: formatIsoDateTimeRange(range, tz) } as ResolvedValue;
      }
      // 필터가 붙은 주/월 단위 표현에서 range 모드는 조건에 맞는 첫/마지막 날짜로 축소.
      // 예: "이번 주 주말" → 토-일 2일만, "6월 첫째 주 주말" → 해당 주차의 토-일.
      if (filter === "weekends" || filter === "saturdays" || filter === "sundays") {
        const days =
          filter === "weekends"
            ? listWeekends(range.start, range.end)
            : filter === "saturdays"
              ? listSaturdays(range.start, range.end)
              : listSundays(range.start, range.end);
        if (days.length > 0) {
          return {
            mode: "range",
            value: { start: days[0], end: days[days.length - 1] },
          };
        }
      }
      return {
        mode: "range",
        value: { start: fmt(range.start), end: fmt(range.end) },
      };
    }
    case "datetime": {
      // datetime 모드: 시간이 없어도 날짜 + 00:00 ~ 23:59로 fallback
      return {
        mode: "datetime",
        value: formatIsoDateTimeRange(range, tz),
      };
    }
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
      if (range.time) {
        all.datetime = formatIsoDateTimeRange(range, tz);
      }
      return { mode: "all", value: all };
    }
  }
}

/**
 * ResolvedRange.time을 ExtractedExpression.time (flat HH:MM projection)으로 변환.
 */
export function projectTimeField(
  range: ResolvedRange,
): { startTime: string; endTime: string; period?: TimePeriod } | undefined {
  if (!range.time) return undefined;
  const t = range.time;
  return {
    startTime: formatHm(t.startHour, t.startMinute),
    endTime: formatHm(t.endHour, t.endMinute),
    period: t.period,
  };
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
