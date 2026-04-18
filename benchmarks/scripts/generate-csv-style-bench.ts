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
import { datasetsDir, ensureBenchmarkDirs } from "./paths.js";

type RangeSpec = {
  text: string;
  start: string;
  end: string;
};

type Row = {
  text: string;
  final_start_date: string;
  final_end_date: string;
};

const REFERENCE_DATE = "2025-11-17";
const ref = parseISO(`${REFERENCE_DATE}T00:00:00`);

const outputPath = path.join(datasetsDir, "csv-style-mimic-1000.csv");

const products = [
  "예적금",
  "대출",
  "외화",
  "증권",
  "신탁",
  "수시입출",
  "정기예금",
  "적금",
  "보통예금",
  "달러 예수금",
];

const productGroups = [
  ["외화", "대출"],
  ["수시입출", "예적금"],
  ["증권", "신탁"],
  ["외화", "증권"],
  ["예적금", "대출"],
  ["수시입출", "외화"],
];

const companies = [
  "웹케시",
  "삼성전자",
  "빙그레",
  "원티드랩",
  "네이버",
  "카카오",
  "현대차",
  "LG전자",
  "기업은행",
  "신한은행",
];

const costLabels = [
  "임대료",
  "마케팅 비용",
  "연구비",
  "인건비",
  "운영비",
  "광고비",
  "복리후생비",
  "출장비",
  "서버비",
  "수수료",
];

const costTriples = [
  ["연구비", "인건비", "마케팅비"],
  ["임대료", "광고비", "운영비"],
  ["복리후생비", "출장비", "서버비"],
  ["인건비", "수수료", "광고비"],
];

const amounts = [
  "1,000만원",
  "4,000만원",
  "7,000만원",
  "1억원",
  "2억원",
  "6억원",
  "9억원",
  "5천만원",
];

function ymd(date: Date): string {
  return format(date, "yyyy-MM-dd");
}

function clampIfCurrent(start: Date, end: Date): { start: string; end: string } {
  if (start <= ref && end >= ref) {
    return { start: ymd(start), end: REFERENCE_DATE };
  }
  return { start: ymd(start), end: ymd(end) };
}

function daySpec(text: string, offsetDays: number): RangeSpec {
  const d = addDays(ref, offsetDays);
  const iso = ymd(d);
  return { text, start: iso, end: iso };
}

function weekOffsetSpec(text: string, offsetWeeks: number): RangeSpec {
  const d = addWeeks(ref, offsetWeeks);
  const start = startOfWeek(d, { weekStartsOn: 1 });
  const end = endOfWeek(d, { weekStartsOn: 1 });
  const r = clampIfCurrent(start, end);
  return { text, ...r };
}

function monthOffsetSpec(text: string, offsetMonths: number): RangeSpec {
  const d = addMonths(ref, offsetMonths);
  const start = startOfMonth(d);
  const end = endOfMonth(d);
  const r = clampIfCurrent(start, end);
  return { text, ...r };
}

function monthOnlyPastSpec(text: string, month: number): RangeSpec {
  let year = ref.getFullYear();
  const candidate = new Date(year, month - 1, 1);
  if (candidate > ref) year -= 1;
  const start = new Date(year, month - 1, 1);
  const end = endOfMonth(start);
  return { text, start: ymd(start), end: ymd(end) };
}

function quarterSpec(
  text: string,
  year: number,
  quarter: 1 | 2 | 3 | 4,
): RangeSpec {
  const start = new Date(year, (quarter - 1) * 3, 1);
  const end = endOfQuarter(start);
  const r = clampIfCurrent(start, end);
  return { text, ...r };
}

function quarterOffsetSpec(text: string, offsetQuarters: number): RangeSpec {
  const currentQuarterStart = startOfQuarter(ref);
  const targetStart = addMonths(currentQuarterStart, offsetQuarters * 3);
  const end = endOfQuarter(targetStart);
  const r = clampIfCurrent(targetStart, end);
  return { text, ...r };
}

function yearOffsetSpec(text: string, offsetYears: number): RangeSpec {
  const targetYear = ref.getFullYear() + offsetYears;
  const start = startOfYear(new Date(targetYear, 0, 1));
  const end = endOfYear(start);
  const r = clampIfCurrent(start, end);
  return { text, ...r };
}

function halfSpec(
  text: string,
  year: number,
  half: 1 | 2,
): RangeSpec {
  const startMonth = half === 1 ? 0 : 6;
  const start = new Date(year, startMonth, 1);
  const end = endOfMonth(new Date(year, startMonth + 5, 1));
  const r = clampIfCurrent(start, end);
  return { text, ...r };
}

function monthYearSpec(text: string, year: number, month: number): RangeSpec {
  const start = new Date(year, month - 1, 1);
  const end = endOfMonth(start);
  const r = clampIfCurrent(start, end);
  return { text, ...r };
}

