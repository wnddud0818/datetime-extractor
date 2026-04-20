import { format } from "date-fns";
import { formatInTimeZone } from "date-fns-tz";
import type {
  DateExpression,
  ExtractRequest,
  ExtractResponse,
  ExtractionPath,
  ExtractedExpression,
  LatencyBreakdown,
  OutputMode,
  ResolvedValue,
} from "./types.js";
import { ExtractValidationError } from "./errors.js";
import { runRules } from "./rules/engine.js";
import {
  resolveExpression,
  formatRange,
  parseReferenceDate,
  getFilterKind,
  getFilterOutputMode,
  computeTemporality,
  projectTimeField,
} from "./resolver/resolve.js";
import { getHolidays } from "./calendar/korean-holidays.js";
import { cacheGet, cacheSet } from "./cache/lru.js";
import { callLLMWithRetry, getModelName, warmUp } from "./extractor/ollama-client.js";

export * from "./types.js";
export * from "./errors.js";
export { cacheClear, cacheSize } from "./cache/lru.js";
export { warmUp } from "./extractor/ollama-client.js";

const DEFAULT_OUTPUT_MODES: OutputMode[] = ["range", "single"];
const HOLIDAY_CONTEXT_NAMES = new Set([
  "next_business_day",
  "prev_business_day",
  "today_or_next_business_day",
  "next_holiday",
  "prev_holiday",
  "today_or_next_holiday",
]);

function now(): number {
  return performance.now();
}

function assertValidTimezone(timezone: string): void {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(new Date());
  } catch {
    throw new ExtractValidationError(
      "timezone",
      timezone,
      `Invalid timezone: expected a valid IANA timezone, received "${timezone}".`,
    );
  }
}

function collectHolidayContextYears(
  expr: DateExpression,
  referenceYear: number,
  years: Set<number>,
): void {
  switch (expr.kind) {
    case "named":
      if (HOLIDAY_CONTEXT_NAMES.has(expr.name)) {
        years.add(referenceYear - 1);
        years.add(referenceYear);
        years.add(referenceYear + 1);
      }
      return;
    case "range":
      collectHolidayContextYears(expr.start, referenceYear, years);
      if (expr.end) {
        collectHolidayContextYears(expr.end, referenceYear, years);
      }
      return;
    case "filter":
      collectHolidayContextYears(expr.base, referenceYear, years);
      return;
    case "datetime":
      collectHolidayContextYears(expr.base, referenceYear, years);
      return;
    default:
      return;
  }
}

async function loadHolidayContext(
  expressions: Array<{ text: string; expression: DateExpression; confidence?: number }>,
  referenceDate: Date,
): Promise<Record<number, Record<string, string>>> {
  const years = new Set<number>();
  for (const expression of expressions) {
    collectHolidayContextYears(
      expression.expression,
      referenceDate.getFullYear(),
      years,
    );
  }

  const holidaysByYear: Record<number, Record<string, string>> = {};
  for (const year of years) {
    holidaysByYear[year] = await getHolidays(year);
  }
  return holidaysByYear;
}

/**
 * 사용자가 기간의 특정 부분을 명시적으로 선택한 표현인지 판별.
 * 예: "올해 말"(yearPart=late), "이번 분기 말"(quarter.part=late),
 *     "이번달 초"(monthPart=early), "3월 둘째 주"(weekOfMonth) 등.
 * 이런 표현은 presentRangeEnd="today" 클램프에서 제외해야 한다
 * (사용자가 미래 구간을 명시한 것이므로).
 */
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

