import fs from "node:fs";
import path from "node:path";
import {
  addDays,
  addMonths,
  addWeeks,
  addYears,
  endOfMonth,
  endOfQuarter,
  endOfWeek,
  endOfYear,
  format,
  parseISO,
  startOfMonth,
  startOfQuarter,
  startOfWeek,
  startOfYear,
} from "date-fns";
import { Ollama } from "ollama";
import { cacheClear, extract, warmUp } from "../src/index.js";

process.loadEnvFile?.(".env");

type RangeExp = { start: string; end: string };

interface Spec {
  id: string;
  category: "single_date" | "lifecycle" | "comparison" | "no_date";
  requiredPhrases: string[];
  expected: RangeExp[];
  scenario: string;
  styleHint: string;
}

interface GeneratedCase {
  id: string;
  category: Spec["category"];
  text: string;
  referenceDate: string;
  presentRangeEnd: "today";
  expected: RangeExp[];
  generation: "ollama" | "fallback";
  requiredPhrases: string[];
  scenario: string;
}

interface GenerationResponse {
  items: Array<{ id: string; text: string }>;
}

interface EvalResult {
  total: number;
  passed: number;
  accuracy: number;
  byCategory: Array<{
    category: Spec["category"];
    total: number;
    passed: number;
    accuracy: number;
  }>;
  byPath: Array<{ path: string; count: number }>;
  failures: Array<{
    id: string;
    text: string;
    category: Spec["category"];
    path: string;
    expected: RangeExp[];
    actual: RangeExp[];
    issues: string[];
  }>;
}

const DEFAULT_HOST = normalizeHost(
  process.env.OLLAMA_HOST ?? "http://localhost:11434",
);
const DEFAULT_MODEL = process.env.OLLAMA_MODEL ?? "gemma4:e2b";
const REFERENCE_DATE = "2025-11-17";
const ref = parseISO(`${REFERENCE_DATE}T00:00:00`);

const client = new Ollama({ host: DEFAULT_HOST });

const projectRoot = process.cwd();
const benchmarkDir = path.join(projectRoot, "benchmarks");
const jsonPath = path.join(benchmarkDir, "humanlike-500.json");
const csvPath = path.join(benchmarkDir, "humanlike-500.csv");
const reportPath = path.join(benchmarkDir, "humanlike-500-report.json");
const sourceCsvPath = "/Users/parkjungyeong/Downloads/test_results11111.csv";

const outputSchema = {
  type: "object",
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          text: { type: "string" },
        },
        required: ["id", "text"],
      },
    },
  },
  required: ["items"],
} as const;

const styleHints = [
  "짧고 단도직입적인 톤",
  "실무자가 급하게 물어보는 톤",
  "조금 공손한 질문형",
  "메신저에 치듯 자연스러운 톤",
  "보고서 확인 요청처럼 차분한 톤",
  "살짝 구어체인 톤",
  "분석을 부탁하는 톤",
  "간단히 확인만 요청하는 톤",
  "비교를 바로 하고 싶은 톤",
  "잔액을 바로 알고 싶은 톤",
];

const singleTimePhrases: Array<{ phrase: string; expected: RangeExp[] }> = [
  { phrase: "오늘", expected: [dayRange(ref)] },
  { phrase: "어제", expected: [dayRange(addDays(ref, -1))] },
  { phrase: "그제", expected: [dayRange(addDays(ref, -2))] },
  { phrase: "그저께", expected: [dayRange(addDays(ref, -2))] },
  { phrase: "엊그제", expected: [dayRange(addDays(ref, -2))] },
  { phrase: "사흘 전", expected: [dayRange(addDays(ref, -3))] },
  { phrase: "나흘 전", expected: [dayRange(addDays(ref, -4))] },
  { phrase: "보름 전", expected: [dayRange(addDays(ref, -15))] },
  { phrase: "일주일 전", expected: [dayRange(addDays(ref, -7))] },
  { phrase: "지난주", expected: [weekOffsetRange(-1)] },
  { phrase: "이번 주", expected: [weekOffsetRange(0)] },
  { phrase: "지난달", expected: [monthOffsetRange(-1)] },
  { phrase: "이번 달", expected: [monthOffsetRange(0)] },
  { phrase: "3월", expected: [monthOnlyPastRange(3)] },
  { phrase: "8월", expected: [monthOnlyPastRange(8)] },
  { phrase: "올해", expected: [yearOffsetRange(0)] },
  { phrase: "작년", expected: [yearOffsetRange(-1)] },
  { phrase: "재작년", expected: [yearOffsetRange(-2)] },
  { phrase: "이번분기", expected: [quarterOffsetRange(0)] },
  { phrase: "지난분기", expected: [quarterOffsetRange(-1)] },
  { phrase: "4분기", expected: [quarterRange(ref.getFullYear(), 4)] },
  { phrase: "하반기", expected: [halfRange(ref.getFullYear(), 2)] },
  { phrase: "1분기", expected: [quarterRange(ref.getFullYear(), 1)] },
  { phrase: "2024년 2월", expected: [explicitMonthRange(2024, 2)] },
  { phrase: "2023년", expected: [explicitYearRange(2023)] },
];