function monthPartSpec(
  text: string,
  year: number,
  month: number,
  part: "early" | "end",
): RangeSpec {
  if (part === "early") {
    return {
      text,
      start: `${year}-${String(month).padStart(2, "0")}-01`,
      end: `${year}-${String(month).padStart(2, "0")}-10`,
    };
  }
  const lastDay = endOfMonth(new Date(year, month - 1, 1)).getDate();
  const iso = `${year}-${String(month).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`;
  return { text, start: iso, end: iso };
}

function yearPartSpec(
  text: string,
  year: number,
  part: "early" | "late",
): RangeSpec {
  if (part === "early") {
    return {
      text,
      start: `${year}-01-01`,
      end: `${year}-03-31`,
    };
  }
  return {
    text,
    start: `${year}-10-01`,
    end: `${year}-12-31`,
  };
}

function firstWeekSpec(text: string, year: number, month: number): RangeSpec {
  return {
    text,
    start: `${year}-${String(month).padStart(2, "0")}-01`,
    end: `${year}-${String(month).padStart(2, "0")}-07`,
  };
}

function durationMonthsSpec(text: string, months: number): RangeSpec {
  return {
    text,
    start: ymd(addMonths(ref, -months)),
    end: REFERENCE_DATE,
  };
}

function durationYearsSpec(text: string, years: number): RangeSpec {
  return {
    text,
    start: ymd(addYears(ref, -years)),
    end: REFERENCE_DATE,
  };
}

function absoluteDaySpec(text: string, year: number, month: number, day: number): RangeSpec {
  const iso = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  return { text, start: iso, end: iso };
}