async function buildResponse(
  expressions: Array<{ text: string; expression: DateExpression; confidence?: number }>,
  req: ExtractRequest,
  referenceDate: Date,
  contextDate: Date | undefined,
  timezone: string,
  path: ExtractionPath,
  latencyBreakdown: LatencyBreakdown,
  latencyStart: number,
  ruleConfidence?: number,
  error?: string,
): Promise<ExtractResponse> {
  const outputModes = req.outputModes ?? DEFAULT_OUTPUT_MODES;
  const userSpecifiedModes = req.outputModes !== undefined;
  const holidaysByYear = await loadHolidayContext(expressions, referenceDate);
  const ctx = {
    referenceDate,
    timezone,
    ambiguityStrategy: req.ambiguityStrategy,
    fiscalYearStart: req.fiscalYearStart,
    weekStartsOn: req.weekStartsOn,
    contextDate,
    defaultMeridiem: req.defaultMeridiem,
    timePeriodBounds: req.timePeriodBounds,
    monthBoundaryMode: req.monthBoundaryMode,
    fuzzyDayWindow: req.fuzzyDayWindow,
    holidaysByYear,
  };
  const resolverStart = now();
  const clampToToday = req.presentRangeEnd === "today";
  const dateOnlyForDateModes = req.dateOnlyForDateModes ?? true;

  const result: ExtractedExpression[] = [];
  for (const e of expressions) {
    const range = resolveExpression(e.expression, ctx);
    if (
      clampToToday &&
      !isExplicitSubset(e.expression) &&
      range.start <= referenceDate &&
      range.end > referenceDate
    ) {
      range.end = referenceDate;
    }
    const filter = getFilterKind(e.expression);
    const select = e.expression.kind === "filter" ? e.expression.select : undefined;
    const filterMode = getFilterOutputMode(filter);
    const modesForExpr =
      !userSpecifiedModes && filterMode
        ? select ? (["single"] as OutputMode[]) : [filterMode]
        : outputModes;
    const results: ResolvedValue[] = [];
    for (const mode of modesForExpr) {
      const v = await formatRange(range, mode, filter, {
        timezone,
        dateOnlyForDateModes,
        select,
      });
      if (v) results.push(v);
    }
    const time = projectTimeField(range);
    result.push({
      text: e.text,
      expression: e.expression,
      results,
      confidence: e.confidence,
      temporality: computeTemporality(range, referenceDate),
      ...(time ? { time } : {}),
    });
  }
  latencyBreakdown.resolver = now() - resolverStart;

  return {
    hasDate: result.length > 0,
    expressions: result,
    meta: {
      referenceDate: format(referenceDate, "yyyy-MM-dd"),
      timezone,
      model: path === "rule" || path === "cache" ? "rules" : getModelName(),
      path,
      latencyMs: Math.round(now() - latencyStart),
      latencyBreakdown,
      ruleConfidence,
      error,
    },
  };
}

