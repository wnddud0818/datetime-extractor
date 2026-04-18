import type {
  TimeOfDay,
  TimePeriod,
  TimePeriodBounds,
  TimeSpec,
} from "../types.js";

/** 퍼지 시간대의 기본 경계. 사용자 설정(timePeriodBounds)으로 오버라이드 가능. */
export const DEFAULT_TIME_PERIOD_BOUNDS: Record<TimePeriod, TimePeriodBounds> =
  {
    dawn: { startHour: 3, endHour: 6 }, // 새벽 03-06
    morning: { startHour: 6, endHour: 12 }, // 아침/오전 06-12
    noon: { startHour: 12, endHour: 12 }, // 정오 (point)
    afternoon: { startHour: 12, endHour: 18 }, // 오후 12-18
    evening: { startHour: 18, endHour: 21 }, // 저녁 18-21
    night: { startHour: 21, endHour: 24 }, // 밤 21-24
    midnight: { startHour: 0, endHour: 0 }, // 자정 (point, 00:00)
  };

/** 한국어 퍼지 시간대 키워드 → TimePeriod 매핑. */
export const KOREAN_PERIOD_KEYWORDS: Array<{ re: RegExp; period: TimePeriod }> =
  [
    { re: /새벽/, period: "dawn" },
    { re: /아침/, period: "morning" },
    { re: /점심/, period: "noon" },
    { re: /정오/, period: "noon" },
    { re: /오전/, period: "morning" },
    { re: /오후/, period: "afternoon" },
    { re: /저녁/, period: "evening" },
    { re: /밤/, period: "night" },
    { re: /자정/, period: "midnight" },
    { re: /한밤중?/, period: "night" },
  ];

/** 영어 퍼지 시간대 키워드. */
export const ENGLISH_PERIOD_KEYWORDS: Array<{
  re: RegExp;
  period: TimePeriod;
}> = [
  { re: /\bdawn\b/i, period: "dawn" },
  { re: /\bmorning\b/i, period: "morning" },
  { re: /\bnoon\b/i, period: "noon" },
  { re: /\bmidday\b/i, period: "noon" },
  { re: /\bafternoon\b/i, period: "afternoon" },
  { re: /\bevening\b/i, period: "evening" },
  { re: /\bnight\b/i, period: "night" },
  { re: /\bmidnight\b/i, period: "midnight" },
];

/**
 * 12시간 표기(meridiem)를 24시간으로 정규화.
 * "오후 3시" → 15, "오전 12시" → 0 (자정), "오후 12시" → 12 (정오).
 */
export function normalizeHour(spec: TimeSpec): number {
  const { hour, meridiem } = spec;
  if (meridiem === "pm") return hour === 12 ? 12 : hour + 12;
  if (meridiem === "am") return hour === 12 ? 0 : hour;
  return hour; // meridiem 없으면 그대로 (24h 해석 또는 resolver가 defaultMeridiem 적용)
}

/**
 * 퍼지 period 키워드에 따라 이어지는 "N시"의 meridiem을 추정.
 * 예: "새벽 2시" → am, "저녁 7시" → pm.
 */
export function inferMeridiemFromPeriod(period: TimePeriod): "am" | "pm" {
  switch (period) {
    case "dawn":
    case "morning":
    case "midnight":
      return "am";
    case "noon":
    case "afternoon":
    case "evening":
    case "night":
      return "pm";
  }
}

/**
 * TimeOfDay를 시작/끝 시각으로 해석.
 * period 타입은 bounds(또는 사용자 오버라이드)를 사용.
 * point는 start===end.
 */
export function resolveTimeOfDay(
  time: TimeOfDay,
  opts: {
    defaultMeridiem?: "am" | "pm";
    periodBounds?: Partial<Record<TimePeriod, TimePeriodBounds>>;
  } = {},
): {
  startHour: number;
  startMinute: number;
  endHour: number;
  endMinute: number;
  period?: TimePeriod;
} {
  if (time.type === "period") {
    const bounds =
      opts.periodBounds?.[time.period] ??
      DEFAULT_TIME_PERIOD_BOUNDS[time.period];
    return {
      startHour: bounds.startHour,
      startMinute: bounds.startMinute ?? 0,
      endHour: bounds.endHour,
      endMinute: bounds.endMinute ?? 0,
      period: time.period,
    };
  }

  if (time.type === "point") {
    const spec: TimeSpec = {
      hour: time.hour,
      minute: time.minute,
      meridiem: time.meridiem ?? opts.defaultMeridiem,
    };
    const h = normalizeHour(spec);
    const m = time.minute ?? 0;
    return { startHour: h, startMinute: m, endHour: h, endMinute: m };
  }

  // range
  const startSpec: TimeSpec = {
    ...time.start,
    meridiem: time.start.meridiem ?? opts.defaultMeridiem,
  };
  const endSpec: TimeSpec = {
    ...time.end,
    meridiem:
      time.end.meridiem ?? time.start.meridiem ?? opts.defaultMeridiem,
  };
  return {
    startHour: normalizeHour(startSpec),
    startMinute: startSpec.minute ?? 0,
    endHour: normalizeHour(endSpec),
    endMinute: endSpec.minute ?? 0,
  };
}

/** "HH:MM" 포맷. */
export function formatHm(hour: number, minute: number): string {
  const h = Math.min(23, Math.max(0, hour === 24 ? 23 : hour));
  const m = Math.min(59, Math.max(0, minute));
  const hh = String(h).padStart(2, "0");
  const mm = String(m).padStart(2, "0");
  // 시각 범위가 24시로 끝나는 경우는 23:59로 치환한다 (예: 밤 21-24).
  if (hour === 24 && minute === 0) return "23:59";
  return `${hh}:${mm}`;
}
