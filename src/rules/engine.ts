import type { DateExpression } from "../types.js";
import { findMatches, resolveOverlaps, hasResidualDateContent } from "./patterns.js";

export interface RuleResult {
  expressions: Array<{ text: string; expression: DateExpression }>;
  confidence: number; // 1.0 = full_match, 0.0 = no_match
  residualText: string;
}

export function runRules(text: string): RuleResult {
  const all = findMatches(text);
  const resolved = resolveOverlaps(all);
  const expressions = resolved.map((m) => ({
    text: m.text,
    expression: m.expression,
  }));

  // 잔여 텍스트 계산 (매치 제거 후)
  let residual = "";
  let cursor = 0;
  for (const m of resolved) {
    residual += text.slice(cursor, m.start);
    cursor = m.end;
  }
  residual += text.slice(cursor);

  if (resolved.length === 0) {
    return { expressions: [], confidence: 0, residualText: residual };
  }

  const hasResidual = hasResidualDateContent(text, resolved);
  const confidence = hasResidual ? 0.85 : 1.0;

  return { expressions, confidence, residualText: residual };
}