export async function extract(req: ExtractRequest): Promise<ExtractResponse> {
  const latencyStart = now();
  const breakdown: LatencyBreakdown = {};

  const timezone = req.timezone ?? "Asia/Seoul";
  assertValidTimezone(timezone);
  const locale = req.locale ?? "auto";
  const enableLLM = req.enableLLM ?? false;
  const referenceDateIso =
    req.referenceDate ?? formatInTimeZone(new Date(), timezone, "yyyy-MM-dd");
  const referenceDate = parseReferenceDate(referenceDateIso, "referenceDate");
  const contextDate = req.contextDate
    ? parseReferenceDate(req.contextDate, "contextDate")
    : undefined;
  const outputModes = req.outputModes ?? DEFAULT_OUTPUT_MODES;

  // 0. 캐시 조회
  const cacheStart = now();
  const cacheKey = {
    text: req.text,
    referenceDate: referenceDateIso,
    timezone,
    locale,
    outputModes,
    enableLLM,
    forceLLM: req.forceLLM === true,
    defaultToToday: req.defaultToToday ?? false,
    ambiguityStrategy: req.ambiguityStrategy ?? "past",
    fiscalYearStart: req.fiscalYearStart ?? 1,
    weekStartsOn: req.weekStartsOn ?? 1,
    contextDate: req.contextDate ?? "",
    presentRangeEnd: req.presentRangeEnd ?? "period",
    defaultMeridiem: req.defaultMeridiem ?? "",
    dateOnlyForDateModes: req.dateOnlyForDateModes ?? true,
    monthBoundaryMode: req.monthBoundaryMode ?? "single",
    fuzzyDayWindow: req.fuzzyDayWindow ?? 3,
    timePeriodBounds: req.timePeriodBounds ?? null,
  };
  const cached = cacheGet(cacheKey);
  breakdown.cache = now() - cacheStart;
  if (cached && !req.forceLLM) {
    return {
      ...cached,
      meta: {
        ...cached.meta,
        path: "cache",
        latencyMs: Math.round(now() - latencyStart),
        latencyBreakdown: breakdown,
      },
    };
  }

  // 1a. 룰 엔진
  const ruleStart = now();
  const ruleResult = runRules(req.text, locale);
  breakdown.rule = now() - ruleStart;

  let path: ExtractionPath;
  let expressions: Array<{ text: string; expression: DateExpression; confidence?: number }>;
  let ruleConfidence = ruleResult.confidence;
  let error: string | undefined;
  const shouldUseLLM = enableLLM || req.forceLLM === true;

  if (ruleResult.confidence >= 1.0 && !req.forceLLM) {
    // full_match → LLM 스킵
    path = "rule";
    expressions = ruleResult.expressions.map((e) => ({
      text: e.text,
      expression: e.expression,
      confidence: 1.0,
    }));
  } else if (ruleResult.expressions.length > 0 && !req.forceLLM) {
    if (!enableLLM) {
      path = "rule";
      expressions = ruleResult.expressions.map((e) => ({
        text: e.text,
        expression: e.expression,
        confidence: ruleResult.confidence,
      }));
    } else {
      // partial_match: 룰 결과에 LLM 결과 병합
      const llmStart = now();
      const llmRes = await callLLMWithRetry(req.text);
      breakdown.llm = now() - llmStart;
      path = "rule+llm";
      if (llmRes.output) {
        // LLM이 룰과 동일한 span을 리포트하면 중복. 간단 병합: 룰 우선, LLM의 고유 span만 추가.
        const ruleSpans = new Set(ruleResult.expressions.map((e) => e.text));
        const merged: Array<{ text: string; expression: DateExpression; confidence?: number }> =
          ruleResult.expressions.map((e) => ({
            text: e.text,
            expression: e.expression,
            confidence: ruleResult.confidence,
          }));
        for (const e of llmRes.output.expressions) {
          if (!ruleSpans.has(e.text)) {
            merged.push({
              text: e.text,
              expression: e.expression as DateExpression,
              confidence: e.confidence,
            });
          }
        }
        expressions = merged;
      } else {
        expressions = ruleResult.expressions.map((e) => ({
          text: e.text,
          expression: e.expression,
          confidence: ruleResult.confidence,
        }));
        error = llmRes.error;
      }
    }
  } else if (shouldUseLLM) {
    // no_match 또는 forceLLM → 전체 LLM
    const llmStart = now();
    const llmRes = await callLLMWithRetry(req.text);
    breakdown.llm = now() - llmStart;
    path = "llm";
    if (llmRes.output) {
      expressions = llmRes.output.expressions.map((e) => ({
        text: e.text,
        expression: e.expression as DateExpression,
        confidence: e.confidence,
      }));
    } else {
      expressions = [];
      error = llmRes.error ?? "llm_failed";
    }
    ruleConfidence = 0;
  } else {
    path = "rule";
    expressions = [];
  }

  // defaultToToday 폴백: 날짜를 하나도 못 찾았는데 옵션이 켜져 있으면 오늘로 기본 처리
  if (expressions.length === 0 && req.defaultToToday) {
    expressions = [
      {
        text: "",
        expression: { kind: "named", name: "today" },
        confidence: 0,
      },
    ];
    error = undefined; // LLM 에러가 있더라도 기본값으로 대체했으므로 클리어
  }

  const response = await buildResponse(
    expressions,
    req,
    referenceDate,
    contextDate,
    timezone,
    path,
    breakdown,
    latencyStart,
    ruleConfidence,
    error,
  );

  // 4. 캐시 저장 (LLM 에러 시엔 저장 안 함)
  if (!error && expressions.length >= 0) {
    cacheSet(cacheKey, response);
  }

  return response;
}

/**
 * 서버 기동 시 호출해 모델 워밍업.
 */
export async function warmUpLLM(): Promise<void> {
  await warmUp();
}
