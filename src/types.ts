export type DateExpression =
  | AbsoluteExpression
  | RelativeExpression
  | RangeExpression
  | FilterExpression
  | NamedExpression
  | PeriodToDateExpression
  | QuarterExpression
  | HalfExpression
  | WeekPartExpression
  | DurationExpression
  | WeekdayInWeekExpression
  | DateTimeExpression;

/** 시간대 지정자. 정밀 시각, 범위, 혹은 퍼지 구간(아침/저녁 등)을 표현. */
export type TimePeriod =
  | "dawn" // 새벽
  | "morning" // 아침 / 오전 (일반)
  | "noon" // 정오
  | "afternoon" // 오후
  | "evening" // 저녁
  | "night" // 밤
  | "midnight"; // 자정

export interface TimeSpec {
  hour: number; // 0-23 (meridiem 없을 땐 24h로 해석)
  minute?: number; // 0-59
  /** 12h 표기 힌트. resolver가 24h로 정규화한다. */
  meridiem?: "am" | "pm";
}

export type TimeOfDay =
  | { type: "point"; hour: number; minute?: number; meridiem?: "am" | "pm" }
  | { type: "range"; start: TimeSpec; end: TimeSpec }
  | { type: "period"; period: TimePeriod };

/** 임의의 날짜 표현에 시간을 덧씌운 wrapper. */
export interface DateTimeExpression {
  kind: "datetime";
  base: DateExpression;
  time: TimeOfDay;
}

export interface AbsoluteExpression {
  kind: "absolute";
  year?: number;
  /** year 대신 사용: 기준일 연도 + yearOffset. 작년/올해/내년 + M월 조합. */
  yearOffset?: number;
  month?: number;
  /** month 대신 사용: 기준일 월 + monthOffset. 이번달/지난달/다음달 + 초/중/말 조합. */
  monthOffset?: number;
  day?: number;
  lunar?: boolean;
  hour?: number;
  minute?: number;
  /** 범위형 시각의 끝 (hour/minute가 시작, endHour/endMinute가 끝). */
  endHour?: number;
  endMinute?: number;
  /** 퍼지 시간대 (새벽/아침/정오/오후/저녁/밤/자정). */
  timePeriod?: TimePeriod;
  // 초(1-10), 중(11-20), 말(21-end) of month
  // start = 1일 단일, end = 말일 단일 (월초/월말)
  monthPart?: "early" | "mid" | "late" | "start" | "end";
  // 월의 N주차 (1=1-7, 2=8-14, 3=15-21, 4=22-28, 5=29-말일)
  weekOfMonth?: 1 | 2 | 3 | 4 | 5;
  /** weekOfMonth와 결합되면 그 주의 특정 요일을 지목. 0=일,1=월,...,6=토. */
  weekday?: number;
  // YYYY년 초(Q1) / YYYY년 말(Q4)
  // start = 1/1 단일, end = 12/31 단일 (연초/연말)
  yearPart?: "early" | "late" | "start" | "end";
  /** 퍼지 표현 (N일쯤, 이달 말쯤 등). resolver가 fuzzyDayWindow만큼 범위로 확장. */
  fuzzy?: boolean;
  /** 해결된 단일 날짜에 더할 일수 (크리스마스 전날 = -1, 추석 다음날 = +1). day가 확정된 경우에만 적용. */
  dayOffset?: number;
}

export interface QuarterExpression {
  kind: "quarter";
  /** quarter가 없고 quarterOffset만 있으면 기준일의 현재 분기 + offset으로 resolver가 계산. */
  quarter?: 1 | 2 | 3 | 4;
  quarterOffset?: number;
  year?: number;
  yearOffset?: number;
  /** 분기의 부분 선택: 초(첫 월 1-10일) / 말(마지막 월 21일-말일) */
  part?: "early" | "late";
}

export interface HalfExpression {
  kind: "half";
  half: 1 | 2;
  year?: number;
  yearOffset?: number;
  mostRecentPast?: boolean;
  /** 기준일의 현재 반기 + offset. 설정 시 half/year/yearOffset/mostRecentPast는 무시. */
  halfOffset?: number;
}

export interface DurationExpression {
  kind: "duration";
  unit: "day" | "week" | "month" | "year";
  amount: number;
  direction: "past" | "future";
}

export interface RelativeExpression {
  kind: "relative";
  unit: "day" | "week" | "month" | "quarter" | "half" | "year" | "business_day";
  offset: number;
  /** true면 기간이 아닌 단일 시점(point-in-time)으로 해석. 예: "2주 전" = 14일 전 당일. */
  singleDay?: boolean;
}

