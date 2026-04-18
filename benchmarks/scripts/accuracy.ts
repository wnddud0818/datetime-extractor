import fs from "node:fs";
import path from "node:path";
import { extract, cacheClear } from "../../src/index.js";
import { runRules } from "../../src/rules/engine.js";
import {
  formatRange,
  getFilterKind,
  parseReferenceDate,
  resolveExpression,
} from "../../src/resolver/resolve.js";
import type { DateExpression } from "../../src/types.js";
import { sourceDatasetsDir } from "./paths.js";

/**
 * test_results.csv에서 text/final_start_date/final_end_date를 읽어
 * 라이브러리 결과와 비교하여 정확도 측정.
 *
 * 규칙:
 *  - 같은 text가 여러 행으로 나오면 해당 행 수만큼의 expression을 기대
 *  - 기대 start/end가 비어있으면 hasDate=false 또는 결과 무시
 *  - 날짜 포맷: CSV는 "YYYY.M.D" → 비교 시 "YYYY-MM-DD"로 정규화
 */

const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const CSV = args[0] ?? path.join(sourceDatasetsDir, "test_results.csv");
const REFERENCE_DATE = "2025-11-17";
const DEFAULT_TO_TODAY = process.argv.includes("--default-to-today");
const RULE_ONLY = process.argv.includes("--rule-only");
const PRESENT_RANGE_END: "period" | "today" = process.argv.includes(
  "--present-today",
)
  ? "today"
  : "period";

interface Row {
  text: string;
  start: string | null;
  end: string | null;
}

function parseCSV(raw: string): Row[] {
  if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
  const lines: Row[] = [];
  const rows = raw.split(/\r?\n/).filter((l) => l.length > 0);
  const header = rows.shift()!;
  const headerCols = parseCsvLine(header);
  const iText = headerCols.indexOf("text");
  const iStart = headerCols.indexOf("final_start_date");
  const iEnd = headerCols.indexOf("final_end_date");
  for (const r of rows) {
    const cols = parseCsvLine(r);
    const text = cols[iText]?.trim() ?? "";
    if (!text) continue;
    lines.push({
      text,
      start: normalizeDate(cols[iStart]),
      end: normalizeDate(cols[iEnd]),
    });
  }
  return lines;
}

function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuote) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') {
        inQuote = false;
      } else {
        cur += ch;
      }
    } else {
      if (ch === '"') inQuote = true;
      else if (ch === ",") {
        out.push(cur);
        cur = "";
      } else cur += ch;
    }
  }
  out.push(cur);
  return out;
}

function normalizeDate(s: string | undefined): string | null {
  if (!s) return null;
  const t = s.trim();
  if (!t) return null;
  const m = /^(\d{4})[./-](\d{1,2})[./-](\d{1,2})$/.exec(t);
  if (!m) return null;
  return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
}

function groupByText(rows: Row[]): Map<string, Row[]> {
  const m = new Map<string, Row[]>();
  for (const r of rows) {
    const arr = m.get(r.text);
    if (arr) arr.push(r);
    else m.set(r.text, [r]);
  }
  return m;
}

function rangesMatch(
  actualStart: string,
  actualEnd: string,
  expectedStart: string | null,
  expectedEnd: string | null,
): boolean {
  if (!expectedStart || !expectedEnd) return false;
  return actualStart === expectedStart && actualEnd === expectedEnd;
}

function pickBestRange(
  results: Array<{ mode: string; value: unknown }>,
): { start: string; end: string } | null {
  // range 모드 우선, 없으면 single을 {start,end} 동일로 취급
  for (const r of results) {
    if (r.mode === "range") {
      const v = r.value as { start: string; end: string };
      return { start: v.start, end: v.end };
    }
  }
  for (const r of results) {
    if (r.mode === "single") {
      const v = r.value as string;
      return { start: v, end: v };
    }
  }
  return null;
}

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

