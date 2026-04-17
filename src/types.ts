export type DateExpression =
  | AbsoluteExpression
  | RelativeExpression
  | RangeExpression
  | FilterExpression
  | NamedExpression;

export interface AbsoluteExpression {
  kind: "absolute";
  year?: number;
  month?: number;
  day?: number;
  lunar?: boolean;
  hour?: number;
  minute?: number;
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
}

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
