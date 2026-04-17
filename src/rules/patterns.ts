import type {
  DateExpression,
  AbsoluteExpression,
  FilterKind,
  NamedToken,
} from "../types.js";
import { KOREAN_DAY_NUMERALS, KOREAN_DAY_WORDS, ENGLISH_DAY_WORDS } from "./numerals.js";

export interface Match {
  text: string;
  start: number;
  end: number;
  expression: DateExpression;
  priority: number; // 높을수록 우선 (구체적 패턴 > 일반 패턴)
}

const FILTER_SUFFIX_MAP: Array<{ re: RegExp; filter: FilterKind }> = [
  { re: /^\s*영업일/, filter: "business_days" },
  { re: /^\s*평일/, filter: "weekdays" },
  { re: /^\s*공휴일/, filter: "holidays" },
  { re: /^\s*휴일/, filter: "holidays" },
  { re: /^\s*주말/, filter: "weekends" },
  { re: /^\s*토요일/, filter: "saturdays" },
  { re: /^\s*일요일/, filter: "sundays" },
];

function tryAttachFilter(
  text: string,
  afterIdx: number,
  baseMatch: Match,
): Match | null {
  const rest = text.slice(afterIdx);
  for (const { re, filter } of FILTER_SUFFIX_MAP) {
    const m = re.exec(rest);
    if (m) {
      const suffixLen = m[0].length;
      return {
        text: text.slice(baseMatch.start, afterIdx + suffixLen),
        start: baseMatch.start,
        end: afterIdx + suffixLen,
        expression: {
          kind: "filter",
          base: baseMatch.expression,
          filter,
        },
        priority: baseMatch.priority + 1,
      };
    }
  }
  return null;
}

/**
 * 모든 매치 후보를 반환 (span overlap 허용, 이후 resolveOverlaps가 정리).
 */