async function evaluateRuleOnly(text: string): Promise<{
  hasDate: boolean;
  path: string;
  actualRanges: Array<{ start: string; end: string }>;
}> {
  const timezone = "Asia/Seoul";
  const referenceDate = parseReferenceDate(REFERENCE_DATE);
  const ruleResult = runRules(text, "auto");
  const actualRanges: Array<{ start: string; end: string }> = [];

  for (const matched of ruleResult.expressions) {
    const range = resolveExpression(matched.expression, {
      referenceDate,
      timezone,
    });
    if (
      PRESENT_RANGE_END === "today" &&
      !isExplicitSubset(matched.expression) &&
      range.start <= referenceDate &&
      range.end > referenceDate
    ) {
      range.end = referenceDate;
    }
    const filter = getFilterKind(matched.expression);
    const formatted = await formatRange(range, "range", filter, {
      timezone,
      dateOnlyForDateModes: true,
    });
    if (formatted?.mode === "range") {
      actualRanges.push(formatted.value);
    }
  }

  const path =
    ruleResult.expressions.length === 0
      ? "rule_only:no_match"
      : ruleResult.confidence >= 1
        ? "rule_only:full"
        : "rule_only:partial";

  return {
    hasDate: ruleResult.expressions.length > 0,
    path,
    actualRanges,
  };
}