function csvEscape(value: string): string {
  if (/[",\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

const genericDateSpecs: RangeSpec[] = [
  daySpec("오늘", 0),
  daySpec("어제", -1),
  daySpec("그제", -2),
  daySpec("그저께", -2),
  daySpec("엊그제", -2),
  daySpec("사흘전", -3),
  daySpec("나흘전", -4),
  daySpec("보름전", -15),
  daySpec("일주일 전", -7),
  weekOffsetSpec("지난주", -1),
  weekOffsetSpec("이번 주", 0),
  monthOffsetSpec("지난달", -1),
  monthOffsetSpec("저번달", -1),
  monthOffsetSpec("이번달", 0),
  monthOnlyPastSpec("3월", 3),
  monthOnlyPastSpec("8월", 8),
  yearOffsetSpec("올해", 0),
  yearOffsetSpec("작년", -1),
  yearOffsetSpec("재작년", -2),
  quarterSpec("1분기", 2025, 1),
  quarterSpec("2분기", 2025, 2),
  quarterSpec("4분기", 2025, 4),
  quarterOffsetSpec("이번분기", 0),
  quarterOffsetSpec("지난분기", -1),
  halfSpec("하반기", 2025, 2),
  halfSpec("지난 상반기", 2025, 1),
  yearOffsetSpec("2023년", -2),
  monthYearSpec("2024년 2월", 2024, 2),
  durationMonthsSpec("최근 6개월간", 6),
  durationYearsSpec("지난 1년간", 1),
];

const lifecycleDateSpecs: RangeSpec[] = [
  yearPartSpec("2032년 초", 2032, "early"),
  yearPartSpec("2029년 말", 2029, "late"),
  monthPartSpec("2024년 7월 말", 2024, 7, "end"),
  monthPartSpec("2023년 1월 초", 2023, 1, "early"),
  monthYearSpec("2020년 2월", 2020, 2),
  monthPartSpec("2014년 7월 말", 2014, 7, "end"),
  monthYearSpec("2026년 3월", 2026, 3),
  firstWeekSpec("2027년 2월 첫 주", 2027, 2),
  monthYearSpec("2024년 5월", 2024, 5),
  monthYearSpec("2023년 12월", 2023, 12),
  halfSpec("2028년 상반기", 2028, 1),
  halfSpec("2028년 하반기", 2028, 2),
  quarterSpec("내년 1분기", 2026, 1),
  quarterSpec("내년 2분기", 2026, 2),
  quarterSpec("2026년 1분기", 2026, 1),
  quarterSpec("2027년 4분기", 2027, 4),
  absoluteDaySpec("2025년 3월 1일", 2025, 3, 1),
  absoluteDaySpec("2024년 10월 9일", 2024, 10, 9),
  monthYearSpec("2026년 8월", 2026, 8),
  monthPartSpec("2027년 1월 말", 2027, 1, "end"),
];

const pairSpecs: Array<[RangeSpec, RangeSpec]> = [
  [monthOffsetSpec("지난달", -1), monthOffsetSpec("이번달", 0)],
  [yearOffsetSpec("작년", -1), yearOffsetSpec("올해", 0)],
  [quarterOffsetSpec("지난분기", -1), quarterOffsetSpec("이번분기", 0)],
  [quarterSpec("1분기", 2025, 1), quarterSpec("2분기", 2025, 2)],
  [monthOnlyPastSpec("3월", 3), monthOnlyPastSpec("4월", 4)],
  [yearOffsetSpec("재작년", -2), yearOffsetSpec("작년", -1)],
  [weekOffsetSpec("지난주", -1), weekOffsetSpec("이번 주", 0)],
  [yearOffsetSpec("2024년", -1), yearOffsetSpec("2025년", 0)],
  [monthYearSpec("2024년 2월", 2024, 2), monthYearSpec("2024년 3월", 2024, 3)],
  [halfSpec("상반기", 2025, 1), halfSpec("하반기", 2025, 2)],
];

const genericTemplates = [
  (date: RangeSpec, i: number) => `${date.text} ${products[i % products.length]} 거래내역`,
  (date: RangeSpec, i: number) => `${date.text} ${products[i % products.length]} 잔액`,
  (date: RangeSpec, i: number) => `${date.text} ${products[i % products.length]} 남은 돈`,
  (date: RangeSpec, i: number) => `${date.text} ${products[i % products.length]} 입출금 내역`,
  (date: RangeSpec, i: number) => `${date.text} ${products[i % products.length]} 계좌 잔액`,
  (date: RangeSpec, i: number) => `${date.text} ${products[i % products.length]} 계좌의 자세한 거래 내역은?`,
  (date: RangeSpec, i: number) => `${date.text} ${products[i % products.length]} 거래내역 보여줘`,
  (date: RangeSpec, i: number) => `${date.text} ${products[i % products.length]} 출금 내역 보여 줘`,
  (date: RangeSpec, i: number) => `${date.text} ${costLabels[i % costLabels.length]} 비용 비중은?`,
  (date: RangeSpec) => `${date.text} 자금 증감 현황`,
  (date: RangeSpec, i: number) => `${date.text} 월별 ${products[i % products.length]} 거래내역`,
  (date: RangeSpec, i: number) => `${date.text} ${companies[i % companies.length]}와의 거래 비중이 어떻게 돼?`,
  (date: RangeSpec, i: number) => `${date.text} ${products[i % products.length]} 계좌 잔액 오름차순으로 조회`,
  (date: RangeSpec, i: number) => `${date.text} ${products[i % products.length]} 계좌 잔액 내림차순으로 조회`,
  (date: RangeSpec, i: number) => `${date.text} ${amounts[i % amounts.length]} 이상 ${products[i % products.length]} 거래내역`,
  (date: RangeSpec, i: number) => `${date.text} ${amounts[i % amounts.length]} 이하 ${products[i % products.length]} 계좌 잔액`,
  (date: RangeSpec, i: number) => `${date.text} ${products[i % products.length]} 계좌에서 ${amounts[i % amounts.length]} 가량의 금액이 거래된 내역을 확인하고 싶어.`,
  (date: RangeSpec, i: number) => {
    const pair = productGroups[i % productGroups.length];
    return `${date.text} ${pair[0]}, ${pair[1]} 잔액 보여줘`;
  },
  (date: RangeSpec, i: number) => {
    const pair = productGroups[i % productGroups.length];
    return `${date.text} ${pair[0]}과 ${pair[1]}의 거래 내역을 모두 알려주세요.`;
  },
  (date: RangeSpec, i: number) => {
    const triple = costTriples[i % costTriples.length];
    return `${date.text} ${triple[0]}, ${triple[1]}, ${triple[2]} 비중을 한번에 비교해줘`;
  },
] as const;

const lifecycleTemplates = [
  (date: RangeSpec, i: number) => `${date.text}에 만기되는 ${products[i % products.length]} 계좌를 조회해줘.`,
  (date: RangeSpec, i: number) => `${date.text}에 개설된 ${products[i % products.length]} 계좌를 조회해줘.`,
  (date: RangeSpec, i: number) => `${date.text}에 만기된 ${products[i % products.length]} 계좌를 조회해줘.`,
  (date: RangeSpec, i: number) => `${date.text}에 개설한 ${products[i % products.length]} 계좌 목록은?`,
  (date: RangeSpec, i: number) => `${date.text}에 개설된 ${products[i % products.length]} 계좌 잔액`,
  (date: RangeSpec, i: number) => `${date.text}에 만기 도래하는 ${products[i % products.length]} 계좌가 있는가?`,
  (date: RangeSpec, i: number) => `${date.text}에 신규 개설된 ${products[i % products.length]} 계좌의 거래내역`,
  (date: RangeSpec, i: number) => `${date.text}에 종료된 ${products[i % products.length]} 계좌를 보여줘`,
  (date: RangeSpec, i: number) => `${date.text}에 가입한 ${products[i % products.length]} 계좌 알려줘`,
  (date: RangeSpec, i: number) => `${date.text}에 만기된 ${products[i % products.length]} 계좌의 남은 돈`,
] as const;

const comparisonTemplates = [
  (a: RangeSpec, b: RangeSpec) => `${a.text} 대비 ${b.text} 지출 증가율`,
  (a: RangeSpec, b: RangeSpec, i: number) => `${a.text}과 ${b.text} 각각 ${products[i % products.length]} 거래내역`,
  (a: RangeSpec, b: RangeSpec, i: number) => `${a.text} ${products[i % products.length]} 잔액과 ${b.text} ${products[i % products.length]} 잔액 비교`,
  (a: RangeSpec, b: RangeSpec, i: number) => `${a.text} ${companies[i % companies.length]} 거래 비중과 ${b.text} ${companies[i % companies.length]} 거래 비중 비교`,
  (a: RangeSpec, b: RangeSpec, i: number) => `${a.text} ${costLabels[i % costLabels.length]} 비용을 ${b.text}하고 비교해줘`,
  (a: RangeSpec, b: RangeSpec, i: number) => `${a.text} ${products[i % products.length]} 입출금 내역과 ${b.text} ${products[i % products.length]} 입출금 내역`,
  (a: RangeSpec, b: RangeSpec) => `${a.text} 자금 현황과 ${b.text} 자금 현황 비교`,
  (a: RangeSpec, b: RangeSpec, i: number) => `${a.text} ${products[i % products.length]} 남은 돈하고 ${b.text} ${products[i % products.length]} 남은 돈 비교`,
  (a: RangeSpec, b: RangeSpec) => `${a.text} 출금 내역과 ${b.text} 출금 내역을 함께 보여줘`,
  (a: RangeSpec, b: RangeSpec) => `${a.text} 거래내역과 ${b.text} 거래내역 중 뭐가 더 많아?`,
] as const;

function uniquePush(rows: Row[], seen: Set<string>, row: Row) {
  const key = `${row.text}__${row.final_start_date}__${row.final_end_date}`;
  if (seen.has(key)) return;
  seen.add(key);
  rows.push(row);
}

function buildRows(): Row[] {
  const rows: Row[] = [];
  const seen = new Set<string>();

  for (let templateIndex = 0; templateIndex < genericTemplates.length; templateIndex++) {
    const template = genericTemplates[templateIndex];
    for (let dateIndex = 0; dateIndex < genericDateSpecs.length; dateIndex++) {
      const date = genericDateSpecs[dateIndex];
      uniquePush(rows, seen, {
        text: template(date, templateIndex + dateIndex),
        final_start_date: date.start,
        final_end_date: date.end,
      });
    }
  }

  for (let templateIndex = 0; templateIndex < lifecycleTemplates.length; templateIndex++) {
    const template = lifecycleTemplates[templateIndex];
    for (let dateIndex = 0; dateIndex < lifecycleDateSpecs.length; dateIndex++) {
      const date = lifecycleDateSpecs[dateIndex];
      uniquePush(rows, seen, {
        text: template(date, templateIndex + dateIndex),
        final_start_date: date.start,
        final_end_date: date.end,
      });
    }
  }

  for (let templateIndex = 0; templateIndex < comparisonTemplates.length; templateIndex++) {
    const template = comparisonTemplates[templateIndex];
    for (let pairIndex = 0; pairIndex < pairSpecs.length; pairIndex++) {
      const [a, b] = pairSpecs[pairIndex];
      const text = template(a, b, templateIndex + pairIndex);
      uniquePush(rows, seen, {
        text,
        final_start_date: a.start,
        final_end_date: a.end,
      });
      uniquePush(rows, seen, {
        text,
        final_start_date: b.start,
        final_end_date: b.end,
      });
    }
  }

  return rows;
}

function writeCsv(rows: Row[]) {
  ensureBenchmarkDirs();
  const header = "text,final_start_date,final_end_date";
  const body = rows
    .map((row) =>
      [
        csvEscape(row.text),
        csvEscape(row.final_start_date),
        csvEscape(row.final_end_date),
      ].join(","),
    )
    .join("\n");
  fs.writeFileSync(outputPath, `${header}\n${body}\n`, "utf8");
}

function main() {
  const rows = buildRows();
  if (rows.length !== 1000) {
    throw new Error(`Expected 1000 rows, got ${rows.length}`);
  }
  writeCsv(rows);
  const uniqueTexts = new Set(rows.map((row) => row.text)).size;
  console.log(`written: ${outputPath}`);
  console.log(`rows: ${rows.length}`);
  console.log(`unique texts: ${uniqueTexts}`);
  console.log(`referenceDate: ${REFERENCE_DATE}`);
}

main();