export function findMatches(text: string): Match[] {
  const out: Match[] = [];

  // 1. ISO 절대 (2025-12-25, 2025/12/25, 2025.12.25)
  {
    const re = /\b(\d{4})[-./](\d{1,2})[-./](\d{1,2})\b/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      out.push({
        text: m[0],
        start: m.index,
        end: m.index + m[0].length,
        expression: {
          kind: "absolute",
          year: Number(m[1]),
          month: Number(m[2]),
          day: Number(m[3]),
        },
        priority: 100,
      });
    }
  }

  // 2. 한국어 연월일 (2025년 3월 1일, 3월 1일)
  {
    const re = /(\d{4})\s*년\s*(\d{1,2})\s*월\s*(\d{1,2})\s*일/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      out.push({
        text: m[0],
        start: m.index,
        end: m.index + m[0].length,
        expression: {
          kind: "absolute",
          year: Number(m[1]),
          month: Number(m[2]),
          day: Number(m[3]),
        },
        priority: 95,
      });
    }
  }
  {
    const re = /(?<!\d)(\d{1,2})\s*월\s*(\d{1,2})\s*일/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      const base: Match = {
        text: m[0],
        start: m.index,
        end: m.index + m[0].length,
        expression: {
          kind: "absolute",
          month: Number(m[1]),
          day: Number(m[2]),
        },
        priority: 85,
      };
      out.push(base);
    }
  }

  // 2b. YYYY년 M월 [초/중/말]? (일이 없을 때)
  {
    const re = /(\d{4})\s*년\s*(\d{1,2})\s*월(?!\s*\d+\s*일)(\s*(초|중|말))?/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      const part = m[4];
      const monthPart =
        part === "초" ? ("early" as const)
        : part === "중" ? ("mid" as const)
        : part === "말" ? ("late" as const)
        : undefined;
      out.push({
        text: m[0],
        start: m.index,
        end: m.index + m[0].length,
        expression: {
          kind: "absolute",
          year: Number(m[1]),
          month: Number(m[2]),
          ...(monthPart ? { monthPart } : {}),
        },
        priority: 93,
      });
    }
  }

  // 2c. M월 [초/중/말/첫 주] (연도 없음, 일 없음)
  {
    const re = /(?<!\d)(\d{1,2})\s*월\s*(초|중|말|첫\s*주)(?!\s*\d+\s*일)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      const part = m[2].replace(/\s+/g, "");
      const baseExpr: AbsoluteExpression = {
        kind: "absolute",
        month: Number(m[1]),
      };
      if (part === "초") baseExpr.monthPart = "early";
      else if (part === "중") baseExpr.monthPart = "mid";
      else if (part === "말") baseExpr.monthPart = "late";
      else if (part === "첫주") baseExpr.firstWeek = true;
      out.push({
        text: m[0],
        start: m.index,
        end: m.index + m[0].length,
        expression: baseExpr,
        priority: 88,
      });
    }
  }

  // 2d. YYYY년 [초/말] (월 없음)
  {
    const re = /(\d{4})\s*년\s*(초|말)(?!\s*\d)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      const part = m[2];
      out.push({
        text: m[0],
        start: m.index,
        end: m.index + m[0].length,
        expression: {
          kind: "absolute",
          year: Number(m[1]),
          yearPart: part === "초" ? "early" : "late",
        },
        priority: 90,
      });
    }
  }

  // 3. 월 단독 (3월) — 연월일/월일 매치와 겹치면 priority 낮음
  //    뒤에 "N일"이 붙으면 월일 패턴이 이미 처리하므로 배제
  {
    const re = /(?<![\d년])(\d{1,2})\s*월(?!\s*\d+\s*일)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      const base: Match = {
        text: m[0],
        start: m.index,
        end: m.index + m[0].length,
        expression: { kind: "absolute", month: Number(m[1]) },
        priority: 70,
      };
      // 필터 결합 시도
      const withFilter = tryAttachFilter(text, base.end, base);
      out.push(withFilter ?? base);
    }
  }

  // 4. 연도 단독 (2025년)
  {
    const re = /(\d{4})\s*년(?!\s*\d)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      const base: Match = {
        text: m[0],
        start: m.index,
        end: m.index + m[0].length,
        expression: { kind: "absolute", year: Number(m[1]) },
        priority: 65,
      };
      const withFilter = tryAttachFilter(text, base.end, base);
      out.push(withFilter ?? base);
    }
  }

  // 5. 상대 연 표현
  const YEAR_RELATIVE: Array<{ word: string; offset: number }> = [
    { word: "재작년", offset: -2 },
    { word: "작년", offset: -1 },
    { word: "지난해", offset: -1 },
    { word: "전년", offset: -1 },
    { word: "올해", offset: 0 },
    { word: "금년", offset: 0 },
    { word: "내년", offset: 1 },
    { word: "명년", offset: 1 },
    { word: "후년", offset: 2 },
  ];
  for (const { word, offset } of YEAR_RELATIVE) {
    let idx = 0;
    while ((idx = text.indexOf(word, idx)) !== -1) {
      const base: Match = {
        text: word,
        start: idx,
        end: idx + word.length,
        expression: { kind: "relative", unit: "year", offset },
        priority: 75,
      };
      const withFilter = tryAttachFilter(text, base.end, base);
      out.push(withFilter ?? base);
      idx += word.length;
    }
  }

  // 6. 상대 월 표현
  const MONTH_RELATIVE: Array<{ word: string; offset: number }> = [
    { word: "지지난달", offset: -2 },
    { word: "지지난 달", offset: -2 },
    { word: "저번달", offset: -1 },
    { word: "저번 달", offset: -1 },
    { word: "지난달", offset: -1 },
    { word: "지난 달", offset: -1 },
    { word: "이번달", offset: 0 },
    { word: "이번 달", offset: 0 },
    { word: "금월", offset: 0 },
    { word: "다음달", offset: 1 },
    { word: "다음 달", offset: 1 },
    { word: "내달", offset: 1 },
  ];
  for (const { word, offset } of MONTH_RELATIVE) {
    let idx = 0;
    while ((idx = text.indexOf(word, idx)) !== -1) {
      const base: Match = {
        text: word,
        start: idx,
        end: idx + word.length,
        expression: { kind: "relative", unit: "month", offset },
        priority: 75,
      };
      const withFilter = tryAttachFilter(text, base.end, base);
      out.push(withFilter ?? base);
      idx += word.length;
    }
  }

  // 7. 상대 주 표현
  const WEEK_RELATIVE: Array<{ word: string; offset: number }> = [
    { word: "지지난주", offset: -2 },
    { word: "지지난 주", offset: -2 },
    { word: "지난주", offset: -1 },
    { word: "지난 주", offset: -1 },
    { word: "저번주", offset: -1 },
    { word: "저번 주", offset: -1 },
    { word: "이번주", offset: 0 },
    { word: "이번 주", offset: 0 },
    { word: "금주", offset: 0 },
    { word: "다음주", offset: 1 },
    { word: "다음 주", offset: 1 },
  ];
  for (const { word, offset } of WEEK_RELATIVE) {
    let idx = 0;
    while ((idx = text.indexOf(word, idx)) !== -1) {
      const base: Match = {
        text: word,
        start: idx,
        end: idx + word.length,
        expression: { kind: "relative", unit: "week", offset },
        priority: 75,
      };
      const withFilter = tryAttachFilter(text, base.end, base);
      out.push(withFilter ?? base);
      idx += word.length;
    }
  }

  // 8. 수치 상대 (7일 전, 3일 후, 2주 전, 3개월 뒤)
  {
    const re = /(\d+)\s*(일|주|개월|달|년|년도|주일)\s*(전|뒤|후)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      const n = Number(m[1]);
      const unitWord = m[2];
      const dirWord = m[3];
      let unit: "day" | "week" | "month" | "year" = "day";
      if (unitWord === "주" || unitWord === "주일") unit = "week";
      else if (unitWord === "개월" || unitWord === "달") unit = "month";
      else if (unitWord === "년" || unitWord === "년도") unit = "year";
      const sign = dirWord === "전" ? -1 : 1;
      out.push({
        text: m[0],
        start: m.index,
        end: m.index + m[0].length,
        expression: { kind: "relative", unit, offset: sign * n },
        priority: 80,
      });
    }
  }

  // 9. 한국어 수사 ("사흘 전/뒤", "보름 전")
  for (const { word, token } of KOREAN_DAY_NUMERALS) {
    const re = new RegExp(`${word}\\s*(전|뒤|후)?`, "g");
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      const dirWord = m[1];
      const direction: "past" | "future" | undefined = dirWord === "전" ? "past" : dirWord ? "future" : undefined;
      out.push({
        text: m[0],
        start: m.index,
        end: m.index + m[0].length,
        expression: {
          kind: "named",
          name: token,
          direction: direction ?? "past",
        },
        priority: 78,
      });
    }
  }

  // 10. 고정 한국어 일상어 (어제/오늘/내일/모레/글피/그저께/엊그제)
  for (const { word, token } of KOREAN_DAY_WORDS) {
    let idx = 0;
    while ((idx = text.indexOf(word, idx)) !== -1) {
      out.push({
        text: word,
        start: idx,
        end: idx + word.length,
        expression: { kind: "named", name: token },
        priority: 72,
      });
      idx += word.length;
    }
  }

  // 11. 영어 일상어
  for (const { word, token } of ENGLISH_DAY_WORDS) {
    const re = new RegExp(`\\b${word}\\b`, "gi");
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      out.push({
        text: m[0],
        start: m.index,
        end: m.index + m[0].length,
        expression: { kind: "named", name: token },
        priority: 70,
      });
    }
  }

  // 12. 영어 상대 (last month, next year, last week)
  {
    const UNITS: Record<string, "day" | "week" | "month" | "year"> = {
      day: "day",
      week: "week",
      month: "month",
      quarter: "month", // approx
      year: "year",
    };
    const re = /\b(last|next|this|previous)\s+(day|week|month|year|quarter)\b/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      const dirWord = m[1].toLowerCase();
      const unitWord = m[2].toLowerCase();
      const offset =
        dirWord === "last" || dirWord === "previous"
          ? -1
          : dirWord === "next"
            ? 1
            : 0;
      const unit = UNITS[unitWord] ?? "day";
      const base: Match = {
        text: m[0],
        start: m.index,
        end: m.index + m[0].length,
        expression: { kind: "relative", unit, offset },
        priority: 75,
      };
      out.push(base);
    }
  }

  // 13. 영어 "N days/weeks/months/years ago"
  {
    const re = /\b(\d+)\s+(day|week|month|year)s?\s+ago\b/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      const n = Number(m[1]);
      const unit = m[2].toLowerCase() as "day" | "week" | "month" | "year";
      out.push({
        text: m[0],
        start: m.index,
        end: m.index + m[0].length,
        expression: { kind: "relative", unit, offset: -n },
        priority: 80,
      });
    }
  }

  // 14. N분기 (prefix 없는 N분기 = 올해 기준)
  {
    const re = /(?<![\d가-힣])([1-4])\s*분기/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      const q = Number(m[1]) as 1 | 2 | 3 | 4;
      out.push({
        text: m[0],
        start: m.index,
        end: m.index + m[0].length,
        expression: { kind: "quarter", quarter: q, yearOffset: 0 },
        priority: 82,
      });
    }
  }

  // 14b. (올해/작년/내년/재작년/지난해/금년) N분기
  {
    const re = /(재작년|지난해|작년|올해|금년|내년|후년)\s*([1-4])\s*분기/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      const prefix = m[1];
      const yearOffset =
        prefix === "재작년" ? -2
        : prefix === "작년" || prefix === "지난해" ? -1
        : prefix === "내년" ? 1
        : prefix === "후년" ? 2
        : 0;
      const q = Number(m[2]) as 1 | 2 | 3 | 4;
      out.push({
        text: m[0],
        start: m.index,
        end: m.index + m[0].length,
        expression: { kind: "quarter", quarter: q, yearOffset },
        priority: 92,
      });
    }
  }

  // 14c. (YYYY년) N분기
  {
    const re = /(\d{4})\s*년\s*([1-4])\s*분기/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      const q = Number(m[2]) as 1 | 2 | 3 | 4;
      out.push({
        text: m[0],
        start: m.index,
        end: m.index + m[0].length,
        expression: { kind: "quarter", quarter: q, year: Number(m[1]) },
        priority: 94,
      });
    }
  }

  // 15. 이번/지난/지지난/다음/저번 분기
  {
    const re = /(지지난|저번|지난|이번|금|다음)\s*분기/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      const p = m[1];
      const offset =
        p === "지지난" ? -2
        : p === "지난" || p === "저번" ? -1
        : p === "다음" ? 1
        : 0;
      out.push({
        text: m[0],
        start: m.index,
        end: m.index + m[0].length,
        expression: { kind: "relative", unit: "quarter", offset },
        priority: 80,
      });
    }
  }

  // 16. (YYYY년|prefix) 상/하반기
  {
    const re = /(\d{4})\s*년\s*(상|하)\s*반기/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      const half = (m[2] === "상" ? 1 : 2) as 1 | 2;
      out.push({
        text: m[0],
        start: m.index,
        end: m.index + m[0].length,
        expression: { kind: "half", half, year: Number(m[1]) },
        priority: 92,
      });
    }
  }
  {
    const re = /(재작년|지난해|작년|올해|금년|내년|후년)\s*(상|하)\s*반기/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      const prefix = m[1];
      const yearOffset =
        prefix === "재작년" ? -2
        : prefix === "작년" || prefix === "지난해" ? -1
        : prefix === "내년" ? 1
        : prefix === "후년" ? 2
        : 0;
      const half = (m[2] === "상" ? 1 : 2) as 1 | 2;
      out.push({
        text: m[0],
        start: m.index,
        end: m.index + m[0].length,
        expression: { kind: "half", half, yearOffset },
        priority: 90,
      });
    }
  }

  // 16b. 지난 상/하반기 (most-recent-past)
  {
    const re = /지난\s*(상|하)\s*반기/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      const half = (m[1] === "상" ? 1 : 2) as 1 | 2;
      out.push({
        text: m[0],
        start: m.index,
        end: m.index + m[0].length,
        expression: { kind: "half", half, mostRecentPast: true },
        priority: 88,
      });
    }
  }

  // 16c. 단독 상/하반기 (올해 기준)
  {
    const re = /(?<!(?:재작년|지난해|작년|올해|금년|내년|후년|지난)\s*)(상|하)\s*반기/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      const half = (m[1] === "상" ? 1 : 2) as 1 | 2;
      out.push({
        text: m[0],
        start: m.index,
        end: m.index + m[0].length,
        expression: { kind: "half", half, yearOffset: 0 },
        priority: 78,
      });
    }
  }

  // 17. 최근/지난 N 일/주/개월/달/년 (간|동안|내) — duration
  {
    const KOREAN_NUM: Record<string, number> = {
      한: 1,
      두: 2,
      세: 3,
      네: 4,
      다섯: 5,
      여섯: 6,
      일곱: 7,
      여덟: 8,
      아홉: 9,
      열: 10,
    };
    const re =
      /(최근|지난|요)?\s*(\d+|한|두|세|네|다섯|여섯|일곱|여덟|아홉|열)\s*(일|주일|주|개월|달|년|해)\s*(간|동안|내|째)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      const numStr = m[2];
      const amount = /^\d+$/.test(numStr) ? Number(numStr) : KOREAN_NUM[numStr] ?? 1;
      const unitWord = m[3];
      let unit: "day" | "week" | "month" | "year" = "day";
      if (unitWord === "주" || unitWord === "주일") unit = "week";
      else if (unitWord === "개월" || unitWord === "달") unit = "month";
      else if (unitWord === "년" || unitWord === "해") unit = "year";
      out.push({
        text: m[0],
        start: m.index,
        end: m.index + m[0].length,
        expression: { kind: "duration", unit, amount, direction: "past" },
        priority: 83,
      });
    }
  }

  // 17b. 일주일/한 달/한 해 + 전/뒤/후 (point-in-time; 단일 날짜)
  {
    const re = /(일주일|한\s*달|한\s*해|한\s*주)\s*(전|뒤|후)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      const word = m[1].replace(/\s+/g, "");
      const sign = m[2] === "전" ? -1 : 1;
      let unit: "day" | "month" = "day";
      let offset = 0;
      if (word === "일주일" || word === "한주") {
        unit = "day";
        offset = sign * 7;
      } else if (word === "한달") {
        unit = "month";
        offset = sign * 1;
      } else {
        // 한 해
        unit = "day";
        offset = sign * 365;
      }
      out.push({
        text: m[0],
        start: m.index,
        end: m.index + m[0].length,
        expression: { kind: "relative", unit, offset },
        priority: 82,
      });
    }
  }

  // 18. YY년 (2자리 연도, 20-99 → 2020-2099)
  {
    const re = /(?<![\d가-힣])([2-9]\d)\s*년(?!도)(?!\s*(전|뒤|후))/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      const yy = Number(m[1]);
      out.push({
        text: m[0],
        start: m.index,
        end: m.index + m[0].length,
        expression: { kind: "absolute", year: 2000 + yy },
        priority: 65,
      });
    }
  }

  // 19. DD일 단독 (이번 달 D일) — 월/연 컨텍스트 없을 때
  {
    const re =
      /(?<![\d가-힣])(\d{1,2})\s*일(?!\s*(전|뒤|후|이상|이하|이내|동안|간|째|부터|까지))/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      const d = Number(m[1]);
      if (d < 1 || d > 31) continue;
      out.push({
        text: m[0],
        start: m.index,
        end: m.index + m[0].length,
        expression: { kind: "absolute", day: d } as AbsoluteExpression,
        priority: 68,
      });
    }
  }

  // 20. (prefix) M월 [초/중/말/첫주]? — 작년 12월, 올해 3월 등
  {
    const PREFIXES: Array<{ word: string; offset: number }> = [
      { word: "재작년", offset: -2 },
      { word: "지난해", offset: -1 },
      { word: "작년", offset: -1 },
      { word: "올해", offset: 0 },
      { word: "금년", offset: 0 },
      { word: "내년", offset: 1 },
      { word: "후년", offset: 2 },
    ];
    for (const { word, offset } of PREFIXES) {
      const re = new RegExp(
        `${word}\\s*(\\d{1,2})\\s*월\\s*(초|중|말|첫\\s*주)?(?!\\s*\\d+\\s*일)`,
        "g",
      );
      let m: RegExpExecArray | null;
      while ((m = re.exec(text))) {
        const part = m[2]?.replace(/\s+/g, "");
        const baseExpr: AbsoluteExpression = {
          kind: "absolute",
          yearOffset: offset,
          month: Number(m[1]),
        };
        if (part === "초") baseExpr.monthPart = "early";
        else if (part === "중") baseExpr.monthPart = "mid";
        else if (part === "말") baseExpr.monthPart = "late";
        else if (part === "첫주") baseExpr.firstWeek = true;
        out.push({
          text: m[0],
          start: m.index,
          end: m.index + m[0].length,
          expression: baseExpr,
          priority: 91,
        });
      }
    }
  }

  // 20b. (전년|작년|지난해|재작년) 대비 → 암묵적 "올해"도 함께 반환
  //      "대비" 스팬에 올해를 매칭하여 기존 작년/전년 표현과 겹치지 않게 함.
  {
    const re = /(전년|작년|지난해|재작년)\s*(대비)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      const daeBiStart = m.index + m[0].length - m[2].length;
      out.push({
        text: m[2],
        start: daeBiStart,
        end: daeBiStart + m[2].length,
        expression: { kind: "relative", unit: "year", offset: 0 },
        priority: 79,
      });
    }
  }

  // 21. X 이후 (X부터 오늘까지)
  //    매치된 날짜 표현(절대/상대) 뒤에 "이후"가 붙으면 range로 확장.
  //    간단하게 "YYYY년 M월 이후" 형태만 우선 처리.
  {
    const re =
      /(\d{4})\s*년\s*(\d{1,2})\s*월(?:\s*(\d{1,2})\s*일)?\s*이후(?!\s*에는|\s*에)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      const y = Number(m[1]);
      const mo = Number(m[2]);
      const d = m[3] ? Number(m[3]) : undefined;
      const startExpr: AbsoluteExpression = {
        kind: "absolute",
        year: y,
        month: mo,
        ...(d ? { day: d } : {}),
      };
      out.push({
        text: m[0],
        start: m.index,
        end: m.index + m[0].length,
        expression: {
          kind: "range",
          start: startExpr,
          end: { kind: "named", name: "today" },
        },
        priority: 96,
      });
    }
  }

  return out;
}

