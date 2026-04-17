export type DateExpression =
  | AbsoluteExpression
  | RelativeExpression
  | RangeExpression
  | FilterExpression
  | NamedExpression
  | QuarterExpression
  | HalfExpression
  | DurationExpression;

export interface AbsoluteExpression {
  kind: "absolute";
  year?: number;
  /** year 대신 사용: 기준일 연도 + yearOffset. 작년/올해/내년 + M월 조합. */
  yearOffset?: number;
  month?: number;
  day?: number;
  lunar?: boolean;
  hour?: number;
  minute?: number;
  // 초(1-10), 중(11-20), 말(21-end) of month
  monthPart?: "early" | "mid" | "late";
  // 첫 주 (day 1-7 of month)
  firstWeek?: boolean;
  // YYYY년 초(Q1) / YYYY년 말(Q4)
  yearPart?: "early" | "late";
}

export interface QuarterExpression {
  kind: "quarter";
  quarter: 1 | 2 | 3 | 4;
  year?: number;
  yearOffset?: number;
}

export interface HalfExpression {
  kind: "half";
  half: 1 | 2;
  year?: number;
  yearOffset?: number;
  mostRecentPast?: boolean;
}

export interface DurationExpression {
  kind: "duration";
  unit: "day" | "week" | "month" | "year";
  amount: number;
  direction: "past" | "future";
}

export interface RelativeExpression {
  kind: "relative";
  unit: "day" | "week" | "month" | "quarter" | "half" | "year";
  offset: number;
}

export interface RangeExpression {
  kind: "range";
  start: DateExpression;
  end: DateExpression;
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
  | "보름";

export interface NamedExpression {
  kind: "named";
  name: NamedToken;
  direction?: "past" | "future";
}

export type OutputMode =
  | "single"
  | "range"
  | "list"
  | "business_days"
  | "weekdays"
  | "holidays"
  | "all";

export type ExtractionPath = "cache" | "rule" | "llm" | "rule+llm";

export interface ExtractRequest {
  text: string;
  referenceDate?: string;
  timezone?: string;
  locale?: "ko" | "en" | "auto";
  outputModes?: OutputMode[];
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
   * 직전 문맥의 기준 날짜(ISO). 연/월이 생략된 표현을 이 날짜 기준으로 보간.
   * 예: contextDate="2025-06-01"일 때 "15일" → 2025-06-15.
   */
  contextDate?: string;
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
  | { mode: "all"; value: AllModes };

export interface AllModes {
  single?: string;
  range?: { start: string; end: string };
  list?: string[];
  business_days?: string[];
  weekdays?: string[];
  holidays?: string[];
}

export interface ExtractedExpression {
  text: string;
  expression: DateExpression;
  results: ResolvedValue[];
  confidence?: number;
  /** 기준일 대비 이 표현이 과거/현재/미래 중 어디에 해당하는지. */
  temporality?: Temporality;
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