const singleScenarios = [
  "예적금 계좌 흐름이 어땠는지 보고 싶어",
  "대출 쪽 잔액만 따로 확인하고 싶어",
  "외화 계좌 거래 내역을 정리해서 보여줘",
  "증권 계좌에서 빠져나간 돈만 보고 싶어",
  "신탁 계좌 입출금 흐름을 확인해줘",
  "수시입출 계좌 움직임이 어땠는지 알고 싶어",
  "운영비 비중이 어느 정도였는지 보고 싶어",
  "삼성전자랑 거래한 비중이 얼마나 되는지 궁금해",
  "큰 금액 거래만 골라서 확인하고 싶어",
  "자금 증감 흐름을 한눈에 보고 싶어",
];

const lifecyclePhrases: Array<{ phrases: string[]; expected: RangeExp[] }> = [
  { phrases: ["2024년 7월 31일"], expected: [explicitDayRange(2024, 7, 31)] },
  { phrases: ["2014년 7월 31일"], expected: [explicitDayRange(2014, 7, 31)] },
  { phrases: ["2027년 2월 1일부터 7일까지"], expected: [explicitRange(2027, 2, 1, 2027, 2, 7)] },
  { phrases: ["2027년 1월 31일"], expected: [explicitDayRange(2027, 1, 31)] },
  { phrases: ["2032년 1분기"], expected: [quarterRange(2032, 1)] },
  { phrases: ["2029년 12월"], expected: [explicitMonthRange(2029, 12)] },
  { phrases: ["2020년 2월"], expected: [explicitMonthRange(2020, 2)] },
  { phrases: ["2026년 8월"], expected: [explicitMonthRange(2026, 8)] },
  { phrases: ["2025년 3월 1일"], expected: [explicitDayRange(2025, 3, 1)] },
  { phrases: ["2024년 10월 9일"], expected: [explicitDayRange(2024, 10, 9)] },
  { phrases: ["2028년 상반기"], expected: [halfRange(2028, 1)] },
  { phrases: ["2028년 하반기"], expected: [halfRange(2028, 2)] },
  { phrases: ["2026년 1분기"], expected: [quarterRange(2026, 1)] },
  { phrases: ["2027년 4분기"], expected: [quarterRange(2027, 4)] },
  { phrases: ["2023년 1월 1일부터 10일까지"], expected: [explicitRange(2023, 1, 1, 2023, 1, 10)] },
  { phrases: ["2024년 5월"], expected: [explicitMonthRange(2024, 5)] },
  { phrases: ["2023년 12월"], expected: [explicitMonthRange(2023, 12)] },
  { phrases: ["2027년 2월"], expected: [explicitMonthRange(2027, 2)] },
  { phrases: ["2026년 3월"], expected: [explicitMonthRange(2026, 3)] },
  { phrases: ["2024년 2월"], expected: [explicitMonthRange(2024, 2)] },
];

const lifecycleScenarios = [
  "에 만기되는 계좌만 추려줘",
  "에 개설된 계좌가 뭐였는지 찾아줘",
  "에 남아 있던 잔액을 보고 싶어",
  "에 신규 개설된 계좌 거래내역만 보고 싶어",
  "에 가입한 상품이 있었는지 확인해줘",
];