/**
 * 겹치는 매치를 priority 기준으로 해결.
 * 규칙:
 *  1. priority 높은 매치 우선
 *  2. 같은 priority면 길이가 긴 매치 우선
 *  3. 완전 포함 관계면 외부 매치 채택
 */
export function resolveOverlaps(matches: Match[]): Match[] {
  const sorted = [...matches].sort((a, b) => {
    if (b.priority !== a.priority) return b.priority - a.priority;
    return b.end - b.start - (a.end - a.start);
  });
  const taken: Match[] = [];
  for (const m of sorted) {
    const overlap = taken.some((t) => !(m.end <= t.start || m.start >= t.end));
    if (!overlap) taken.push(m);
  }
  return taken.sort((a, b) => a.start - b.start);
}

const DATE_RESIDUAL_KEYWORDS = [
  "년",
  "월",
  "일",
  "주",
  "시",
  "분",
  "반기",
  "분기",
  "전",
  "후",
  "뒤",
  "지난",
  "저번",
  "이번",
  "다음",
  "올해",
  "작년",
  "내년",
  "재작년",
  "어제",
  "오늘",
  "내일",
  "모레",
  "글피",
  "그저께",
  "엊그제",
  "그제",
  "사흘",
  "나흘",
  "닷새",
  "엿새",
  "이레",
  "여드레",
  "아흐레",
  "열흘",
  "보름",
  "영업일",
  "평일",
  "공휴일",
  "주말",
  "휴일",
  "최근",
  "상반기",
  "하반기",
  "일주일",
  "한 달",
  "한달",
  "yesterday",
  "today",
  "tomorrow",
  "last",
  "next",
  "previous",
  "ago",
  "before",
  "after",
];

/**
 * 매치된 스팬들을 제거한 잔여 텍스트에 날짜 관련 키워드가 남아있는지 확인.
 * 남아있으면 LLM 폴백 필요 (partial match).
 */
export function hasResidualDateContent(text: string, matches: Match[]): boolean {
  let residual = "";
  let cursor = 0;
  const ordered = [...matches].sort((a, b) => a.start - b.start);
  for (const m of ordered) {
    residual += text.slice(cursor, m.start);
    cursor = m.end;
  }
  residual += text.slice(cursor);

  const lower = residual.toLowerCase();
  for (const kw of DATE_RESIDUAL_KEYWORDS) {
    if (kw.length === 0) continue;
    // 한국어는 대소문자 구분 없음, 영어는 \b 경계
    if (/^[a-z]+$/i.test(kw)) {
      const re = new RegExp(`\\b${kw}\\b`, "i");
      if (re.test(lower)) return true;
    } else {
      if (residual.includes(kw)) return true;
    }
  }
  return false;
}

export type { NamedToken };
