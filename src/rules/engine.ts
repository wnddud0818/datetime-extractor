import type { DateExpression } from "../types.js";
import {
  findMatchesKo,
  resolveOverlaps,
  hasResidualDateContent,
  KOREAN_DATE_RESIDUAL_KEYWORDS,
  type Match,
} from "./patterns.js";
import {
  findMatchesEn,
  ENGLISH_DATE_RESIDUAL_KEYWORDS,
} from "./patterns-en.js";

function inheritAbsoluteContext(
  startExpr: DateExpression,
  endExpr: DateExpression,
): DateExpression {
  if (startExpr.kind !== "absolute" || endExpr.kind !== "absolute") {
    return endExpr;
  }

  const inherited = { ...endExpr };

  if (inherited.year === undefined && inherited.yearOffset === undefined) {
    if (startExpr.year !== undefined) {
      inherited.year = startExpr.year;
    } else if (startExpr.yearOffset !== undefined) {
      inherited.yearOffset = startExpr.yearOffset;
    }
  }

  if (inherited.month === undefined && inherited.monthOffset === undefined) {
    if (startExpr.month !== undefined) {
      inherited.month = startExpr.month;
    } else if (startExpr.monthOffset !== undefined) {
      inherited.monthOffset = startExpr.monthOffset;
    }
    if (inherited.lunar === undefined && startExpr.lunar !== undefined) {
      inherited.lunar = startExpr.lunar;
    }
  }

  return inherited;
}

function canStartDurationRange(expr: DateExpression): boolean {
  return (
    expr.kind !== "duration" &&
    expr.kind !== "filter" &&
    expr.kind !== "datetime"
  );
}

function isAbsoluteDayLevel(
  expr: DateExpression,
): expr is Extract<DateExpression, { kind: "absolute" }> {
  return expr.kind === "absolute" && expr.day !== undefined;
}

/**
 * resolveOverlaps 이후 인접 매치 사이에 "부터~까지" 연결어가 있으면
 * 두 매치를 단일 RangeExpression으로 병합한다.
 */
function mergeRangeConnectors(text: string, matches: Match[]): Match[] {
  if (matches.length < 2) return matches;
  const result: Match[] = [];
  let i = 0;
  while (i < matches.length) {
    const a = matches[i];
    const b = matches[i + 1];
    if (b !== undefined) {
      const between = text.slice(a.end, b.start);
      const afterB = text.slice(b.end, b.end + 6);
      const isConnector = /^\s*부터\s*$/.test(between) || /^\s*에서\s*$/.test(between);
      const isSymbolicConnector = /^\s*(?:~|〜|～|-|–)\s*$/.test(between);
      if (
        isConnector &&
        canStartDurationRange(a.expression) &&
        b.expression.kind === "duration"
      ) {
        result.push({
          text: text.slice(a.start, b.end),
          start: a.start,
          end: b.end,
          expression: {
            kind: "range",
            start: a.expression,
            duration: {
              unit: b.expression.unit,
              amount: b.expression.amount,
            },
          },
          priority: Math.max(a.priority, b.priority) + 1,
        });
        i += 2;
        continue;
      }
      if (
        isSymbolicConnector &&
        isAbsoluteDayLevel(a.expression) &&
        isAbsoluteDayLevel(b.expression)
      ) {
        result.push({
          text: text.slice(a.start, b.end),
          start: a.start,
          end: b.end,
          expression: {
            kind: "range",
            start: a.expression,
            end: inheritAbsoluteContext(a.expression, b.expression),
          },
          priority: Math.max(a.priority, b.priority) + 1,
        });
        i += 2;
        continue;
      }
      const kajiMatch = /^\s*까지/.exec(afterB);
      if (isConnector && kajiMatch) {
        const rangeEnd = b.end + kajiMatch[0].length;
        let endExpr = b.expression;
        // 이번주 월요일부터 금요일까지: 단독 요일을 시작 표현의 주 offset으로 맞춤
        if (
          a.expression.kind === "weekday_in_week" &&
          b.expression.kind === "weekday_in_week" &&
          b.expression.nearest
        ) {
          endExpr = { kind: "weekday_in_week", weekOffset: a.expression.weekOffset, weekday: b.expression.weekday };
        }
        endExpr = inheritAbsoluteContext(a.expression, endExpr);
        result.push({
          text: text.slice(a.start, rangeEnd),
          start: a.start,
          end: rangeEnd,
          expression: { kind: "range", start: a.expression, end: endExpr },
          priority: Math.max(a.priority, b.priority) + 1,
        });
        i += 2;
        continue;
      }
      // 부터만 있고 까지가 없는 경우: 월 단위 이상(day 없음)에서만 범위로 병합
      if (isConnector && !kajiMatch) {
        const isMonthOrCoarser = (expr: DateExpression): boolean => {
          if (expr.kind === "absolute") return expr.day === undefined;
          if (expr.kind === "named") return true;
          if (expr.kind === "relative") return true;
          return false;
        };
        if (isMonthOrCoarser(a.expression) && isMonthOrCoarser(b.expression)) {
          const endExpr = inheritAbsoluteContext(a.expression, b.expression);
          result.push({
            text: text.slice(a.start, b.end),
            start: a.start,
            end: b.end,
            expression: { kind: "range", start: a.expression, end: endExpr },
            priority: Math.max(a.priority, b.priority) + 1,
          });
          i += 2;
          continue;
        }
      }
    }
    result.push(a);
    i++;
  }
  return result;
}

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
  const resolved = mergeRangeConnectors(text, resolveOverlaps(all));
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
