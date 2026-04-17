import { format } from "date-fns";
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
import { runRules } from "./rules/engine.js";
import {
  resolveExpression,
  formatRange,
  parseReferenceDate,
  getFilterKind,
} from "./resolver/resolve.js";
import { cacheGet, cacheSet } from "./cache/lru.js";
import { callLLMWithRetry, getModelName, warmUp } from "./extractor/ollama-client.js";

export * from "./types.js";
export { cacheClear, cacheSize } from "./cache/lru.js";
export { warmUp } from "./extractor/ollama-client.js";

const DEFAULT_OUTPUT_MODES: OutputMode[] = ["range", "single"];

function now(): number {
  return performance.now();
}

async function buildResponse(
  expressions: Array<{ text: string; expression: DateExpression; confidence?: number }>,
  req: ExtractRequest,
  referenceDate: Date,
  timezone: string,
  path: ExtractionPath,
  latencyBreakdown: LatencyBreakdown,
  latencyStart: number,
  ruleConfidence?: number,
  error?: string,
): Promise<ExtractResponse> {
  const outputModes = req.outputModes ?? DEFAULT_OUTPUT_MODES;
  const ctx = { referenceDate, timezone };
  const resolverStart = now();

  const result: ExtractedExpression[] = [];
  for (const e of expressions) {
    const range = resolveExpression(e.expression, ctx);
    const filter = getFilterKind(e.expression);
    const results: ResolvedValue[] = [];
    for (const mode of outputModes) {
      const v = await formatRange(range, mode, filter);
      if (v) results.push(v);
    }
    result.push({
      text: e.text,
      expression: e.expression,
      results,
      confidence: e.confidence,
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
  const locale = req.locale ?? "auto";
  const referenceDateIso =
    req.referenceDate ?? format(new Date(), "yyyy-MM-dd");
  const referenceDate = parseReferenceDate(referenceDateIso);
  const outputModes = req.outputModes ?? DEFAULT_OUTPUT_MODES;

  // 0. 캐시 조회
  const cacheStart = now();
  const cacheKey = {
    text: req.text,
    referenceDate: referenceDateIso,
    timezone,
    locale,
    outputModes: outputModes.join(","),
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
  const ruleResult = runRules(req.text);
  breakdown.rule = now() - ruleStart;

  let path: ExtractionPath;
  let expressions: Array<{ text: string; expression: DateExpression; confidence?: number }>;
  let ruleConfidence = ruleResult.confidence;
  let error: string | undefined;

  if (ruleResult.confidence >= 1.0 && !req.forceLLM) {
    // full_match → LLM 스킵
    path = "rule";
    expressions = ruleResult.expressions.map((e) => ({
      text: e.text,
      expression: e.expression,
      confidence: 1.0,
    }));
  } else if (ruleResult.expressions.length > 0 && !req.forceLLM) {
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
          confidence: 1.0,
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
        confidence: 0.85,
      }));
      error = llmRes.error;
    }
  } else {
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
  }

  const response = await buildResponse(
    expressions,
    req,
    referenceDate,
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