/**
 * 기준일 기준 동일 시점까지의 누적 구간.
 * 예:
 * - unit=year, offset=0  → 연초부터 오늘까지(YTD)
 * - unit=year, offset=-1 → 작년 같은 시점까지
 * - unit=month, offset=0 → 월초부터 오늘까지(MTD)
 * - unit=month, offset=-1 → 전월 같은 날짜까지
 */
export interface PeriodToDateExpression {
  kind: "to_date";
  unit: "month" | "year";
  offset: number;
}

export interface RangeExpression {
  kind: "range";
  start: DateExpression;
  /** end가 start로부터 N일간 지속되는 경우에는 생략 가능. durationDays 사용. */
  end?: DateExpression;
  /** "오늘부터 일주일간"처럼 시작일 대비 지속 일수. end가 없거나 함께 있어도 이 값이 우선. */
  durationDays?: number;
}

export type FilterKind =
  | "business_days"
  | "weekdays"
  | "weekends"
  | "holidays"
  | "saturdays"
  | "sundays";

export interface FilterExpression {
  kind: "filter";
  base: DateExpression;
  filter: FilterKind;
}

export type NamedToken =
  | "today"
  | "yesterday"
  | "tomorrow"
  | "그저께"
  | "엊그제"
  | "모레"
  | "글피"
  | "그글피"
  | "하루"
  | "이틀"
  | "사흘"
  | "나흘"
  | "닷새"
  | "엿새"
  | "이레"
  | "여드레"
  | "아흐레"
  | "열흘"
  | "보름"
  | "next_business_day"
  | "prev_business_day"
  | "today_or_next_business_day"
  | "next_holiday"
  | "prev_holiday"
  | "today_or_next_holiday";

export interface NamedExpression {
  kind: "named";
  name: NamedToken;
  direction?: "past" | "future";
  /** "작년 오늘" 같은 prefix 조합: yearOffset만큼 연 이동 후 같은 월일 */
  yearOffset?: number;
  /** 퍼지 표현 (작년 오늘쯤, 재작년 이맘때). ±fuzzyDayWindow 범위로 확장. */
  fuzzy?: boolean;
}

/** "이번주 초", "지난주 중반" 같은 주 내부 구간 선택 */
export interface WeekPartExpression {
  kind: "week_part";
  /** -2=지지난주, -1=지난주, 0=이번주, 1=다음주 */
  weekOffset: number;
  part: "early" | "mid" | "late";
}

/** "이번주 월요일", "지난주 금요일", "next Friday" 같은 주+요일 지정 */
export interface WeekdayInWeekExpression {
  kind: "weekday_in_week";
  /** -2=지지난주, -1=지난주, 0=이번주, 1=다음주 */
  weekOffset: number;
  /** 0=일, 1=월, 2=화, ..., 6=토 (JS getDay 규약) */
  weekday: number;
  /** true면 weekOffset을 무시하고 기준일 이후 가장 가까운 해당 요일로 해석. "오는 금요일", "돌아오는 월요일". */
  nearestFuture?: boolean;
}

export type OutputMode =
  | "single"
  | "range"
  | "list"
  | "business_days"
  | "weekdays"
  | "holidays"
  | "all"
  /** ISO 8601 + 타임존. 시간 표현이 있을 때만 의미 있는 값을 반환. */
  | "datetime";

export type ExtractionPath = "cache" | "rule" | "llm" | "rule+llm";