const pairPhrases: Array<{ phrases: string[]; expected: RangeExp[] }> = [
  { phrases: ["지난달", "이번 달"], expected: [monthOffsetRange(-1), monthOffsetRange(0)] },
  { phrases: ["작년", "올해"], expected: [yearOffsetRange(-1), yearOffsetRange(0)] },
  { phrases: ["지난분기", "이번분기"], expected: [quarterOffsetRange(-1), quarterOffsetRange(0)] },
  { phrases: ["3월", "4월"], expected: [monthOnlyPastRange(3), monthOnlyPastRange(4)] },
  { phrases: ["재작년", "작년"], expected: [yearOffsetRange(-2), yearOffsetRange(-1)] },
  { phrases: ["지난주", "이번 주"], expected: [weekOffsetRange(-1), weekOffsetRange(0)] },
  { phrases: ["2024년", "2025년"], expected: [explicitYearRange(2024), explicitYearRange(2025)] },
  { phrases: ["2024년 2월", "2024년 3월"], expected: [explicitMonthRange(2024, 2), explicitMonthRange(2024, 3)] },
  { phrases: ["1분기", "2분기"], expected: [quarterRange(ref.getFullYear(), 1), quarterRange(ref.getFullYear(), 2)] },
  { phrases: ["작년 4분기", "올해 1분기"], expected: [quarterRange(2024, 4), quarterRange(2025, 1)] },
  { phrases: ["2025년 1분기", "2025년 2분기"], expected: [quarterRange(2025, 1), quarterRange(2025, 2)] },
  { phrases: ["2024년 상반기", "2024년 하반기"], expected: [halfRange(2024, 1), halfRange(2024, 2)] },
  { phrases: ["지난달", "올해"], expected: [monthOffsetRange(-1), yearOffsetRange(0)] },
  { phrases: ["지난분기", "올해"], expected: [quarterOffsetRange(-1), yearOffsetRange(0)] },
  { phrases: ["2023년", "2024년"], expected: [explicitYearRange(2023), explicitYearRange(2024)] },
  { phrases: ["2026년 3월", "2026년 8월"], expected: [explicitMonthRange(2026, 3), explicitMonthRange(2026, 8)] },
  { phrases: ["이번 주", "이번 달"], expected: [weekOffsetRange(0), monthOffsetRange(0)] },
  { phrases: ["작년", "올해 1분기"], expected: [yearOffsetRange(-1), quarterRange(2025, 1)] },
  { phrases: ["지난달", "4분기"], expected: [monthOffsetRange(-1), quarterRange(2025, 4)] },
  { phrases: ["2024년 10월", "2024년 12월"], expected: [explicitMonthRange(2024, 10), explicitMonthRange(2024, 12)] },
];

const pairScenarios = [
  "지출 흐름이 어떻게 달라졌는지 비교해줘",
  "잔액 차이만 바로 보이게 정리해줘",
  "입출금 흐름을 나란히 비교하고 싶어",
  "어느 쪽 거래 규모가 더 컸는지 알고 싶어",
  "같은 거래처 기준으로 비중을 비교해줘",
];

const noDateScenarios = [
  "예적금 잔액만 따로 보여줘",
  "대출 거래내역만 모아서 볼 수 있을까?",
  "외화 계좌가 몇 개인지 확인해줘",
  "증권 계좌 잔액을 큰 순서로 정렬해줘",
  "신탁 계좌에서 출금 큰 건만 보여줘",
  "수시입출 계좌 입금이 더 많은 계좌가 있는지 봐줘",
  "삼성전자랑 거래한 내역만 찾아줘",
  "은행별 잔액 현황을 보여줘",
  "달러 예수금이 얼마나 있는지 알려줘",
  "운용 가능한 자금이 얼마나 되는지 궁금해",
  "우리 회사가 보유한 상품 종류를 알려줘",
  "외화 계좌 잔액 합계가 얼마인지 봐줘",
  "거래가 제일 많은 계좌 하나만 보여줘",
  "입금이 없는 계좌가 있는지 확인해줘",
  "잔액이 큰 계좌부터 정렬해서 보여줘",
  "기업은행 쪽 거래내역만 따로 보고 싶어",
  "예금 금리가 높은 상품이 있는지 알려줘",
  "수수료 많이 나간 계좌를 찾아줘",
  "대출 계좌 중 금액이 큰 것만 보여줘",
  "증권 쪽 남은 돈이 얼마나 되는지 보고 싶어",
  "계좌별 잔액 합계를 계산해줘",
  "입출금 내역에서 이상 거래가 있는지 봐줘",
  "예적금 계좌 개수가 몇 개인지 알려줘",
  "웹케시랑 거래한 내역만 보고 싶어",
  "출금이 많은 순서대로 계좌를 보여줘",
  "외화 예적금 계좌만 따로 모아줘",
  "거래 적요별 개수를 정리해줘",
  "대출 원금이 큰 순서대로 보여줘",
  "신탁 상품별 잔액 현황을 보고 싶어",
  "증권 계좌 수익이 큰 것부터 보여줘",
  "은행별 자금 현황을 한눈에 보여줘",
  "계좌 중 비활성으로 보이는 게 있는지 알려줘",
  "입금만 있고 출금 없는 계좌를 찾아줘",
  "외화 대출이 있는지 확인해줘",
  "적금 계좌 잔액이 얼마나 남았는지 봐줘",
  "거래처별 비중을 정리해서 보여줘",
  "예수금이 많은 계좌만 골라줘",
  "상품별 거래내역을 나눠서 보고 싶어",
  "기업별 거래 금액 순위를 보여줘",
  "출금보다 입금이 많은 계좌를 보여줘",
  "예적금 해지 예정 계좌가 있는지 알려줘",
  "증권 거래내역을 최신순으로 정렬해줘",
  "대출 이자 납부 내역만 모아줘",
  "수시입출 계좌 잔액 합계를 계산해줘",
  "외화 거래가 있었던 계좌만 보여줘",
  "신탁 계좌가 몇 개나 있는지 궁금해",
  "잔액은 있는데 거래가 없는 계좌를 찾아줘",
  "보통예금 쪽 자금만 보고 싶어",
  "거래 많은 계좌를 상위 몇 개만 보여줘",
  "은행별 계좌 수를 알려줘",
];