async function main() {
  const raw = fs.readFileSync(CSV, "utf-8");
  const rows = parseCSV(raw);
  const grouped = groupByText(rows);

  let totalRows = rows.length;
  let correctRows = 0;
  let partialCorrectRows = 0;
  let noExpectedRows = 0;
  let missedRows = 0;
  const mismatches: Array<{
    text: string;
    expected: Array<{ start: string | null; end: string | null }>;
    actual: Array<{ start: string; end: string }>;
    hasDate: boolean;
    path: string;
  }> = [];

  let idx = 0;
  for (const [text, expectedRows] of grouped) {
    idx++;
    cacheClear();
    const evaluation = RULE_ONLY
      ? await evaluateRuleOnly(text)
      : await extract({
          text,
          referenceDate: REFERENCE_DATE,
          outputModes: ["range", "single"],
          defaultToToday: DEFAULT_TO_TODAY,
          presentRangeEnd: PRESENT_RANGE_END,
        }).then((res) => ({
          hasDate: res.hasDate,
          path: res.meta.path,
          actualRanges: res.expressions
            .map((e) => pickBestRange(e.results))
            .filter(Boolean) as Array<{ start: string; end: string }>,
        }));
    const actualRanges = evaluation.actualRanges;

    const expectedHasDate = expectedRows.some((r) => r.start && r.end);
    if (!expectedHasDate) {
      // 기대값이 비어있는 행 (애매하거나 날짜 없음)
      noExpectedRows += expectedRows.length;
      // 라이브러리가 hasDate=false 또는 무관한 결과면 "통과"로 취급
      continue;
    }

    // 각 expected row가 actualRanges 중 하나와 매치되는지 확인
    const matchedIdx = new Set<number>();
    let localCorrect = 0;
    for (const exp of expectedRows) {
      if (!exp.start || !exp.end) continue;
      const hit = actualRanges.findIndex(
        (a, i) =>
          !matchedIdx.has(i) && rangesMatch(a.start, a.end, exp.start, exp.end),
      );
      if (hit >= 0) {
        matchedIdx.add(hit);
        localCorrect++;
      }
    }
    correctRows += localCorrect;
    const dateExpectedCount = expectedRows.filter(
      (r) => r.start && r.end,
    ).length;
    if (localCorrect < dateExpectedCount) {
      missedRows += dateExpectedCount - localCorrect;
      if (localCorrect > 0) partialCorrectRows++;
      mismatches.push({
        text,
        expected: expectedRows.map((r) => ({ start: r.start, end: r.end })),
        actual: actualRanges,
        hasDate: evaluation.hasDate,
        path: evaluation.path,
      });
    }

    if (idx % 100 === 0 || idx === grouped.size) {
      console.log(`processed ${idx}/${grouped.size}`);
    }
  }

  const expectedDateRows = totalRows - noExpectedRows;
  console.log(`\n=== 채점 결과 (refDate: ${REFERENCE_DATE}, mode: ${RULE_ONLY ? "rule-only" : "hybrid"}) ===`);
  console.log(`전체 행:            ${totalRows}`);
  console.log(`unique text:       ${grouped.size}`);
  console.log(`기대값 없는 행 (스킵): ${noExpectedRows}`);
  console.log(`기대값 있는 행:      ${expectedDateRows}`);
  console.log(`정답 행:            ${correctRows} (${((correctRows / expectedDateRows) * 100).toFixed(1)}%)`);
  console.log(`오답 행:            ${missedRows}`);
  console.log(`부분 정답 텍스트:    ${partialCorrectRows}개`);

  // 오답 상위 30개 샘플
  console.log(`\n=== 오답 샘플 (최대 30개) ===`);
  for (const m of mismatches.slice(0, 30)) {
    console.log(`"${m.text}" [path=${m.path}, hasDate=${m.hasDate}]`);
    console.log(
      `  expected: ${m.expected.map((e) => `${e.start}~${e.end}`).join(", ")}`,
    );
    console.log(
      `  actual:   ${m.actual.map((a) => `${a.start}~${a.end}`).join(", ") || "(없음)"}`,
    );
  }

  // 오답 카테고리 분석
  console.log(`\n=== 오답 카테고리 분석 ===`);
  const noDateInQuery = mismatches.filter(
    (m) => !m.hasDate && m.actual.length === 0,
  );
  const wrongDate = mismatches.filter((m) => m.hasDate && m.actual.length > 0);
  console.log(`  날짜 전혀 감지 못 함: ${noDateInQuery.length}개`);
  console.log(`  날짜 감지했으나 값 틀림: ${wrongDate.length}개`);

  // 만약 "날짜 없음 → 오늘" 규칙을 적용한다면?
  const todayIso = REFERENCE_DATE;
  const wouldBeFixedByDefault = noDateInQuery.filter((m) =>
    m.expected.every((e) => e.start === todayIso && e.end === todayIso),
  );
  console.log(
    `  └ '오늘' 기본값 적용 시 정답으로 전환될 케이스: ${wouldBeFixedByDefault.length}개`,
  );

  const stillMissed =
    noDateInQuery.length - wouldBeFixedByDefault.length;
  console.log(
    `  └ '오늘' 기본값 적용해도 여전히 오답: ${stillMissed}개 (기간 쿼리지만 룰 미커버)`,
  );

  const wouldBeAccuracy =
    ((correctRows + wouldBeFixedByDefault.length) / expectedDateRows) * 100;
  console.log(
    `\n 💡 'defaultToToday' 옵션 추가 시 예상 정확도: ${wouldBeAccuracy.toFixed(1)}%`,
  );

  // wrong 카테고리 세부 분석
  console.log(`\n=== 값 틀림 세부 분류 ===`);
  let monthWideRange = 0;
  let wrongYear = 0;
  let wrongQuarter = 0;
  let other = 0;
  for (const m of wrongDate) {
    const exp = m.expected[0];
    const act = m.actual[0];
    if (!exp.start || !exp.end) continue;
    // 이번달 전체 vs 이번달~오늘
    if (
      act.start === exp.start &&
      act.end !== exp.end &&
      act.end.slice(0, 7) === exp.end.slice(0, 7)
    ) {
      monthWideRange++;
    } else if (act.start.slice(0, 4) !== exp.start.slice(0, 4)) {
      wrongYear++;
    } else if (
      exp.end &&
      (exp.end.slice(5, 7) === "03" || exp.end.slice(5, 7) === "12") &&
      act.end.slice(5, 7) === "12"
    ) {
      wrongQuarter++;
    } else {
      other++;
    }
  }
  console.log(`  이번달/이번년 전체 범위 반환 (기대: 오늘까지): ${monthWideRange}개`);
  console.log(`  연도 해석 오류 (YYYY년 무시): ${wrongYear}개`);
  console.log(`  분기/"초/말" 해석 오류: ${wrongQuarter}개`);
  console.log(`  기타: ${other}개`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