export interface ExtractRequest {
  text: string;
  referenceDate?: string;
  timezone?: string;
  locale?: "ko" | "en" | "auto";
  outputModes?: OutputMode[];
  /**
   * true이면 룰 엔진이 부분 매칭/미매칭한 경우에만 LLM 폴백을 허용.
   * 기본값은 false.
   */
  enableLLM?: boolean;
  forceLLM?: boolean;
  /**
   * true이면 룰/LLM이 모두 날짜를 찾지 못했을 때 기준일(오늘)을 기본값으로 반환.
   * 금융·운영 도메인처럼 "날짜 미지정 = 현재 시점"이 관습인 환경에서 사용.
   */
  defaultToToday?: boolean;
  /**
   * 연도/월이 생략된 표현("5일", "3월")의 해석 방향.
   * - "past": 가장 가까운 과거로 해석 (기본값; 예: 11/17 기준 "3월" → 올해 3월이 과거라 올해 3월)
   * - "future": 가장 가까운 미래로 해석
   * - "both": 모호성을 유지 (현재는 past와 동일하게 동작)
   * 기본값: "past"
   */
  ambiguityStrategy?: "past" | "future" | "both";
  /**
   * 회계연도 시작월 (1~12). 기본값 1.
   * 분기/반기 해석에 영향. 예: 7이면 7~9월이 1분기, 7~12월이 상반기.
   */
  fiscalYearStart?: number;
  /**
   * 주의 시작 요일. 0=일요일, 1=월요일. 기본값 1.
   */
  weekStartsOn?: 0 | 1;
  /**
   * 퍼지 시간대(아침/저녁 등)의 시/분 경계를 사용자가 오버라이드.
   * 미지정 시 기본값 사용 (src/rules/time-patterns.ts DEFAULT_TIME_PERIOD_BOUNDS).
   */
  timePeriodBounds?: Partial<Record<TimePeriod, TimePeriodBounds>>;
  /**
   * 오전/오후가 생략된 "N시" 해석의 기본 meridiem. 기본값 없음(24시간 해석).
   */
  defaultMeridiem?: "am" | "pm";
  /**
   * true(기본)면 range/single 모드는 시간 표현이 있어도 YYYY-MM-DD만 반환(하위호환).
   * false면 시간이 있을 때 ISO 8601 datetime으로 반환.
   * 시간 없이는 항상 날짜만 반환되므로 동작 차이 없음.
   */
  dateOnlyForDateModes?: boolean;
  /**
   * 직전 문맥의 기준 날짜(ISO). 연/월이 생략된 표현을 이 날짜 기준으로 보간.
   * 예: contextDate="2025-06-01"일 때 "15일" → 2025-06-15.
   */
  contextDate?: string;
  /**
   * 기준일을 포함하는 기간(이번달·이번분기·올해·하반기·이번주 등)의 끝 처리.
   * - "period": 기간 전체 끝까지 반환 (기본값). 예: 이번달 → 11-01 ~ 11-30
   * - "today":  기준일까지 잘라 반환.           예: 이번달 → 11-01 ~ 11-17
   * 단일 시점(오늘/내일/어제 등)이나 과거·미래 기간에는 영향 없음.
   */
  presentRangeEnd?: "period" | "today";
  /**
   * "이달 말 / 전월 말 / 익월 초 / 월말 / 연말 / 연초" 등 기간 경계 표현의 해석.
   * - "single": 월말=말일, 월초=1일 단일 날짜 (기본값)
   * - "range":  월말=21일~말일, 월초=1~10일 범위. 연말=12/21~12/31, 연초=1/1~1/10.
   * 연/월 내부에서 사용자가 "부근" 의미를 기대할 때 "range"로 설정.
   */
  monthBoundaryMode?: "single" | "range";
  /**
   * 퍼지 표현("N일쯤", "작년 오늘쯤", "재작년 이맘때")의 ± 일수 창.
   * 기본값 3. 0이면 fuzzy 효과 없이 정확한 날짜로 해석.
   */
  fuzzyDayWindow?: number;
}

/** 기준일 대비 표현의 시간적 위치. */
export type Temporality = "past" | "present" | "future";

export type ResolvedValue =
  | { mode: "single"; value: string }
  | { mode: "range"; value: { start: string; end: string } }
  | { mode: "list"; value: string[] }
  | { mode: "business_days"; value: string[] }
  | { mode: "weekdays"; value: string[] }
  | { mode: "holidays"; value: string[] }
  | { mode: "datetime"; value: { start: string; end: string } }
  | { mode: "all"; value: AllModes };

export interface AllModes {
  single?: string;
  range?: { start: string; end: string };
  list?: string[];
  business_days?: string[];
  weekdays?: string[];
  holidays?: string[];
  datetime?: { start: string; end: string };
}

/** 퍼지 시간대 경계. startMinute/endMinute 생략 시 0. */
export interface TimePeriodBounds {
  startHour: number;
  startMinute?: number;
  endHour: number; // 24 허용 (예: 밤 21-24)
  endMinute?: number;
}

export interface ExtractedExpression {
  text: string;
  expression: DateExpression;
  results: ResolvedValue[];
  confidence?: number;
  /** 기준일 대비 이 표현이 과거/현재/미래 중 어디에 해당하는지. */
  temporality?: Temporality;
  /** 시간 표현이 포함된 경우의 flat 투영. point면 startTime===endTime. */
  time?: {
    startTime: string; // "HH:MM"
    endTime: string; // "HH:MM"
    period?: TimePeriod;
  };
}

export interface LatencyBreakdown {
  cache?: number;
  rule?: number;
  llm?: number;
  resolver?: number;
  format?: number;
}

export interface ExtractResponse {
  hasDate: boolean;
  expressions: ExtractedExpression[];
  meta: {
    referenceDate: string;
    timezone: string;
    model: string;
    path: ExtractionPath;
    latencyMs: number;
    latencyBreakdown?: LatencyBreakdown;
    ruleConfidence?: number;
    error?: string;
  };
}
