import type { DateExpression } from "../types.js";
import {
  findMatchesKo,
  resolveOverlaps,
  hasResidualDateContent,
  KOREAN_DATE_RESIDUAL_KEYWORDS,
} from "./patterns.js";
import {
  findMatchesEn,
  ENGLISH_DATE_RESIDUAL_KEYWORDS,
} from "./patterns-en.js";

export interface RuleResult {
  expressions: Array<{ text: string; expression: DateExpression }>;
  confidence: number; // 1.0 = full_match, 0.0 = no_match
  residualText: string;
}

export function runRules(
  text: string,
  locale: "ko" | "en" | "auto" = "auto",
): RuleResult {
  const all =
    locale === "auto"
      ? [...findMatchesKo(text), ...findMatchesEn(text)]
      : locale === "ko"
        ? findMatchesKo(text)
        : findMatchesEn(text);
  const keywords =
    locale === "auto"
      ? [...new Set([...KOREAN_DATE_RESIDUAL_KEYWORDS, ...ENGLISH_DATE_RESIDUAL_KEYWORDS])]
      : locale === "ko"
        ? KOREAN_DATE_RESIDUAL_KEYWORDS
        : ENGLISH_DATE_RESIDUAL_KEYWORDS;
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

  const hasResidual = hasResidualDateContent(text, resolved, keywords);
  const confidence = hasResidual ? 0.85 : 1.0;

  return { expressions, confidence, residualText: residual };
}
