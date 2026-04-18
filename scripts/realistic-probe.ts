import { runRules } from "../src/rules/engine.js";
import {
  resolveExpression,
  formatRange,
  parseReferenceDate,
  getFilterKind,
} from "../src/resolver/resolve.js";
import type { OutputMode, ResolvedValue } from "../src/types.js";

type Expected =
  | { mode: "single"; value: string }
  | { mode: "range"; value: { start: string; end: string } }
  | { mode: "datetime"; value: { start: string; end: string } };

interface Case {
  text: string;
  expected: Expected;
}

const REF = "2026-04-18"; // Saturday
const TZ = "Asia/Seoul";

// 모두 정답이 명확한 표현만 포함. "쯤/근처/늦게/매주/요즘/연휴" 등 모호 표현은 제외.
const CASES: Case[] = [
  // 이미 통과 (회귀 감시)
  { text: "다음 주", expected: { mode: "range", value: { start: "2026-04-20", end: "2026-04-26" } } },
  { text: "다다음주 목요일 저녁", expected: { mode: "datetime", value: { start: "2026-04-30T18:00:00+09:00", end: "2026-04-30T21:00:00+09:00" } } },
  { text: "내일 새벽 1시", expected: { mode: "datetime", value: { start: "2026-04-19T01:00:00+09:00", end: "2026-04-19T01:00:00+09:00" } } },
  { text: "오늘 밤 9시", expected: { mode: "datetime", value: { start: "2026-04-18T21:00:00+09:00", end: "2026-04-18T21:00:00+09:00" } } },
  { text: "담주 화요일", expected: { mode: "single", value: "2026-04-21" } },

  // 현재 실패 — 수정 대상
  // 공휴일 ±1일
  { text: "크리스마스 전날", expected: { mode: "single", value: "2026-12-24" } },
  { text: "크리스마스 다음날", expected: { mode: "single", value: "2026-12-26" } },
  { text: "추석 다음날", expected: { mode: "single", value: "2026-09-26" } },
  { text: "설날 전날", expected: { mode: "single", value: "2026-02-16" } },

  // weekOfMonth 연도 선택 (현재 2025로 감)
  { text: "6월 첫째 주", expected: { mode: "range", value: { start: "2026-06-01", end: "2026-06-07" } } },

  // weekOfMonth + 주말 필터
  { text: "6월 첫째 주 주말", expected: { mode: "range", value: { start: "2026-06-06", end: "2026-06-07" } } },

  // 이번/다음 주말 (range 모드에서 토-일만 반환)
  { text: "이번 주 주말", expected: { mode: "range", value: { start: "2026-04-18", end: "2026-04-19" } } },
  { text: "다음 주 주말", expected: { mode: "range", value: { start: "2026-04-25", end: "2026-04-26" } } },

  // 날짜 + 기간 결합
  { text: "오늘부터 일주일간", expected: { mode: "range", value: { start: "2026-04-18", end: "2026-04-24" } } },
];

function eq(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

async function runOne(tc: Case) {
  const ref = parseReferenceDate(REF);
  const rule = runRules(tc.text, "auto");
  if (rule.expressions.length === 0) {
    return { pass: false, got: null as ResolvedValue | null, confidence: rule.confidence, matchedText: null as string | null };
  }

  // 첫 매치 기준 비교. 다중 매치는 탐지 안 됨.
  const matched = rule.expressions[0];
  const range = resolveExpression(matched.expression, { referenceDate: ref, timezone: TZ });
  const filter = getFilterKind(matched.expression);
  const formatted = await formatRange(range, tc.expected.mode, filter, { timezone: TZ });
  const pass = eq(formatted?.value, tc.expected.value);
  return { pass, got: formatted, confidence: rule.confidence, matchedText: matched.text };
}

async function main() {
  console.log(`reference=${REF}  tz=${TZ}\n`);
  let passed = 0;
  for (const tc of CASES) {
    const r = await runOne(tc);
    const badge = r.pass ? "PASS" : "FAIL";
    console.log(`[${badge}] ${tc.text}`);
    console.log(`  expect : ${tc.expected.mode}=${JSON.stringify(tc.expected.value)}`);
    if (r.got) {
      console.log(`  got    : ${r.got.mode}=${JSON.stringify(r.got.value)}   (match="${r.matchedText}", conf=${r.confidence.toFixed(2)})`);
    } else {
      console.log(`  got    : NO MATCH   (conf=${r.confidence.toFixed(2)})`);
    }
    if (r.pass) passed++;
  }
  const pct = ((passed / CASES.length) * 100).toFixed(1);
  console.log(`\n${passed}/${CASES.length} (${pct}%)`);
  process.exit(passed === CASES.length ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