function ymd(date: Date): string {
  return format(date, "yyyy-MM-dd");
}

function dayRange(date: Date): RangeExp {
  const iso = ymd(date);
  return { start: iso, end: iso };
}

function clampIfCurrent(start: Date, end: Date): RangeExp {
  if (start <= ref && end >= ref) {
    return { start: ymd(start), end: REFERENCE_DATE };
  }
  return { start: ymd(start), end: ymd(end) };
}

function weekOffsetRange(offset: number): RangeExp {
  const target = addWeeks(ref, offset);
  return clampIfCurrent(
    startOfWeek(target, { weekStartsOn: 1 }),
    endOfWeek(target, { weekStartsOn: 1 }),
  );
}

function monthOffsetRange(offset: number): RangeExp {
  const target = addMonths(ref, offset);
  return clampIfCurrent(startOfMonth(target), endOfMonth(target));
}

function yearOffsetRange(offset: number): RangeExp {
  const targetYear = ref.getFullYear() + offset;
  return clampIfCurrent(
    startOfYear(new Date(targetYear, 0, 1)),
    endOfYear(new Date(targetYear, 0, 1)),
  );
}

function monthOnlyPastRange(month: number): RangeExp {
  let year = ref.getFullYear();
  if (new Date(year, month - 1, 1) > ref) year -= 1;
  return { start: `${year}-${pad(month)}-01`, end: ymd(endOfMonth(new Date(year, month - 1, 1))) };
}

function quarterRange(year: number, quarter: 1 | 2 | 3 | 4): RangeExp {
  const start = new Date(year, (quarter - 1) * 3, 1);
  return clampIfCurrent(start, endOfQuarter(start));
}

function quarterOffsetRange(offset: number): RangeExp {
  const target = addMonths(startOfQuarter(ref), offset * 3);
  return clampIfCurrent(target, endOfQuarter(target));
}

function halfRange(year: number, half: 1 | 2): RangeExp {
  const startMonth = half === 1 ? 0 : 6;
  const start = new Date(year, startMonth, 1);
  return clampIfCurrent(start, endOfMonth(new Date(year, startMonth + 5, 1)));
}

function explicitYearRange(year: number): RangeExp {
  return clampIfCurrent(new Date(year, 0, 1), new Date(year, 11, 31));
}

function explicitMonthRange(year: number, month: number): RangeExp {
  return clampIfCurrent(new Date(year, month - 1, 1), endOfMonth(new Date(year, month - 1, 1)));
}

function explicitDayRange(year: number, month: number, day: number): RangeExp {
  const iso = `${year}-${pad(month)}-${pad(day)}`;
  return { start: iso, end: iso };
}

