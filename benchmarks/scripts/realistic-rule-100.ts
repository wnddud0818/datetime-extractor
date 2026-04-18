import {
  addDays,
  addMonths,
  addWeeks,
  addYears,
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
import { runRules } from "../../src/rules/engine.js";
import {
  formatRange,
  getFilterKind,
  parseReferenceDate,
  resolveExpression,
} from "../../src/resolver/resolve.js";
import type { OutputMode } from "../../src/types.js";

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

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
