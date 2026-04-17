import type { DateExpression, FilterKind, NamedToken } from "../types.js";
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