function explicitRange(
  sy: number,
  sm: number,
  sd: number,
  ey: number,
  em: number,
  ed: number,
): RangeExp {
  return {
    start: `${sy}-${pad(sm)}-${pad(sd)}`,
    end: `${ey}-${pad(em)}-${pad(ed)}`,
  };
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function buildSpecs(): Spec[] {
  const specs: Spec[] = [];

  for (let i = 0; i < singleTimePhrases.length; i++) {
    for (let j = 0; j < singleScenarios.length; j++) {
      specs.push({
        id: `single-${i + 1}-${j + 1}`,
        category: "single_date",
        requiredPhrases: [singleTimePhrases[i].phrase],
        expected: singleTimePhrases[i].expected,
        scenario: singleScenarios[j],
        styleHint: styleHints[(i + j) % styleHints.length],
      });
    }
  }

  for (let i = 0; i < lifecyclePhrases.length; i++) {
    for (let j = 0; j < lifecycleScenarios.length; j++) {
      specs.push({
        id: `life-${i + 1}-${j + 1}`,
        category: "lifecycle",
        requiredPhrases: lifecyclePhrases[i].phrases,
        expected: lifecyclePhrases[i].expected,
        scenario: lifecycleScenarios[j],
        styleHint: styleHints[(i * 2 + j) % styleHints.length],
      });
    }
  }

  for (let i = 0; i < pairPhrases.length; i++) {
    for (let j = 0; j < pairScenarios.length; j++) {
      specs.push({
        id: `pair-${i + 1}-${j + 1}`,
        category: "comparison",
        requiredPhrases: pairPhrases[i].phrases,
        expected: pairPhrases[i].expected,
        scenario: pairScenarios[j],
        styleHint: styleHints[(i + j * 3) % styleHints.length],
      });
    }
  }

  for (let i = 0; i < noDateScenarios.length; i++) {
    specs.push({
      id: `none-${i + 1}`,
      category: "no_date",
      requiredPhrases: [],
      expected: [],
      scenario: noDateScenarios[i],
      styleHint: styleHints[i % styleHints.length],
    });
  }

  if (specs.length !== 500) {
    throw new Error(`Expected 500 specs, got ${specs.length}`);
  }

  return specs;
}

function loadSourceTexts(): Set<string> {
  const raw = fs.readFileSync(sourceCsvPath, "utf8").replace(/^\uFEFF/, "");
  const lines = raw.trim().split(/\r?\n/).slice(1);
  const out = new Set<string>();
  for (const line of lines) {
    const [text] = parseCsvLine(line);
    if (text) out.add(text);
  }
  return out;
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
    } else if (ch === '"') {
      inQuote = true;
    } else if (ch === ",") {
      out.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

async function generateBatch(batch: Spec[], batchIndex: number): Promise<Map<string, string>> {
  const examples = [
    "외화 대출 계좌 잔액",
    "이번 달 운영비의 비율은 어떻게 되나요?",
    "2029년 말에 만기되는 대출 계좌를 조회해줘.",
    "지난달에 원티드랩 이체 내역",
    "수시입출계좌와 예적금계좌의 이번 주 거래 내역",
  ];
  const prompt = [
    "샘플 문체(베끼지 말고 분위기만 참고):",
    ...examples.map((ex) => `- ${ex}`),
    "",
    "아래 items 각각에 대해 실제 한국어 금융 서비스 사용자가 입력할 법한 새 문장 1개씩 만들어라.",
    "규칙:",
    "- requiredPhrases의 문구는 문장에 그대로 포함한다.",
    "- 날짜 의미를 바꾸는 다른 시간 표현을 추가하지 않는다.",
    "- 문장은 자연스럽고 다양하게 쓴다. 템플릿 티가 나지 않게 한다.",
    "- 한 item당 한 문장만 만든다.",
    "- no_date 카테고리는 시간 표현을 절대 넣지 않는다.",
    "- 기존 샘플 문장을 그대로 복사하지 않는다.",
    "",
    "items:",
    ...batch.map((spec) =>
      JSON.stringify({
        id: spec.id,
        category: spec.category,
        requiredPhrases: spec.requiredPhrases,
        scenario: spec.scenario,
        styleHint: spec.styleHint,
      }),
    ),
  ].join("\n");

  const res = await client.chat({
    model: DEFAULT_MODEL,
    messages: [
      {
        role: "system",
        content:
          "당신은 한국의 기업금융/자금관리 서비스에서 사용자가 실제로 입력할 법한 자연스러운 질문 문장을 쓰는 도우미다. JSON만 출력한다.",
      },
      { role: "user", content: prompt },
    ],
    format: outputSchema as object,
    think: false as never,
    options: {
      temperature: 0.8,
      seed: 1000 + batchIndex,
      num_predict: 3200,
      num_ctx: 8192,
    },
    keep_alive: "10m",
  });

  const content = sanitizeJsonText(res.message?.content ?? "");
  const parsed = JSON.parse(content) as GenerationResponse;
  return new Map(parsed.items.map((item) => [item.id, item.text]));
}

function sanitizeJsonText(content: string): string {
  const trimmed = content.trim();
  if (trimmed.startsWith("```")) {
    const withoutFence = trimmed
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```$/, "");
    return withoutFence.trim();
  }
  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    return trimmed.slice(firstBrace, lastBrace + 1);
  }
  return trimmed;
}

function hasDateSignal(text: string): boolean {
  return /(오늘|어제|내일|그제|그저께|엊그제|사흘|나흘|보름|일주일|지난|이번|작년|올해|재작년|분기|상반기|하반기|\d{4}년|\d{1,2}월|\d{1,2}일|최근)/.test(
    text,
  );
}

function validateText(
  text: string,
  spec: Spec,
  existing: Set<string>,
  generated: Set<string>,
): boolean {
  const trimmed = text.trim();
  if (trimmed.length < 6) return false;
  if (existing.has(trimmed) || generated.has(trimmed)) return false;
  if (spec.category === "no_date") return !hasDateSignal(trimmed);
  return spec.requiredPhrases.every((phrase) => trimmed.includes(phrase));
}

function fallbackText(spec: Spec, attempt: number): string {
  const variants = [
    (base: string) => base,
    (base: string) => `${base} 한번 봐줘`,
    (base: string) => `${base} 확인 부탁해`,
    (base: string) => `${base} 궁금해`,
    (base: string) => `${base} 정리해줘`,
  ];

  let base: string;
  if (spec.category === "comparison") {
    base = `${spec.requiredPhrases[0]}랑 ${spec.requiredPhrases[1]} ${spec.scenario}`;
  } else if (spec.category === "no_date") {
    base = spec.scenario;
  } else if (spec.scenario.startsWith("에 ")) {
    base = `${spec.requiredPhrases[0]}${spec.scenario}`;
  } else {
    base = `${spec.requiredPhrases[0]} ${spec.scenario}`;
  }
  return variants[attempt % variants.length](base).replace(/\s+/g, " ").trim();
}

async function generateCases(specs: Spec[]): Promise<GeneratedCase[]> {
  const sourceTexts = loadSourceTexts();
  const generatedTexts = new Set<string>();
  const cases: GeneratedCase[] = [];
  const useOllama = process.argv.includes("--ollama");

  if (useOllama) {
    await warmUp();
  }

  const chunkSize = 25;
  for (let i = 0; i < specs.length; i += chunkSize) {
    const batch = specs.slice(i, i + chunkSize);
    console.log(`generating batch ${i / chunkSize + 1}/${Math.ceil(specs.length / chunkSize)}`);
    let outputs = new Map<string, string>();
    if (useOllama) {
      try {
        outputs = await generateBatch(batch, i / chunkSize);
      } catch (error) {
        console.log(`  ollama batch failed, using fallback: ${String(error)}`);
      }
    }

    for (let j = 0; j < batch.length; j++) {
      const spec = batch[j];
      let text = outputs.get(spec.id)?.trim() ?? "";
      let source: GeneratedCase["generation"] = "ollama";

      if (!validateText(text, spec, sourceTexts, generatedTexts)) {
        source = "fallback";
        let chosen = "";
        for (let attempt = 0; attempt < 8; attempt++) {
          const candidate = composeHumanlikeText(spec, attempt + j);
          if (validateText(candidate, spec, sourceTexts, generatedTexts)) {
            chosen = candidate;
            break;
          }
        }
        text = chosen || composeHumanlikeText(spec, j + 11);
      }

      generatedTexts.add(text);
      cases.push({
        id: spec.id,
        category: spec.category,
        text,
        referenceDate: REFERENCE_DATE,
        presentRangeEnd: "today",
        expected: spec.expected,
        generation: source,
        requiredPhrases: spec.requiredPhrases,
        scenario: spec.scenario,
      });
    }
  }

  return cases;
}

function stable(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`)
    .join(",")}}`;
}

function eq(a: unknown, b: unknown): boolean {
  return stable(a) === stable(b);
}

function normalizeHost(host: string): string {
  return host.replace("://localhost", "://127.0.0.1");
}

function pickBestRange(results: Array<{ mode: string; value: unknown }>): RangeExp | null {
  for (const result of results) {
    if (result.mode === "range") return result.value as RangeExp;
  }
  for (const result of results) {
    if (result.mode === "single") {
      const v = result.value as string;
      return { start: v, end: v };
    }
  }
  return null;
}

async function evaluate(cases: GeneratedCase[]): Promise<EvalResult> {
  const byCategory = new Map<
    Spec["category"],
    { total: number; passed: number }
  >();
  const byPath = new Map<string, number>();
  const failures: EvalResult["failures"] = [];

  let passed = 0;

  for (let i = 0; i < cases.length; i++) {
    const testCase = cases[i];
    cacheClear();
    const res = await extract({
      text: testCase.text,
      referenceDate: testCase.referenceDate,
      outputModes: ["range", "single"],
      presentRangeEnd: testCase.presentRangeEnd,
    });

    const actualRanges = res.expressions
      .map((expr) => pickBestRange(expr.results))
      .filter(Boolean) as RangeExp[];
    const expectedRanges = testCase.expected;
    const issues: string[] = [];
    let ok = true;

    if (expectedRanges.length === 0) {
      if (res.hasDate || actualRanges.length > 0) {
        ok = false;
        issues.push("expected no date, but got date");
      }
    } else {
      if (!res.hasDate) {
        ok = false;
        issues.push("hasDate=false");
      }
      if (actualRanges.length !== expectedRanges.length) {
        ok = false;
        issues.push(
          `range count mismatch expected=${expectedRanges.length} actual=${actualRanges.length}`,
        );
      }
      for (const exp of expectedRanges) {
        const hit = actualRanges.some((act) => eq(act, exp));
        if (!hit) {
          ok = false;
          issues.push(`missing expected range ${stable(exp)}`);
        }
      }
    }

    const cat = byCategory.get(testCase.category) ?? { total: 0, passed: 0 };
    cat.total += 1;
    if (ok) {
      passed += 1;
      cat.passed += 1;
    } else if (failures.length < 30) {
      failures.push({
        id: testCase.id,
        text: testCase.text,
        category: testCase.category,
        path: res.meta.path,
        expected: expectedRanges,
        actual: actualRanges,
        issues,
      });
    }
    byCategory.set(testCase.category, cat);
    byPath.set(res.meta.path, (byPath.get(res.meta.path) ?? 0) + 1);

    if ((i + 1) % 100 === 0 || i === cases.length - 1) {
      console.log(`evaluated ${i + 1}/${cases.length}`);
    }
  }

  return {
    total: cases.length,
    passed,
    accuracy: Number(((passed / cases.length) * 100).toFixed(2)),
    byCategory: [...byCategory.entries()]
      .map(([category, stats]) => ({
        category,
        total: stats.total,
        passed: stats.passed,
        accuracy: Number(((stats.passed / stats.total) * 100).toFixed(2)),
      }))
      .sort((a, b) => a.category.localeCompare(b.category)),
    byPath: [...byPath.entries()]
      .map(([pathName, count]) => ({ path: pathName, count }))
      .sort((a, b) => a.path.localeCompare(b.path)),
    failures,
  };
}

function csvEscape(value: string): string {
  if (/[",\n]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

function composeHumanlikeText(spec: Spec, variant: number): string {
  const tone = variant % 8;
  if (spec.category === "no_date") {
    const patterns = [
      `${spec.scenario}`,
      `${spec.scenario} 좀 확인해줘`,
      `${spec.scenario} 볼 수 있을까?`,
      `${spec.scenario} 먼저 보고 싶어`,
      `${spec.scenario} 한 번만 정리해줘`,
      `${spec.scenario} 바로 알려줘`,
      `${spec.scenario} 확인 부탁해`,
      `${spec.scenario} 간단히 보여줘`,
    ];
    return patterns[tone];
  }

  if (spec.category === "comparison") {
    const [a, b] = spec.requiredPhrases;
    const patterns = [
      `${a}이랑 ${b} ${spec.scenario}`,
      `${a}하고 ${b} ${spec.scenario}`,
      `${a} 기준이랑 ${b} 기준 ${spec.scenario}`,
      `${a} 때랑 ${b} 때 ${spec.scenario}`,
      `${a}하고 ${b}를 같이 놓고 ${spec.scenario}`,
      `${a}, ${b} 두 구간 ${spec.scenario}`,
      `${a} 쪽이랑 ${b} 쪽 ${spec.scenario}`,
      `${a}하고 ${b} 건 ${spec.scenario}`,
    ];
    return patterns[tone];
  }

  const phrase = spec.requiredPhrases[0];
  if (spec.category === "lifecycle") {
    const tail = spec.scenario.replace(/^에\s*/, "");
    const connector = phrase.includes("부터") && phrase.includes("까지")
      ? " 사이에 "
      : "에 ";
    const patterns = [
      `${phrase}${connector}${tail}`,
      `${phrase}${connector}${tail} 좀 볼 수 있을까?`,
      `${phrase}${connector}${tail} 먼저 확인해줘`,
      `${phrase}${connector}${tail} 한 번 정리해줘`,
      `${phrase}${connector}${tail} 있는지 알려줘`,
      `${phrase}${connector}${tail} 부탁해`,
      `${phrase}${connector}${tail} 바로 보고 싶어`,
      `${phrase}${connector}${tail} 체크해줘`,
    ];
    return patterns[tone];
  }

  const patterns = [
    `${phrase} ${spec.scenario}`,
    `${phrase} 기준으로 ${spec.scenario}`,
    `${phrase}만 놓고 ${spec.scenario}`,
    `${phrase} 기준 ${spec.scenario}`,
    `${phrase} 데이터로 ${spec.scenario}`,
    `${phrase} 시점으로 ${spec.scenario}`,
    `${phrase} 상황만 놓고 ${spec.scenario}`,
    `${phrase} 기준으로만 보면 ${spec.scenario}`,
  ];
  return patterns[tone];
}

function writeArtifacts(cases: GeneratedCase[], report: EvalResult) {
  fs.mkdirSync(benchmarkDir, { recursive: true });
  fs.writeFileSync(
    jsonPath,
    `${JSON.stringify(
      {
        referenceDate: REFERENCE_DATE,
        presentRangeEnd: "today",
        cases,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  const rows = ["text,final_start_date,final_end_date"];
  for (const testCase of cases) {
    if (testCase.expected.length === 0) {
      rows.push(`${csvEscape(testCase.text)},,`);
      continue;
    }
    for (const exp of testCase.expected) {
      rows.push(
        [
          csvEscape(testCase.text),
          csvEscape(exp.start),
          csvEscape(exp.end),
        ].join(","),
      );
    }
  }
  fs.writeFileSync(csvPath, `${rows.join("\n")}\n`, "utf8");
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
}

async function main() {
  const specs = buildSpecs();
  const cases = await generateCases(specs);
  const report = await evaluate(cases);
  writeArtifacts(cases, report);

  const sourceBreakdown = cases.reduce<Record<string, number>>((acc, item) => {
    acc[item.generation] = (acc[item.generation] ?? 0) + 1;
    return acc;
  }, {});

  console.log(`\nwritten: ${jsonPath}`);
  console.log(`csv: ${csvPath}`);
  console.log(`report: ${reportPath}`);
  console.log(`model: ${DEFAULT_MODEL}`);
  console.log(`referenceDate: ${REFERENCE_DATE}`);
  console.log(`accuracy: ${report.passed}/${report.total} (${report.accuracy.toFixed(2)}%)`);
  console.log(`generation source: ${JSON.stringify(sourceBreakdown)}`);
  console.log("by category:");
  for (const category of report.byCategory) {
    console.log(
      `  ${category.category.padEnd(12)} ${category.passed}/${category.total} (${category.accuracy.toFixed(2)}%)`,
    );
  }
  console.log("by path:");
  for (const pathEntry of report.byPath) {
    console.log(`  ${pathEntry.path.padEnd(10)} ${pathEntry.count}`);
  }
  if (report.failures.length > 0) {
    console.log("sample failures:");
    for (const failure of report.failures.slice(0, 12)) {
      console.log(`  - ${failure.text} [${failure.path}]`);
      console.log(`    expected: ${failure.expected.map((x) => `${x.start}~${x.end}`).join(", ") || "(none)"}`);
      console.log(`    actual:   ${failure.actual.map((x) => `${x.start}~${x.end}`).join(", ") || "(none)"}`);
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
