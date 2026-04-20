import type {
  DateExpression,
  AbsoluteExpression,
  FilterKind,
  NamedToken,
  TimeOfDay,
  TimePeriod,
} from "../types.js";
import { KOREAN_DAY_NUMERALS, KOREAN_DAY_WORDS } from "./numerals.js";
import {
  KOREAN_PERIOD_KEYWORDS,
  inferMeridiemFromPeriod,
} from "./time-patterns.js";

export interface Match {
  text: string;
  start: number;
  end: number;
  expression: DateExpression;
  priority: number; // 높을수록 우선 (구체적 패턴 > 일반 패턴)
}

export type FilterSuffixMap = Array<{ re: RegExp; filter: FilterKind }>;

export const KOREAN_FILTER_SUFFIX_MAP: FilterSuffixMap = [
  { re: /^\s*영업일/, filter: "business_days" },
  { re: /^\s*평일/, filter: "weekdays" },
  { re: /^\s*주중/, filter: "weekdays" },
  { re: /^\s*공휴일/, filter: "holidays" },
  { re: /^\s*휴일/, filter: "holidays" },
  { re: /^\s*주말/, filter: "weekends" },
  { re: /^\s*토요일/, filter: "saturdays" },
  { re: /^\s*일요일/, filter: "sundays" },
];

export function tryAttachFilter(
  text: string,
  afterIdx: number,
  baseMatch: Match,
  suffixMap: FilterSuffixMap = KOREAN_FILTER_SUFFIX_MAP,
): Match | null {
  const rest = text.slice(afterIdx);
  for (const { re, filter } of suffixMap) {
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

export interface TimeMatch {
  text: string;
  start: number;
  end: number;
  time: TimeOfDay;
  priority: number;
}

/**
 * 한국어 시간 표현 매치 (standalone).
 * attach는 findMatchesKo 말미에서 기존 date 매치와 결합한다.
 */
export function findTimeMatchesKo(text: string): TimeMatch[] {
  const out: TimeMatch[] = [];

  // 1. HH:MM 24시간 표기 (15:30, 09:00)
  {
    const re = /\b(\d{1,2}):(\d{2})\b/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      const hour = Number(m[1]);
      const minute = Number(m[2]);
      if (hour > 23 || minute > 59) continue;
      out.push({
        text: m[0],
        start: m.index,
        end: m.index + m[0].length,
        time: { type: "point", hour, minute },
        priority: 82,
      });
    }
  }

  // 2. "오전/오후 N시부터 M시까지" 범위 (range; check before the single-hour pattern)
  {
    const re =
      /(오전|오후)\s*(\d{1,2})\s*시(?:\s*(\d{1,2})\s*분)?\s*(?:부터|~|-|에서)\s*(\d{1,2})\s*시(?:\s*(\d{1,2})\s*분)?(?:\s*까지)?/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      const meridiem = m[1] === "오전" ? "am" : "pm";
      out.push({
        text: m[0],
        start: m.index,
        end: m.index + m[0].length,
        time: {
          type: "range",
          start: {
            hour: Number(m[2]),
            minute: m[3] ? Number(m[3]) : undefined,
            meridiem,
          },
          end: {
            hour: Number(m[4]),
            minute: m[5] ? Number(m[5]) : undefined,
            meridiem,
          },
        },
        priority: 84,
      });
    }
  }

  // 3. meridiem 없는 범위 "N시~M시", "N시부터 M시까지"
  {
    const re =
      /\b(\d{1,2})\s*시(?:\s*(\d{1,2})\s*분)?\s*(?:부터|~|-|에서)\s*(\d{1,2})\s*시(?:\s*(\d{1,2})\s*분)?(?:\s*까지)?/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      out.push({
        text: m[0],
        start: m.index,
        end: m.index + m[0].length,
        time: {
          type: "range",
          start: {
            hour: Number(m[1]),
            minute: m[2] ? Number(m[2]) : undefined,
          },
          end: {
            hour: Number(m[3]),
            minute: m[4] ? Number(m[4]) : undefined,
          },
        },
        priority: 82,
      });
    }
  }

  // 4. "오전/오후 N시 (M분)" 또는 "오전/오후 N시 반"
  {
    const re =
      /(오전|오후)\s*(\d{1,2})\s*시(?:\s*(\d{1,2})\s*분|\s*반)?/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      const meridiem = m[1] === "오전" ? "am" : "pm";
      const hour = Number(m[2]);
      let minute: number | undefined;
      if (m[3]) minute = Number(m[3]);
      else if (/반$/.test(m[0])) minute = 30;
      out.push({
        text: m[0],
        start: m.index,
        end: m.index + m[0].length,
        time: { type: "point", hour, minute, meridiem },
        priority: 82,
      });
    }
  }

  // 5. "새벽/저녁/...(period) N시 (M분)" — period가 meridiem을 결정
  {
    const periodAlternation = KOREAN_PERIOD_KEYWORDS.map((p) => p.re.source).join(
      "|",
    );
    const re = new RegExp(
      `(${periodAlternation})\\s*(\\d{1,2})\\s*시(?:\\s*(\\d{1,2})\\s*분|\\s*반)?`,
      "g",
    );
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      const matchedWord = m[1];
      const entry = KOREAN_PERIOD_KEYWORDS.find((p) => p.re.test(matchedWord));
      if (!entry) continue;
      const meridiem = inferMeridiemFromPeriod(entry.period);
      const hour = Number(m[2]);
      let minute: number | undefined;
      if (m[3]) minute = Number(m[3]);
      else if (/반$/.test(m[0])) minute = 30;
      out.push({
        text: m[0],
        start: m.index,
        end: m.index + m[0].length,
        time: { type: "point", hour, minute, meridiem },
        priority: 83,
      });
    }
  }

  // 6. bare "N시 (M분)" 혹은 "N시 반" — meridiem은 없음 (resolver가 defaultMeridiem 적용)
  {
    const re = /\b(\d{1,2})\s*시(?:\s*(\d{1,2})\s*분|\s*반)?/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      const hour = Number(m[1]);
      if (hour > 23) continue;
      let minute: number | undefined;
      if (m[2]) minute = Number(m[2]);
      else if (/반$/.test(m[0])) minute = 30;
      out.push({
        text: m[0],
        start: m.index,
        end: m.index + m[0].length,
        time: { type: "point", hour, minute },
        priority: 76,
      });
    }
  }

  // 7. 퍼지 period만 (새벽/아침/점심/저녁/밤/자정/정오)
  for (const entry of KOREAN_PERIOD_KEYWORDS) {
    const re = new RegExp(entry.re.source, "g");
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      out.push({
        text: m[0],
        start: m.index,
        end: m.index + m[0].length,
        time: { type: "period", period: entry.period },
        priority: 55,
      });
    }
  }

  return out;
}

/**
 * 기존 date 매치 뒤에 시간이 이어지면 datetime으로 래핑한 새 매치를 반환.
 * 예: 내일(Match) + "오후 3시"(TimeMatch) → datetime(base=tomorrow, time=...).
 */
export function tryAttachTime(
  text: string,
  baseMatch: Match,
  timeMatches: TimeMatch[],
): Match | null {
  const GAP_RE = /^\s*(에|에서)?\s*/;
  for (const tm of timeMatches) {
    if (tm.start < baseMatch.end) continue;
    const gap = text.slice(baseMatch.end, tm.start);
    if (!GAP_RE.test(gap)) continue;
    // 갭은 최대 4자(공백+조사)로 제한 — 너무 멀면 결합하지 않음
    if (gap.length > 4) continue;
    return {
      text: text.slice(baseMatch.start, tm.end),
      start: baseMatch.start,
      end: tm.end,
      expression: {
        kind: "datetime",
        base: baseMatch.expression,
        time: tm.time,
      },
      priority: Math.max(baseMatch.priority, tm.priority) + 3,
    };
  }
  return null;
}

// M월 뒤에 붙는 "N주차/N째 주/N번째 주/첫 주" 표기들.
// 숫자 cardinals와 순서 한글(첫/둘째/세/네/다섯) 및 "첫/두/세/네/다섯 번째"를 모두 커버.
const WEEK_OF_MONTH_RE_SRC =
  "(?:(?:첫째?|둘째|셋째|넷째|다섯째)\\s*주|[1-5]\\s*주\\s*차|(?:[1-5]|첫|두|세|네|다섯)\\s*번\\s*째\\s*주)";

// 한국어 요일 alternation (full + 욜 축약). parseKoWeekday로 JS getDay 값 매핑.
const KO_WEEKDAY_ALT =
  "일요일|월요일|화요일|수요일|목요일|금요일|토요일|일욜|월욜|화욜|수욜|목욜|금욜|토욜";

function parseKoWeekday(raw: string): number | undefined {
  const s = raw.replace(/\s+/g, "");
  if (s === "일요일" || s === "일욜") return 0;
  if (s === "월요일" || s === "월욜") return 1;
  if (s === "화요일" || s === "화욜") return 2;
  if (s === "수요일" || s === "수욜") return 3;
  if (s === "목요일" || s === "목욜") return 4;
  if (s === "금요일" || s === "금욜") return 5;
  if (s === "토요일" || s === "토욜") return 6;
  return undefined;
}

function parseWeekOfMonth(raw: string): 1 | 2 | 3 | 4 | 5 | undefined {
  const s = raw.replace(/\s+/g, "");
  if (s === "첫주" || s === "첫째주" || s === "1주차" || s === "첫번째주" || s === "1번째주") return 1;
  if (s === "둘째주" || s === "2주차" || s === "두번째주" || s === "2번째주") return 2;
  if (s === "셋째주" || s === "3주차" || s === "세번째주" || s === "3번째주") return 3;
  if (s === "넷째주" || s === "4주차" || s === "네번째주" || s === "4번째주") return 4;
  if (s === "다섯째주" || s === "5주차" || s === "다섯번째주" || s === "5번째주") return 5;
  return undefined;
}

/**
 * 한국어 매치 후보를 반환 (span overlap 허용, 이후 resolveOverlaps가 정리).
 */
export function findMatchesKo(text: string): Match[] {
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

  // 1a. 2자리 연도 구분자 날짜 (99-05-12, 98/08/18, 99.05.12)
  //     00~49 → 2000~2049, 50~99 → 1950~1999
  {
    const re = /(?<!\d)(\d{2})[-./](\d{1,2})[-./](\d{1,2})(?!\d)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      const yy = Number(m[1]);
      const mo = Number(m[2]);
      const dd = Number(m[3]);
      if (mo < 1 || mo > 12 || dd < 1 || dd > 31) continue;
      const year = yy >= 50 ? 1900 + yy : 2000 + yy;
      out.push({
        text: m[0], start: m.index, end: m.index + m[0].length,
        expression: { kind: "absolute", year, month: mo, day: dd },
        priority: 95,
      });
    }
  }

  // 1b. 구분자 없는 YYYYMMDD (20250412). month/day 범위 엄격 검증으로 오탐 억제.
  {
    const re = /(?<!\d)(\d{4})(\d{2})(\d{2})(?!\d)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      const mo = Number(m[2]);
      const d = Number(m[3]);
      if (mo < 1 || mo > 12 || d < 1 || d > 31) continue;
      out.push({
        text: m[0],
        start: m.index,
        end: m.index + m[0].length,
        expression: {
          kind: "absolute",
          year: Number(m[1]),
          month: mo,
          day: d,
        },
        priority: 97,
      });
    }
  }

  // 1b-2. 구분자 없는 YYMMDD (990512). month/day 범위 검증.
  //       00~49 → 2000~2049, 50~99 → 1950~1999
  {
    const re = /(?<!\d)(\d{2})(\d{2})(\d{2})(?!\d)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      const yy = Number(m[1]);
      const mo = Number(m[2]);
      const dd = Number(m[3]);
      if (mo < 1 || mo > 12 || dd < 1 || dd > 31) continue;
      const year = yy >= 50 ? 1900 + yy : 2000 + yy;
      out.push({
        text: m[0], start: m.index, end: m.index + m[0].length,
        expression: { kind: "absolute", year, month: mo, day: dd },
        priority: 90,
      });
    }
  }

  // 1c. 구분자 없는 MMDD (0412 → 4월 12일). 연도는 ambiguityStrategy로 해석.
  {
    const re = /(?<!\d)(\d{2})(\d{2})(?!\d)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      const mo = Number(m[1]);
      const d = Number(m[2]);
      if (mo < 1 || mo > 12 || d < 1 || d > 31) continue;
      out.push({
        text: m[0],
        start: m.index,
        end: m.index + m[0].length,
        expression: {
          kind: "absolute",
          month: mo,
          day: d,
        },
        priority: 83,
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
  // 2a. 2자리 연도 한국어 연월일 (99년05월12일, 98년 8월 18일)
  //     00~49 → 2000~2049, 50~99 → 1950~1999
  {
    const re = /(?<!\d)(\d{2})\s*년\s*(\d{1,2})\s*월\s*(\d{1,2})\s*일/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      const yy = Number(m[1]);
      const mo = Number(m[2]);
      const dd = Number(m[3]);
      if (mo < 1 || mo > 12 || dd < 1 || dd > 31) continue;
      const year = yy >= 50 ? 1900 + yy : 2000 + yy;
      out.push({
        text: m[0], start: m.index, end: m.index + m[0].length,
        expression: { kind: "absolute", year, month: mo, day: dd },
        priority: 98,
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

  // 2b. YYYY년 M월 [초/중/말 | N주차]? (일이 없을 때)
  {
    const re = new RegExp(
      `(\\d{4})\\s*년\\s*(\\d{1,2})\\s*월(?!\\s*\\d+\\s*일)(?:\\s*(초|중|말)|\\s*(${WEEK_OF_MONTH_RE_SRC}))?`,
      "g",
    );
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      const mp = m[3];
      const wk = m[4];
      const monthPart =
        mp === "초" ? ("early" as const)
        : mp === "중" ? ("mid" as const)
        : mp === "말" ? ("late" as const)
        : undefined;
      const weekOfMonth = wk ? parseWeekOfMonth(wk) : undefined;
      const baseExpr: AbsoluteExpression = {
        kind: "absolute",
        year: Number(m[1]),
        month: Number(m[2]),
      };
      if (monthPart) baseExpr.monthPart = monthPart;
      if (weekOfMonth) baseExpr.weekOfMonth = weekOfMonth;
      const base: Match = {
        text: m[0],
        start: m.index,
        end: m.index + m[0].length,
        expression: baseExpr,
        priority: 93,
      };
      const withFilter = tryAttachFilter(text, base.end, base);
      out.push(withFilter ?? base);
    }
  }

  // 2b-day. YYYY년 M월 N주차 + 요일 → 단일 날짜 (priority 96 > 2b의 93)
  {
    const re = new RegExp(
      `(\\d{4})\\s*년\\s*(\\d{1,2})\\s*월\\s*(${WEEK_OF_MONTH_RE_SRC})\\s*(${KO_WEEKDAY_ALT})`,
      "g",
    );
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      const wk = parseWeekOfMonth(m[3]);
      const wd = parseKoWeekday(m[4]);
      if (!wk || wd === undefined) continue;
      const base: Match = {
        text: m[0],
        start: m.index,
        end: m.index + m[0].length,
        expression: {
          kind: "absolute",
          year: Number(m[1]),
          month: Number(m[2]),
          weekOfMonth: wk,
          weekday: wd,
        },
        priority: 96,
      };
      const withFilter = tryAttachFilter(text, base.end, base);
      out.push(withFilter ?? base);
    }
  }

  // 2c. M월 [초/중/말 | N주차] (연도 없음, 일 없음)
  {
    const re = new RegExp(
      `(?<!\\d)(\\d{1,2})\\s*월\\s*(?:(초|중|말)|(${WEEK_OF_MONTH_RE_SRC}))(?!\\s*\\d+\\s*일)`,
      "g",
    );
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      const baseExpr: AbsoluteExpression = {
        kind: "absolute",
        month: Number(m[1]),
      };
      if (m[2] === "초") baseExpr.monthPart = "early";
      else if (m[2] === "중") baseExpr.monthPart = "mid";
      else if (m[2] === "말") baseExpr.monthPart = "late";
      else if (m[3]) {
        const wk = parseWeekOfMonth(m[3]);
        if (wk) baseExpr.weekOfMonth = wk;
      }
      const base: Match = {
        text: m[0],
        start: m.index,
        end: m.index + m[0].length,
        expression: baseExpr,
        priority: 88,
      };
      const withFilter = tryAttachFilter(text, base.end, base);
      out.push(withFilter ?? base);
    }
  }

  // 2c-day. M월 N주차 + 요일 → 단일 날짜 (priority 91 > 2c의 88). 연도 없음 → 2c와 동일하게 baseYear.
  {
    const re = new RegExp(
      `(?<!\\d)(\\d{1,2})\\s*월\\s*(${WEEK_OF_MONTH_RE_SRC})\\s*(${KO_WEEKDAY_ALT})`,
      "g",
    );
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      const wk = parseWeekOfMonth(m[2]);
      const wd = parseKoWeekday(m[3]);
      if (!wk || wd === undefined) continue;
      const base: Match = {
        text: m[0],
        start: m.index,
        end: m.index + m[0].length,
        expression: {
          kind: "absolute",
          month: Number(m[1]),
          weekOfMonth: wk,
          weekday: wd,
        },
        priority: 91,
      };
      const withFilter = tryAttachFilter(text, base.end, base);
      out.push(withFilter ?? base);
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

  // 3-list. 콤마 구분 월 목록 (2,3,4월) — 각 숫자를 별도 Match로 분리
  {
    const re = /(?<![\d년])(\d{1,2}(?:\s*,\s*\d{1,2})+)\s*월(?!\s*\d+\s*일)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      const fullMatch = m[0];
      const parts = m[1].split(/\s*,\s*/);
      let cursor = 0;
      for (let i = 0; i < parts.length; i++) {
        const num = parts[i];
        const posInMatch = fullMatch.indexOf(num, cursor);
        const absStart = m.index + posInMatch;
        const isLast = i === parts.length - 1;
        const absEnd = isLast ? m.index + fullMatch.length : absStart + num.length;
        out.push({
          text: num + "월",
          start: absStart,
          end: absEnd,
          expression: { kind: "absolute", month: Number(num) },
          priority: 71,
        });
        cursor = posInMatch + num.length;
      }
    }
  }

  // 3-list-year. YYYY년 콤마 구분 월 목록 (2025년 2,3,4월)
  {
    const re = /(\d{4})\s*년\s*(\d{1,2}(?:\s*,\s*\d{1,2})+)\s*월(?!\s*\d+\s*일)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      const year = Number(m[1]);
      const fullMatch = m[0];
      const parts = m[2].split(/\s*,\s*/);
      // 연도 부분(YYYY년)과 숫자가 겹치지 않도록 숫자 목록 시작 위치부터 탐색
      let cursor = fullMatch.indexOf(m[2]);
      for (let i = 0; i < parts.length; i++) {
        const num = parts[i];
        const posInMatch = fullMatch.indexOf(num, cursor);
        const absStart = i === 0 ? m.index : m.index + posInMatch;
        const isLast = i === parts.length - 1;
        const absEnd = isLast ? m.index + fullMatch.length : m.index + posInMatch + num.length;
        out.push({
          text: i === 0 ? fullMatch.slice(0, posInMatch + num.length) + "월" : num + "월",
          start: absStart,
          end: absEnd,
          expression: { kind: "absolute", year, month: Number(num) },
          priority: 94,
        });
        cursor = posInMatch + num.length;
      }
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
    { word: "제작년", offset: -2 },
    { word: "작년", offset: -1 },
    { word: "지난해", offset: -1 },
    { word: "지난 해", offset: -1 },
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
    { word: "저저번달", offset: -2 },
    { word: "저저번 달", offset: -2 },
    { word: "전전월", offset: -2 },
    { word: "저번달", offset: -1 },
    { word: "저번 달", offset: -1 },
    { word: "지난달", offset: -1 },
    { word: "지난 달", offset: -1 },
    { word: "전월", offset: -1 },
    { word: "이번달", offset: 0 },
    { word: "이번 달", offset: 0 },
    { word: "이달", offset: 0 },
    { word: "당월", offset: 0 },
    { word: "금월", offset: 0 },
    { word: "다다음달", offset: 2 },
    { word: "다다음 달", offset: 2 },
    { word: "다음달", offset: 1 },
    { word: "다음 달", offset: 1 },
    { word: "내달", offset: 1 },
    { word: "익월", offset: 1 },
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
    { word: "저저번주", offset: -2 },
    { word: "저저번 주", offset: -2 },
    { word: "전전주", offset: -2 },
    { word: "전전 주", offset: -2 },
    { word: "지난주", offset: -1 },
    { word: "지난 주", offset: -1 },
    { word: "저번주", offset: -1 },
    { word: "저번 주", offset: -1 },
    { word: "전주", offset: -1 },
    { word: "이번주", offset: 0 },
    { word: "이번 주", offset: 0 },
    { word: "금주", offset: 0 },
    { word: "다다음주", offset: 2 },
    { word: "다다음 주", offset: 2 },
    { word: "다음주", offset: 1 },
    { word: "다음 주", offset: 1 },
    { word: "담주", offset: 1 },
    { word: "차주", offset: 1 },
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

  // 7b. 주 + 주말 교집합 (이번주말, 다음주말, 이번 주말, 담주말 등)
  //     기본 WEEK_RELATIVE + tryAttachFilter는 "이번주 주말" (공백 포함) 만 커버하고,
  //     "이번주말" / "이번 주말" 은 잡지 못하므로 전용 룰을 둔다.
  {
    const re =
      /(지지난|저저번|전전|저번|지난|전|이번|금|다다음|다음|담|차)\s*주말/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      const p = m[1];
      const offset =
        p === "지지난" || p === "저저번" || p === "전전" ? -2
        : p === "저번" || p === "지난" || p === "전" ? -1
        : p === "다다음" ? 2
        : p === "다음" || p === "담" || p === "차" ? 1
        : 0;
      out.push({
        text: m[0],
        start: m.index,
        end: m.index + m[0].length,
        expression: {
          kind: "filter",
          base: { kind: "relative", unit: "week", offset },
          filter: "weekends",
        },
        priority: 92,
      });
    }
  }

  // 7c. 주중 단독 → 이번 주 평일(월~금) 범위
  {
    const re = /(?<![가-힣])주중(?![가-힣])/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      out.push({
        text: m[0], start: m.index, end: m.index + m[0].length,
        expression: { kind: "filter", base: { kind: "relative", unit: "week", offset: 0 }, filter: "weekdays" },
        priority: 74,
      });
    }
  }

  // 8. 수치 상대 (7일 전, 3일 후, 2주 전, 3개월 뒤)
  //    "N일 전" = 단일 일. "N주/N개월/N년 전"도 point-in-time = 단일 일 해석.
  {
    const re =
      /(\d+)\s*(일|주|개월|달|년|년도|주일)\s*(전|뒤|후)(?=$|\s|[.,!?~)]|에|엔|은|는|이|가|을|를|도|만|쯤|부터|까지)/g;
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
      const singleDay = unit !== "day";
      out.push({
        text: m[0],
        start: m.index,
        end: m.index + m[0].length,
        expression: {
          kind: "relative",
          unit,
          offset: sign * n,
          ...(singleDay ? { singleDay: true } : {}),
        },
        priority: 80,
      });
    }
  }

  // 8b. 반년 전/뒤 (= 6개월 전/뒤, point-in-time)
  {
    const re = /반년\s*(전|뒤|후)(?=$|\s|[.,!?~)]|에|엔|은|는|이|가|을|를|도|만|쯤|부터|까지)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      const sign = m[1] === "전" ? -1 : 1;
      out.push({
        text: m[0],
        start: m.index,
        end: m.index + m[0].length,
        expression: { kind: "relative", unit: "month", offset: sign * 6, singleDay: true },
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

  // 10b. "낼" 축약형 (내일). 보낼/낼름/오낼 등과의 오탐 방지 위해 한글/영문 경계 요구.
  {
    const re = /(?<![가-힣A-Za-z])낼(?![가-힣A-Za-z])/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      out.push({
        text: m[0],
        start: m.index,
        end: m.index + m[0].length,
        expression: { kind: "named", name: "tomorrow" },
        priority: 72,
      });
    }
  }

  // (영어 일상어 / 상대 / "N ago"는 patterns-en.ts로 이동)

  // 14-list. 콤마 구분 분기 목록 (2,3분기) — 각 숫자를 별도 Match로 분리
  {
    const re = /(?<![\d가-힣])([1-4](?:\s*,\s*[1-4])+)\s*분기/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      const fullMatch = m[0];
      const parts = m[1].split(/\s*,\s*/);
      let cursor = 0;
      for (let i = 0; i < parts.length; i++) {
        const num = parts[i];
        const posInMatch = fullMatch.indexOf(num, cursor);
        const absStart = m.index + posInMatch;
        const isLast = i === parts.length - 1;
        const absEnd = isLast ? m.index + fullMatch.length : absStart + num.length;
        const q = Number(num) as 1 | 2 | 3 | 4;
        out.push({
          text: num + "분기",
          start: absStart,
          end: absEnd,
          expression: { kind: "quarter", quarter: q, yearOffset: 0 },
          priority: 83,
        });
        cursor = posInMatch + num.length;
      }
    }
  }

  // 14-list-prefix. (prefix) 콤마 구분 분기 목록 (작년 2,3분기)
  {
    const re =
      /(재작년|제작년|지난해|작년|올해|금년|내년|후년)\s*([1-4](?:\s*,\s*[1-4])+)\s*분기/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      const prefix = m[1];
      const yearOffset =
        prefix === "재작년" || prefix === "제작년" ? -2
        : prefix === "작년" || prefix === "지난해" ? -1
        : prefix === "내년" ? 1
        : prefix === "후년" ? 2
        : 0;
      const fullMatch = m[0];
      const parts = m[2].split(/\s*,\s*/);
      let cursor = 0;
      for (let i = 0; i < parts.length; i++) {
        const num = parts[i];
        const posInMatch = fullMatch.indexOf(num, cursor);
        const absStart = i === 0 ? m.index : m.index + posInMatch;
        const isLast = i === parts.length - 1;
        const absEnd = isLast ? m.index + fullMatch.length : m.index + posInMatch + num.length;
        const q = Number(num) as 1 | 2 | 3 | 4;
        out.push({
          text: i === 0 ? fullMatch.slice(0, posInMatch + num.length) + "분기" : num + "분기",
          start: absStart,
          end: absEnd,
          expression: { kind: "quarter", quarter: q, yearOffset },
          priority: 93,
        });
        cursor = posInMatch + num.length;
      }
    }
  }

  // 14-list-year. YYYY년 콤마 구분 분기 목록 (2025년 2,3분기)
  {
    const re = /(\d{4})\s*년\s*([1-4](?:\s*,\s*[1-4])+)\s*분기/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      const year = Number(m[1]);
      const fullMatch = m[0];
      const parts = m[2].split(/\s*,\s*/);
      // 연도 부분(YYYY년)과 숫자가 겹치지 않도록 숫자 목록 시작 위치부터 탐색
      let cursor = fullMatch.indexOf(m[2]);
      for (let i = 0; i < parts.length; i++) {
        const num = parts[i];
        const posInMatch = fullMatch.indexOf(num, cursor);
        const absStart = i === 0 ? m.index : m.index + posInMatch;
        const isLast = i === parts.length - 1;
        const absEnd = isLast ? m.index + fullMatch.length : m.index + posInMatch + num.length;
        const q = Number(num) as 1 | 2 | 3 | 4;
        out.push({
          text: i === 0 ? fullMatch.slice(0, posInMatch + num.length) + "분기" : num + "분기",
          start: absStart,
          end: absEnd,
          expression: { kind: "quarter", quarter: q, year },
          priority: 95,
        });
        cursor = posInMatch + num.length;
      }
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
    const re = /(재작년|제작년|지난해|작년|올해|금년|내년|후년)\s*([1-4])\s*분기/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      const prefix = m[1];
      const yearOffset =
        prefix === "재작년" || prefix === "제작년" ? -2
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

  // 14d. (작년/올해/내년/...) N분기 + 초/말
  //      예: "작년 1분기 초", "내년 2분기 말"
  {
    const re =
      /(재작년|제작년|지난해|작년|올해|금년|내년|후년)\s*([1-4])\s*분기\s*(초|말)(?!\s*\d)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      const prefix = m[1];
      const yearOffset =
        prefix === "재작년" || prefix === "제작년" ? -2
        : prefix === "작년" || prefix === "지난해" ? -1
        : prefix === "내년" ? 1
        : prefix === "후년" ? 2
        : 0;
      const q = Number(m[2]) as 1 | 2 | 3 | 4;
      out.push({
        text: m[0],
        start: m.index,
        end: m.index + m[0].length,
        expression: {
          kind: "quarter",
          quarter: q,
          yearOffset,
          part: m[3] === "초" ? "early" : "late",
        },
        priority: 93,
      });
    }
  }

  // 14e. YYYY년 N분기 + 초/말
  //      예: "2025년 1분기 초", "2024년 3분기 말"
  {
    const re = /(\d{4})\s*년\s*([1-4])\s*분기\s*(초|말)(?!\s*\d)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      const q = Number(m[2]) as 1 | 2 | 3 | 4;
      out.push({
        text: m[0],
        start: m.index,
        end: m.index + m[0].length,
        expression: {
          kind: "quarter",
          quarter: q,
          year: Number(m[1]),
          part: m[3] === "초" ? "early" : "late",
        },
        priority: 95,
      });
    }
  }

  // 15. 이번/지난/지지난/다음/저번/차 분기
  {
    const re = /(지지난|저번|지난|이번|금|차|다음)\s*분기/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      const p = m[1];
      const offset =
        p === "지지난" ? -2
        : p === "지난" || p === "저번" ? -1
        : p === "다음" || p === "차" ? 1
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

  // 15b. 전년 동월 / 작년 동기 — 같은 연도 오프셋 기준 동일 월 또는 동일 분기
  {
    const YEAR_ALIASES: Array<{ word: string; yearOffset: number }> = [
      { word: "재작년", yearOffset: -2 },
      { word: "전전년", yearOffset: -2 },
      { word: "작년", yearOffset: -1 },
      { word: "전년", yearOffset: -1 },
      { word: "금년", yearOffset: 0 },
      { word: "올해", yearOffset: 0 },
      { word: "내년", yearOffset: 1 },
      { word: "명년", yearOffset: 1 },
    ];
    for (const { word, yearOffset } of YEAR_ALIASES) {
      let m: RegExpExecArray | null;
      const reMonth = new RegExp(`${word}\\s*동월`, "g");
      while ((m = reMonth.exec(text))) {
        out.push({
          text: m[0], start: m.index, end: m.index + m[0].length,
          expression: { kind: "absolute", yearOffset, monthOffset: 0 },
          priority: 85,
        });
      }
      const reQtr = new RegExp(`${word}\\s*동기`, "g");
      while ((m = reQtr.exec(text))) {
        out.push({
          text: m[0], start: m.index, end: m.index + m[0].length,
          expression: { kind: "quarter", quarterOffset: 0, yearOffset },
          priority: 85,
        });
      }
    }
  }

  // 15c. 올해/작년/내년 마지막 주 (12/31 기준 주 시작 ~ 12/31)
  {
    const YEAR_ALIASES_LW: Array<{ word: string; yearOffset: number }> = [
      { word: "재작년", yearOffset: -2 },
      { word: "전전년", yearOffset: -2 },
      { word: "작년", yearOffset: -1 },
      { word: "전년", yearOffset: -1 },
      { word: "올해", yearOffset: 0 },
      { word: "금년", yearOffset: 0 },
      { word: "내년", yearOffset: 1 },
      { word: "명년", yearOffset: 1 },
    ];
    for (const { word, yearOffset } of YEAR_ALIASES_LW) {
      const re = new RegExp(`${word}\\s*마지막\\s*주(?!\\s*[차에의])`, "g");
      let m: RegExpExecArray | null;
      while ((m = re.exec(text))) {
        out.push({
          text: m[0], start: m.index, end: m.index + m[0].length,
          expression: { kind: "absolute", yearOffset, weekOfYear: "last" },
          priority: 88,
        });
      }
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
    const re = /(\d{4})\s*년\s*(상|하)\s*반기\s*(?:와|과|및|랑|하고|[,/])\s*(상|하)\s*반기/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      const secondHalf = (m[3] === "상" ? 1 : 2) as 1 | 2;
      const secondText = `${m[3]}반기`;
      const secondStartInMatch = m[0].lastIndexOf(secondText);
      if (secondStartInMatch < 0) continue;
      const secondStart = m.index + secondStartInMatch;
      out.push({
        text: secondText,
        start: secondStart,
        end: secondStart + secondText.length,
        expression: { kind: "half", half: secondHalf, year: Number(m[1]) },
        priority: 91,
      });
    }
  }
  {
    const re = /(재작년|제작년|지난해|작년|올해|금년|내년|후년)\s*(상|하)\s*반기/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      const prefix = m[1];
      const yearOffset =
        prefix === "재작년" || prefix === "제작년" ? -2
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

  // 16b-rel. 상대 반기: "다음 반기", "지난 반기", "이번 반기" (상/하 없음)
  //     기준일의 현재 반기에 halfOffset을 더해 해석. 기존 "지난 상/하반기"와 구분하기 위해
  //     "반기" 앞에 "상/하"가 없어야 함 (lookbehind).
  {
    const re = /(다음|다가오는|오는|지난|저번|이전|이번)\s*(?<![상하])반기/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      const word = m[1];
      const halfOffset =
        word === "이번" ? 0
        : word === "지난" || word === "저번" || word === "이전" ? -1
        : 1;
      out.push({
        text: m[0],
        start: m.index,
        end: m.index + m[0].length,
        expression: { kind: "half", half: 1, halfOffset },
        priority: 89,
      });
    }
  }

  // 16c. 단독 상/하반기 (올해 기준)
  {
    const re = /(?<!(?:재작년|제작년|지난해|작년|올해|금년|내년|후년|지난)\s*)(상|하)\s*반기/g;
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

  // 17b. 일주일/한 달/한 해/일년 + 전/뒤/후 (point-in-time; 단일 날짜)
  {
    const re =
      /(일주일|한\s*달|한\s*해|한\s*주|일\s*년)\s*(전|뒤|후)(?=$|\s|[.,!?~)]|에|엔|은|는|이|가|을|를|도|만|쯤|부터|까지)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      const word = m[1].replace(/\s+/g, "");
      const sign = m[2] === "전" ? -1 : 1;
      let unit: "day" | "month" | "year" = "day";
      let offset = 0;
      let singleDay = false;
      if (word === "일주일" || word === "한주") {
        unit = "day";
        offset = sign * 7;
      } else if (word === "한달") {
        unit = "month";
        offset = sign * 1;
        singleDay = true;
      } else if (word === "한해" || word === "일년") {
        unit = "year";
        offset = sign * 1;
        singleDay = true;
      }
      out.push({
        text: m[0],
        start: m.index,
        end: m.index + m[0].length,
        expression: { kind: "relative", unit, offset, ...(singleDay ? { singleDay: true } : {}) },
        priority: 82,
      });
    }
  }

  // 17c. 최근/지난 + 일주일/한 주/한 달/한 해 (기간; 시작=N 전, 끝=오늘)
  {
    const re = /(최근|지난)\s*(일주일|한\s*주|한\s*달|한\s*해|일\s*년)(?!\s*(전|뒤|후))/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      const word = m[2].replace(/\s+/g, "");
      let unit: "day" | "month" | "year" = "day";
      let amount = 1;
      if (word === "일주일" || word === "한주") {
        unit = "day";
        amount = 7;
      } else if (word === "한달") {
        unit = "month";
        amount = 1;
      } else if (word === "한해" || word === "일년") {
        unit = "year";
        amount = 1;
      }
      out.push({
        text: m[0],
        start: m.index,
        end: m.index + m[0].length,
        expression: { kind: "duration", unit, amount, direction: "past" },
        priority: 84,
      });
    }
  }

  // 17d. 최근/지난 + N일/N주/N개월/N년 (간|동안 suffix 없이도 duration으로 해석)
  {
    const KOREAN_NUM: Record<string, number> = {
      한: 1, 두: 2, 세: 3, 네: 4, 다섯: 5,
      여섯: 6, 일곱: 7, 여덟: 8, 아홉: 9, 열: 10,
    };
    const re =
      /(최근|지난)\s*(\d+|한|두|세|네|다섯|여섯|일곱|여덟|아홉|열)\s*(일|주일|주|개월|달|년|해)(?!\s*(전|뒤|후))/g;
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
        priority: 84,
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
  //     "N일치/짜리" 같은 집계/기간 접미사는 날짜가 아니므로 exclude.
  {
    const re =
      /(?<![\d가-힣])(\d{1,2})\s*일(?!\s*(전|뒤|후|이상|이하|이내|동안|간|째|부터|까지|치|짜리))/g;
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
      { word: "제작년", offset: -2 },
      { word: "지난해", offset: -1 },
      { word: "작년", offset: -1 },
      { word: "올해", offset: 0 },
      { word: "금년", offset: 0 },
      { word: "내년", offset: 1 },
      { word: "후년", offset: 2 },
    ];
    for (const { word, offset } of PREFIXES) {
      const re = new RegExp(
        `${word}\\s*(\\d{1,2})\\s*월(?:\\s*(초|중|말)|\\s*(${WEEK_OF_MONTH_RE_SRC}))?(?!\\s*\\d+\\s*일)`,
        "g",
      );
      let m: RegExpExecArray | null;
      while ((m = re.exec(text))) {
        const mp = m[2];
        const wk = m[3];
        const baseExpr: AbsoluteExpression = {
          kind: "absolute",
          yearOffset: offset,
          month: Number(m[1]),
        };
        if (mp === "초") baseExpr.monthPart = "early";
        else if (mp === "중") baseExpr.monthPart = "mid";
        else if (mp === "말") baseExpr.monthPart = "late";
        else if (wk) {
          const n = parseWeekOfMonth(wk);
          if (n) baseExpr.weekOfMonth = n;
        }
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

  // 20-list. (prefix) 콤마 구분 월 목록 (작년 2,3,4월)
  {
    const PREFIXES: Array<{ word: string; offset: number }> = [
      { word: "재작년", offset: -2 },
      { word: "제작년", offset: -2 },
      { word: "지난해", offset: -1 },
      { word: "작년", offset: -1 },
      { word: "올해", offset: 0 },
      { word: "금년", offset: 0 },
      { word: "내년", offset: 1 },
      { word: "후년", offset: 2 },
    ];
    for (const { word, offset } of PREFIXES) {
      const re = new RegExp(
        `${word}\\s*(\\d{1,2}(?:\\s*,\\s*\\d{1,2})+)\\s*월(?!\\s*\\d+\\s*일)`,
        "g",
      );
      let m: RegExpExecArray | null;
      while ((m = re.exec(text))) {
        const fullMatch = m[0];
        const parts = m[1].split(/\s*,\s*/);
        let cursor = 0;
        for (let i = 0; i < parts.length; i++) {
          const num = parts[i];
          const posInMatch = fullMatch.indexOf(num, cursor);
          const absStart = i === 0 ? m.index : m.index + posInMatch;
          const isLast = i === parts.length - 1;
          const absEnd = isLast ? m.index + fullMatch.length : m.index + posInMatch + num.length;
          out.push({
            text: i === 0 ? fullMatch.slice(0, posInMatch + num.length) + "월" : num + "월",
            start: absStart,
            end: absEnd,
            expression: { kind: "absolute", yearOffset: offset, month: Number(num) },
            priority: 92,
          });
          cursor = posInMatch + num.length;
        }
      }
    }
  }

  // 20-list-space. (prefix) 공백/쉼표/무구분 월 목록
  //   예: "작년 1월 2월", "내년 3월 4월 5월", "작년 1월2월", "작년 1월, 2월"
  // 각 N월 뒤에는 N일이 올 수 없음 (그럼 개별 월일 패턴이 처리).
  {
    const PREFIXES: Array<{ word: string; offset: number }> = [
      { word: "재작년", offset: -2 },
      { word: "제작년", offset: -2 },
      { word: "지난해", offset: -1 },
      { word: "작년", offset: -1 },
      { word: "올해", offset: 0 },
      { word: "금년", offset: 0 },
      { word: "내년", offset: 1 },
      { word: "후년", offset: 2 },
    ];
    for (const { word, offset } of PREFIXES) {
      const re = new RegExp(
        `${word}\\s*(\\d{1,2}\\s*월(?!\\s*\\d+\\s*일)(?:\\s*,?\\s*\\d{1,2}\\s*월(?!\\s*\\d+\\s*일))+)`,
        "g",
      );
      let m: RegExpExecArray | null;
      while ((m = re.exec(text))) {
        const list = m[1]; // "1월 2월 3월"
        const fullStart = m.index;
        const listStart = fullStart + (m[0].length - list.length);
        const tokenRe = /(\d{1,2})\s*월/g;
        let tm: RegExpExecArray | null;
        const tokens: Array<{ num: number; start: number; end: number; text: string }> = [];
        while ((tm = tokenRe.exec(list))) {
          tokens.push({
            num: Number(tm[1]),
            start: listStart + tm.index,
            end: listStart + tm.index + tm[0].length,
            text: tm[0],
          });
        }
        for (let i = 0; i < tokens.length; i++) {
          const t = tokens[i];
          out.push({
            text: i === 0 ? text.slice(fullStart, t.end) : t.text,
            start: i === 0 ? fullStart : t.start,
            end: t.end,
            expression: { kind: "absolute", yearOffset: offset, month: t.num },
            priority: 92,
          });
        }
      }
    }
  }

  // 3-list-year-space. YYYY년 공백/쉼표/무구분 월 목록
  //   예: "2025년 1월 2월 3월", "2025년 1월2월", "2025년 1월, 2월"
  {
    const re =
      /(\d{4})\s*년\s*(\d{1,2}\s*월(?!\s*\d+\s*일)(?:\s*,?\s*\d{1,2}\s*월(?!\s*\d+\s*일))+)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      const year = Number(m[1]);
      const list = m[2];
      const fullStart = m.index;
      const listStart = fullStart + (m[0].length - list.length);
      const tokenRe = /(\d{1,2})\s*월/g;
      let tm: RegExpExecArray | null;
      const tokens: Array<{ num: number; start: number; end: number; text: string }> = [];
      while ((tm = tokenRe.exec(list))) {
        tokens.push({
          num: Number(tm[1]),
          start: listStart + tm.index,
          end: listStart + tm.index + tm[0].length,
          text: tm[0],
        });
      }
      for (let i = 0; i < tokens.length; i++) {
        const t = tokens[i];
        out.push({
          text: i === 0 ? text.slice(fullStart, t.end) : t.text,
          start: i === 0 ? fullStart : t.start,
          end: t.end,
          expression: { kind: "absolute", year, month: t.num },
          priority: 94,
        });
      }
    }
  }

  // 20c. (재작년|작년|올해|내년|후년|지난해|지난 해|금년) 초/말
  //      "YYYY년 초/말" (rule 2d)의 상대형 버전.
  {
    const YEAR_PREFIXES: Array<{ word: string; offset: number }> = [
      { word: "재작년", offset: -2 },
      { word: "제작년", offset: -2 },
      { word: "지난해", offset: -1 },
      { word: "지난 해", offset: -1 },
      { word: "전년", offset: -1 },
      { word: "작년", offset: -1 },
      { word: "올해", offset: 0 },
      { word: "금년", offset: 0 },
      { word: "내년", offset: 1 },
      { word: "후년", offset: 2 },
    ];
    for (const { word, offset } of YEAR_PREFIXES) {
      const re = new RegExp(`${word}\\s*(초|말)(?!\\s*\\d)`, "g");
      let m: RegExpExecArray | null;
      while ((m = re.exec(text))) {
        out.push({
          text: m[0],
          start: m.index,
          end: m.index + m[0].length,
          expression: {
            kind: "absolute",
            yearOffset: offset,
            yearPart: m[1] === "초" ? "early" : "late",
          },
          priority: 89,
        });
      }
    }
  }

  // 20d. (이번|지난|다음|저번|지지난|전전) 달 + 초/초순/중/중순/말/하순
  {
    const MONTH_PREFIXES: Array<{ word: string; offset: number }> = [
      { word: "지지난\\s*달", offset: -2 },
      { word: "저저번\\s*달", offset: -2 },
      { word: "전전월", offset: -2 },
      { word: "저번\\s*달", offset: -1 },
      { word: "지난\\s*달", offset: -1 },
      { word: "전월", offset: -1 },
      { word: "이번\\s*달", offset: 0 },
      { word: "이달", offset: 0 },
      { word: "당월", offset: 0 },
      { word: "금월", offset: 0 },
      { word: "다다음\\s*달", offset: 2 },
      { word: "다음\\s*달", offset: 1 },
      { word: "내달", offset: 1 },
      { word: "익월", offset: 1 },
    ];
    for (const { word, offset } of MONTH_PREFIXES) {
      const re = new RegExp(`${word}\\s*(초순|하순|중순|초|중|말)(?!\\s*\\d|일)`, "g");
      let m: RegExpExecArray | null;
      while ((m = re.exec(text))) {
        const part = m[1];
        // 초/말은 경계(월초일/월말일) 단일 날짜. 초순/중순/하순은 10일 구간 범위.
        const monthPart =
          part === "초" ? ("start" as const)
          : part === "초순" ? ("early" as const)
          : part === "중" || part === "중순" ? ("mid" as const)
          : part === "하순" ? ("late" as const)
          : ("end" as const);
        out.push({
          text: m[0],
          start: m.index,
          end: m.index + m[0].length,
          expression: {
            kind: "absolute",
            monthOffset: offset,
            monthPart,
          },
          priority: 89,
        });
      }
    }
  }

  // 20d-day. (이번|지난|다음|저번|지지난|전전) 달 + 초일/말일 (단일 날짜)
  //      "지난달 말일" = 지난달 마지막 날 (단일), "이번달 초일" = 이번달 1일
  {
    const MONTH_PREFIXES: Array<{ word: string; offset: number }> = [
      { word: "지지난\\s*달", offset: -2 },
      { word: "저저번\\s*달", offset: -2 },
      { word: "전전월", offset: -2 },
      { word: "저번\\s*달", offset: -1 },
      { word: "지난\\s*달", offset: -1 },
      { word: "전월", offset: -1 },
      { word: "이번\\s*달", offset: 0 },
      { word: "이달", offset: 0 },
      { word: "당월", offset: 0 },
      { word: "금월", offset: 0 },
      { word: "다다음\\s*달", offset: 2 },
      { word: "다음\\s*달", offset: 1 },
      { word: "내달", offset: 1 },
      { word: "익월", offset: 1 },
    ];
    for (const { word, offset } of MONTH_PREFIXES) {
      const re = new RegExp(`${word}\\s*(초일|말일|마지막\\s*날|첫\\s*날|첫날)`, "g");
      let m: RegExpExecArray | null;
      while ((m = re.exec(text))) {
        const label = m[1].replace(/\s+/g, "");
        const monthPart =
          label === "초일" || label === "첫날" ? ("start" as const)
          : ("end" as const);
        out.push({
          text: m[0],
          start: m.index,
          end: m.index + m[0].length,
          expression: {
            kind: "absolute",
            monthOffset: offset,
            monthPart,
          },
          priority: 90,
        });
      }
    }
  }

  // 20f. (이번|지난|다음|저번|지지난|전전) 달 + N주차/첫째주 (단일 주차)
  //      "지난달 첫째주", "이번달 1주차", "다음달 둘째주" 등.
  {
    const MONTH_PREFIXES: Array<{ word: string; offset: number }> = [
      { word: "지지난\\s*달", offset: -2 },
      { word: "저저번\\s*달", offset: -2 },
      { word: "전전월", offset: -2 },
      { word: "저번\\s*달", offset: -1 },
      { word: "지난\\s*달", offset: -1 },
      { word: "전월", offset: -1 },
      { word: "이번\\s*달", offset: 0 },
      { word: "이달", offset: 0 },
      { word: "당월", offset: 0 },
      { word: "금월", offset: 0 },
      { word: "다다음\\s*달", offset: 2 },
      { word: "다음\\s*달", offset: 1 },
      { word: "내달", offset: 1 },
      { word: "익월", offset: 1 },
    ];
    for (const { word, offset } of MONTH_PREFIXES) {
      const re = new RegExp(`${word}\\s*(${WEEK_OF_MONTH_RE_SRC})`, "g");
      let m: RegExpExecArray | null;
      while ((m = re.exec(text))) {
        const wk = parseWeekOfMonth(m[1]);
        if (!wk) continue;
        out.push({
          text: m[0],
          start: m.index,
          end: m.index + m[0].length,
          expression: {
            kind: "absolute",
            monthOffset: offset,
            weekOfMonth: wk,
          },
          priority: 90,
        });
      }
    }
  }

  // 20f-day. (이번|지난|다음|...) 달 + N주차 + 요일 (단일 날짜)
  //      "이달 둘째주 금요일", "이번달 셋째주 수욜", "다음달 1주차 월요일" 등.
  {
    const MONTH_PREFIXES: Array<{ word: string; offset: number }> = [
      { word: "지지난\\s*달", offset: -2 },
      { word: "저저번\\s*달", offset: -2 },
      { word: "전전월", offset: -2 },
      { word: "저번\\s*달", offset: -1 },
      { word: "지난\\s*달", offset: -1 },
      { word: "전월", offset: -1 },
      { word: "이번\\s*달", offset: 0 },
      { word: "이달", offset: 0 },
      { word: "당월", offset: 0 },
      { word: "금월", offset: 0 },
      { word: "다다음\\s*달", offset: 2 },
      { word: "다음\\s*달", offset: 1 },
      { word: "내달", offset: 1 },
      { word: "익월", offset: 1 },
    ];
    const KO_WEEKDAYS_LOCAL: Array<{ word: string; weekday: number }> = [
      { word: "일요일", weekday: 0 }, { word: "일욜", weekday: 0 },
      { word: "월요일", weekday: 1 }, { word: "월욜", weekday: 1 },
      { word: "화요일", weekday: 2 }, { word: "화욜", weekday: 2 },
      { word: "수요일", weekday: 3 }, { word: "수욜", weekday: 3 },
      { word: "목요일", weekday: 4 }, { word: "목욜", weekday: 4 },
      { word: "금요일", weekday: 5 }, { word: "금욜", weekday: 5 },
      { word: "토요일", weekday: 6 }, { word: "토욜", weekday: 6 },
    ];
    for (const { word, offset } of MONTH_PREFIXES) {
      for (const { word: dw, weekday } of KO_WEEKDAYS_LOCAL) {
        const re = new RegExp(
          `${word}\\s*(${WEEK_OF_MONTH_RE_SRC})\\s*${dw}`,
          "g",
        );
        let m: RegExpExecArray | null;
        while ((m = re.exec(text))) {
          const wk = parseWeekOfMonth(m[1]);
          if (!wk) continue;
          out.push({
            text: m[0],
            start: m.index,
            end: m.index + m[0].length,
            expression: {
              kind: "absolute",
              monthOffset: offset,
              weekOfMonth: wk,
              weekday,
            },
            priority: 95,
          });
        }
      }
    }
  }

  // 20g. (이번|지난|다음|...) 달 + 콤마 구분 숫자 주차 목록
  //      "지난달 1,2주", "이번달 1,2,3주차" 등.
  {
    const MONTH_PREFIXES: Array<{ word: string; offset: number }> = [
      { word: "지지난\\s*달", offset: -2 },
      { word: "저저번\\s*달", offset: -2 },
      { word: "전전월", offset: -2 },
      { word: "저번\\s*달", offset: -1 },
      { word: "지난\\s*달", offset: -1 },
      { word: "전월", offset: -1 },
      { word: "이번\\s*달", offset: 0 },
      { word: "이달", offset: 0 },
      { word: "당월", offset: 0 },
      { word: "금월", offset: 0 },
      { word: "다다음\\s*달", offset: 2 },
      { word: "다음\\s*달", offset: 1 },
      { word: "내달", offset: 1 },
      { word: "익월", offset: 1 },
    ];
    for (const { word, offset } of MONTH_PREFIXES) {
      const re = new RegExp(
        `${word}\\s*([1-5](?:\\s*,\\s*[1-5])+)\\s*주(?:\\s*차)?`,
        "g",
      );
      let m: RegExpExecArray | null;
      while ((m = re.exec(text))) {
        const fullMatch = m[0];
        const parts = m[1].split(/\s*,\s*/);
        let cursor = 0;
        for (let i = 0; i < parts.length; i++) {
          const num = parts[i];
          const n = Number(num) as 1 | 2 | 3 | 4 | 5;
          if (n < 1 || n > 5) continue;
          const posInMatch = fullMatch.indexOf(num, cursor);
          const absStart = i === 0 ? m.index : m.index + posInMatch;
          const isLast = i === parts.length - 1;
          const absEnd = isLast
            ? m.index + fullMatch.length
            : m.index + posInMatch + num.length;
          out.push({
            text:
              i === 0
                ? fullMatch.slice(0, posInMatch + num.length) + "주"
                : num + "주",
            start: absStart,
            end: absEnd,
            expression: {
              kind: "absolute",
              monthOffset: offset,
              weekOfMonth: n,
            },
            priority: 91,
          });
          cursor = posInMatch + num.length;
        }
      }
    }
  }

  // 20h. (이번|지난|다음|...) 달 + 서수 주차 목록 (쉼표/공백 구분)
  //      "지난달 첫째주, 둘째주", "지난달 첫째주 둘째주",
  //      "이번달 첫째주, 둘째주, 셋째주" 등.
  {
    const MONTH_PREFIXES: Array<{ word: string; offset: number }> = [
      { word: "지지난\\s*달", offset: -2 },
      { word: "저저번\\s*달", offset: -2 },
      { word: "전전월", offset: -2 },
      { word: "저번\\s*달", offset: -1 },
      { word: "지난\\s*달", offset: -1 },
      { word: "전월", offset: -1 },
      { word: "이번\\s*달", offset: 0 },
      { word: "이달", offset: 0 },
      { word: "당월", offset: 0 },
      { word: "금월", offset: 0 },
      { word: "다다음\\s*달", offset: 2 },
      { word: "다음\\s*달", offset: 1 },
      { word: "내달", offset: 1 },
      { word: "익월", offset: 1 },
    ];
    const ORDINAL_WEEK = "(?:첫째?주|둘째주|셋째주|넷째주|다섯째주)";
    const ORDINAL_SEP = "(?:\\s*,\\s*|\\s+)";
    const ORDINAL_RE = new RegExp(ORDINAL_WEEK, "g");
    for (const { word, offset } of MONTH_PREFIXES) {
      const re = new RegExp(
        `${word}\\s*(${ORDINAL_WEEK}(?:${ORDINAL_SEP}${ORDINAL_WEEK})+)`,
        "g",
      );
      let m: RegExpExecArray | null;
      while ((m = re.exec(text))) {
        const fullMatch = m[0];
        const list = m[1];
        const listStart = m.index + (fullMatch.length - list.length);
        ORDINAL_RE.lastIndex = 0;
        const tokens: Array<{ w: number; start: number; end: number; text: string }> = [];
        let tm: RegExpExecArray | null;
        while ((tm = ORDINAL_RE.exec(list))) {
          const n = parseWeekOfMonth(tm[0]);
          if (!n) continue;
          tokens.push({
            w: n,
            start: listStart + tm.index,
            end: listStart + tm.index + tm[0].length,
            text: tm[0],
          });
        }
        for (let i = 0; i < tokens.length; i++) {
          const t = tokens[i];
          out.push({
            text: i === 0 ? text.slice(m.index, t.end) : t.text,
            start: i === 0 ? m.index : t.start,
            end: t.end,
            expression: {
              kind: "absolute",
              monthOffset: offset,
              weekOfMonth: t.w as 1 | 2 | 3 | 4 | 5,
            },
            priority: 91,
          });
        }
      }
    }
  }

  // 20i. (이번|지난|다음|...) 달 + 개별 주차 토큰 목록 (공백/쉼표 구분)
  //      "지난달 1주 2주", "지난달 1주, 2주", "지난달 1주차 2주차" 등.
  //      (20g는 "지난달 1,2주" 처럼 숫자만 쉼표로 묶는 케이스)
  {
    const MONTH_PREFIXES: Array<{ word: string; offset: number }> = [
      { word: "지지난\\s*달", offset: -2 },
      { word: "저저번\\s*달", offset: -2 },
      { word: "전전월", offset: -2 },
      { word: "저번\\s*달", offset: -1 },
      { word: "지난\\s*달", offset: -1 },
      { word: "전월", offset: -1 },
      { word: "이번\\s*달", offset: 0 },
      { word: "이달", offset: 0 },
      { word: "당월", offset: 0 },
      { word: "금월", offset: 0 },
      { word: "다다음\\s*달", offset: 2 },
      { word: "다음\\s*달", offset: 1 },
      { word: "내달", offset: 1 },
      { word: "익월", offset: 1 },
    ];
    const WEEK_NUM = "[1-5]\\s*주(?:\\s*차)?";
    const WEEK_SEP = "(?:\\s*,\\s*|\\s+)";
    const TOKEN_RE = /([1-5])\s*주(?:\s*차)?/g;
    for (const { word, offset } of MONTH_PREFIXES) {
      const re = new RegExp(
        `${word}\\s*(${WEEK_NUM}(?:${WEEK_SEP}${WEEK_NUM})+)`,
        "g",
      );
      let m: RegExpExecArray | null;
      while ((m = re.exec(text))) {
        const fullMatch = m[0];
        const list = m[1];
        const listStart = m.index + (fullMatch.length - list.length);
        TOKEN_RE.lastIndex = 0;
        const tokens: Array<{ w: number; start: number; end: number; text: string }> = [];
        let tm: RegExpExecArray | null;
        while ((tm = TOKEN_RE.exec(list))) {
          const n = Number(tm[1]);
          if (n < 1 || n > 5) continue;
          tokens.push({
            w: n,
            start: listStart + tm.index,
            end: listStart + tm.index + tm[0].length,
            text: tm[0],
          });
        }
        for (let i = 0; i < tokens.length; i++) {
          const t = tokens[i];
          out.push({
            text: i === 0 ? text.slice(m.index, t.end) : t.text,
            start: i === 0 ? m.index : t.start,
            end: t.end,
            expression: {
              kind: "absolute",
              monthOffset: offset,
              weekOfMonth: t.w as 1 | 2 | 3 | 4 | 5,
            },
            priority: 91,
          });
        }
      }
    }
  }

  // 20e. (이번|지난|다음|지지난|저번) 분기 + 초/말
  //      quarterOffset으로 전달하여 resolver가 기준일 기준 분기 계산.
  {
    const QTR_PREFIXES: Array<{ word: string; offset: number }> = [
      { word: "지지난", offset: -2 },
      { word: "저번", offset: -1 },
      { word: "지난", offset: -1 },
      { word: "이번", offset: 0 },
      { word: "다음", offset: 1 },
    ];
    for (const { word, offset } of QTR_PREFIXES) {
      const re = new RegExp(`${word}\\s*분기\\s*(초|말)(?!\\s*\\d)`, "g");
      let m: RegExpExecArray | null;
      while ((m = re.exec(text))) {
        out.push({
          text: m[0],
          start: m.index,
          end: m.index + m[0].length,
          expression: {
            kind: "quarter",
            quarterOffset: offset,
            part: m[1] === "초" ? "early" : "late",
          },
          priority: 89,
        });
      }
    }
  }

  // 20b. (전년|작년|지난해|재작년) 대비 → 암묵적 "올해"도 함께 반환
  //      단, "작년 대비 올해"처럼 뒤에 비교 대상이 명시되면 중복 보강하지 않는다.
  {
    const re = /(전년|작년|지난해|재작년|제작년)\s*(대비)/g;
    const explicitComparatorRe =
      /^\s*(?:전년|재작년|제작년|지난해|작년|올해|금년|내년|후년|\d{4}\s*년)/;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      const daeBiStart = m.index + m[0].length - m[2].length;
      const rest = text.slice(daeBiStart + m[2].length);
      if (explicitComparatorRe.test(rest)) continue;
      out.push({
        text: m[2],
        start: daeBiStart,
        end: daeBiStart + m[2].length,
        expression: { kind: "relative", unit: "year", offset: 0 },
        priority: 79,
      });
    }
  }

  // 22. 공휴일 고유명 (설날, 추석, 어린이날, 크리스마스, 삼일절, ...)
  //     yearOffset=0 으로 지정 → 기준 연도 고정, ambiguity shift 건너뜀.
  {
    const NAMED_HOLIDAYS: Array<{ word: string; expr: AbsoluteExpression }> = [
      { word: "설날", expr: { kind: "absolute", yearOffset: 0, month: 1, day: 1, lunar: true } },
      { word: "구정", expr: { kind: "absolute", yearOffset: 0, month: 1, day: 1, lunar: true } },
      { word: "추석", expr: { kind: "absolute", yearOffset: 0, month: 8, day: 15, lunar: true } },
      { word: "한가위", expr: { kind: "absolute", yearOffset: 0, month: 8, day: 15, lunar: true } },
      { word: "어린이날", expr: { kind: "absolute", yearOffset: 0, month: 5, day: 5 } },
      // 크리스마스 이브 (12/24) — 반드시 크리스마스보다 먼저 등록하여 longer-match 우선권 확보.
      { word: "크리스마스 이브", expr: { kind: "absolute", yearOffset: 0, month: 12, day: 24 } },
      { word: "크리스마스이브", expr: { kind: "absolute", yearOffset: 0, month: 12, day: 24 } },
      { word: "크리스마스", expr: { kind: "absolute", yearOffset: 0, month: 12, day: 25 } },
      { word: "성탄절", expr: { kind: "absolute", yearOffset: 0, month: 12, day: 25 } },
      { word: "삼일절", expr: { kind: "absolute", yearOffset: 0, month: 3, day: 1 } },
      { word: "3·1절", expr: { kind: "absolute", yearOffset: 0, month: 3, day: 1 } },
      { word: "광복절", expr: { kind: "absolute", yearOffset: 0, month: 8, day: 15 } },
      { word: "현충일", expr: { kind: "absolute", yearOffset: 0, month: 6, day: 6 } },
      { word: "한글날", expr: { kind: "absolute", yearOffset: 0, month: 10, day: 9 } },
      { word: "개천절", expr: { kind: "absolute", yearOffset: 0, month: 10, day: 3 } },
      { word: "제헌절", expr: { kind: "absolute", yearOffset: 0, month: 7, day: 17 } },
      { word: "신정", expr: { kind: "absolute", yearOffset: 0, month: 1, day: 1 } },
      { word: "부처님오신날", expr: { kind: "absolute", yearOffset: 0, month: 4, day: 8, lunar: true } },
      { word: "부처님 오신 날", expr: { kind: "absolute", yearOffset: 0, month: 4, day: 8, lunar: true } },
      { word: "석가탄신일", expr: { kind: "absolute", yearOffset: 0, month: 4, day: 8, lunar: true } },
      { word: "사월초파일", expr: { kind: "absolute", yearOffset: 0, month: 4, day: 8, lunar: true } },
      { word: "초파일", expr: { kind: "absolute", yearOffset: 0, month: 4, day: 8, lunar: true } },
      { word: "정월 대보름", expr: { kind: "absolute", yearOffset: 0, month: 1, day: 15, lunar: true } },
      { word: "정월대보름", expr: { kind: "absolute", yearOffset: 0, month: 1, day: 15, lunar: true } },
      { word: "대보름", expr: { kind: "absolute", yearOffset: 0, month: 1, day: 15, lunar: true } },
    ];
    for (const { word, expr } of NAMED_HOLIDAYS) {
      let idx = 0;
      while ((idx = text.indexOf(word, idx)) !== -1) {
        const end = idx + word.length;
        // 공휴일 ± 오프셋: "크리스마스 전날/다음날/이튿날/익일"
        const offsetMatch = /^\s*(전날|다음날|이튿날|익일)/.exec(text.slice(end));
        if (offsetMatch) {
          const dayOffset = offsetMatch[1] === "전날" ? -1 : 1;
          const offsetEnd = end + offsetMatch[0].length;
          out.push({
            text: text.slice(idx, offsetEnd),
            start: idx,
            end: offsetEnd,
            expression: { ...expr, dayOffset },
            priority: 98,
          });
          idx = offsetEnd;
          continue;
        }
        const base: Match = {
          text: word,
          start: idx,
          end,
          expression: { ...expr },
          priority: 96,
        };
        const withFilter = tryAttachFilter(text, base.end, base);
        out.push(withFilter ?? base);
        idx = end;
      }
    }
  }

  // 23. 월말/월초/연말/연초 (단일 날짜)
  //     "월말" = 이번달 말일, "연말" = 올해 12/31
  {
    const MONTH_YEAR_EDGE: Array<{ word: string; expr: AbsoluteExpression }> = [
      { word: "월말", expr: { kind: "absolute", monthOffset: 0, monthPart: "end" } },
      { word: "월초", expr: { kind: "absolute", monthOffset: 0, monthPart: "start" } },
      { word: "연말", expr: { kind: "absolute", yearOffset: 0, yearPart: "end" } },
      { word: "연초", expr: { kind: "absolute", yearOffset: 0, yearPart: "start" } },
      { word: "년말", expr: { kind: "absolute", yearOffset: 0, yearPart: "end" } },
      { word: "년초", expr: { kind: "absolute", yearOffset: 0, yearPart: "start" } },
    ];
    for (const { word, expr } of MONTH_YEAR_EDGE) {
      const re = new RegExp(`(?<![가-힣])${word}(?![가-힣])`, "g");
      let m: RegExpExecArray | null;
      while ((m = re.exec(text))) {
        out.push({
          text: m[0],
          start: m.index,
          end: m.index + m[0].length,
          expression: { ...expr },
          priority: 86,
        });
      }
    }
  }

  // 23b. 분기말/분기초 (bare — 이번 분기 기준)
  //      "분기말" = 이번 분기 마지막 구간, "분기초" = 이번 분기 첫 구간
  {
    const QTR_EDGE: Array<{ word: string; part: "early" | "late" }> = [
      { word: "분기말", part: "late" },
      { word: "분기초", part: "early" },
    ];
    for (const { word, part } of QTR_EDGE) {
      const re = new RegExp(`(?<![가-힣])${word}(?![가-힣])`, "g");
      let m: RegExpExecArray | null;
      while ((m = re.exec(text))) {
        out.push({
          text: m[0],
          start: m.index,
          end: m.index + m[0].length,
          expression: { kind: "quarter", quarterOffset: 0, part },
          priority: 86,
        });
      }
    }
  }

  // 23c. {기간} 마지막/첫 영업일|평일|공휴일
  {
    const PERIOD_MAP: Array<{ word: string; base: DateExpression }> = [
      { word: "이번달|이번 달|이달|당월|금월", base: { kind: "relative", unit: "month", offset: 0 } },
      { word: "지난달|지난 달|저번달|저번 달|전월", base: { kind: "relative", unit: "month", offset: -1 } },
      { word: "지지난달|저저번달|전전월", base: { kind: "relative", unit: "month", offset: -2 } },
      { word: "다음달|다음 달|내달|익월", base: { kind: "relative", unit: "month", offset: 1 } },
      { word: "이번주|이번 주|금주", base: { kind: "relative", unit: "week", offset: 0 } },
      { word: "지난주|지난 주|저번주|저번 주|전주", base: { kind: "relative", unit: "week", offset: -1 } },
      { word: "다음주|다음 주|담주|차주", base: { kind: "relative", unit: "week", offset: 1 } },
    ];
    const FILTER_MAP: Array<{ word: string; filter: FilterKind }> = [
      { word: "영업일|업무일", filter: "business_days" },
      { word: "평일|주중", filter: "weekdays" },
      { word: "공휴일|휴일", filter: "holidays" },
    ];
    for (const { word: pw, base } of PERIOD_MAP) {
      for (const { word: fw, filter } of FILTER_MAP) {
        const re = new RegExp(`(?:${pw})\\s*(마지막|첫|첫번째|첫째)\\s*(?:${fw})`, "g");
        let m: RegExpExecArray | null;
        while ((m = re.exec(text))) {
          const sel = m[1] === "마지막" ? "last" : "first";
          out.push({
            text: m[0], start: m.index, end: m.index + m[0].length,
            expression: { kind: "filter", base, filter, select: sel } as DateExpression,
            priority: 92,
          });
        }
      }
    }
  }

  // 24. 주 + 요일 (이번주 월요일, 지난주 금요일, 다음주 수요일 등)
  //     WeekdayInWeekExpression 으로 emit. rule+llm 폴백보다 높은 우선순위로 단일 룰 매칭.
  {
    const KO_WEEKDAYS: Array<{ word: string; weekday: number }> = [
      { word: "일요일", weekday: 0 },
      { word: "월요일", weekday: 1 },
      { word: "화요일", weekday: 2 },
      { word: "수요일", weekday: 3 },
      { word: "목요일", weekday: 4 },
      { word: "금요일", weekday: 5 },
      { word: "토요일", weekday: 6 },
      // 구어체 축약 (금욜/토욜/일욜 등)
      { word: "일욜", weekday: 0 },
      { word: "월욜", weekday: 1 },
      { word: "화욜", weekday: 2 },
      { word: "수욜", weekday: 3 },
      { word: "목욜", weekday: 4 },
      { word: "금욜", weekday: 5 },
      { word: "토욜", weekday: 6 },
      // 한 글자 약어 (저번주 목, 이번주 금 등) — 뒤에 한글이 오면 오탐 방지
      { word: "일(?![가-힣])", weekday: 0 },
      { word: "월(?![가-힣])", weekday: 1 },
      { word: "화(?![가-힣])", weekday: 2 },
      { word: "수(?![가-힣])", weekday: 3 },
      { word: "목(?![가-힣])", weekday: 4 },
      { word: "금(?![가-힣])", weekday: 5 },
      { word: "토(?![가-힣])", weekday: 6 },
    ];
    const WEEK_PREFIXES: Array<{ word: string; offset: number }> = [
      { word: "지지난\\s*주", offset: -2 },
      { word: "저저번\\s*주", offset: -2 },
      { word: "전전\\s*주", offset: -2 },
      { word: "저번\\s*주", offset: -1 },
      { word: "지난\\s*주", offset: -1 },
      { word: "전주", offset: -1 },
      { word: "이번\\s*주", offset: 0 },
      { word: "금주", offset: 0 },
      { word: "다다음\\s*주", offset: 2 },
      { word: "다음\\s*주", offset: 1 },
      { word: "담주", offset: 1 },
      { word: "차주", offset: 1 },
      // 주(週) 없이 바로 수식하는 형태 (저번 목요일, 지난 금요일 등)
      // (?!\s*주)로 "저번주…" 패턴과 중복 방지
      { word: "저저번(?!\\s*주)", offset: -2 },
      { word: "지지난(?!\\s*주)", offset: -2 },
      { word: "저번(?!\\s*주)", offset: -1 },
      { word: "지난(?!\\s*주)", offset: -1 },
    ];
    for (const { word: pw, offset } of WEEK_PREFIXES) {
      for (const { word: dw, weekday } of KO_WEEKDAYS) {
        const re = new RegExp(`${pw}\\s*${dw}`, "g");
        let m: RegExpExecArray | null;
        while ((m = re.exec(text))) {
          out.push({
            text: m[0],
            start: m.index,
            end: m.index + m[0].length,
            expression: { kind: "weekday_in_week", weekOffset: offset, weekday },
            priority: 94,
          });
        }
      }
    }
  }

  // (영어 last/next + weekday는 patterns-en.ts로 이동)

  // 24b. (오는|돌아오는|다가오는) + 요일 → 기준일 이후 가장 가까운 해당 요일.
  //      "오는 금요일", "돌아오는 월요일", "다가오는 화요일" 등. 당일이면 +7일(다음 해당 요일).
  {
    const KO_WEEKDAYS_LOCAL: Array<{ word: string; weekday: number }> = [
      { word: "일요일", weekday: 0 }, { word: "일욜", weekday: 0 },
      { word: "월요일", weekday: 1 }, { word: "월욜", weekday: 1 },
      { word: "화요일", weekday: 2 }, { word: "화욜", weekday: 2 },
      { word: "수요일", weekday: 3 }, { word: "수욜", weekday: 3 },
      { word: "목요일", weekday: 4 }, { word: "목욜", weekday: 4 },
      { word: "금요일", weekday: 5 }, { word: "금욜", weekday: 5 },
      { word: "토요일", weekday: 6 }, { word: "토욜", weekday: 6 },
    ];
    const MODIFIERS = ["다가오는", "돌아오는", "오는"];
    for (const mod of MODIFIERS) {
      for (const { word: dw, weekday } of KO_WEEKDAYS_LOCAL) {
        const re = new RegExp(`${mod}\\s*${dw}`, "g");
        let m: RegExpExecArray | null;
        while ((m = re.exec(text))) {
          out.push({
            text: m[0],
            start: m.index,
            end: m.index + m[0].length,
            expression: {
              kind: "weekday_in_week",
              weekOffset: 0,
              weekday,
              nearestFuture: true,
            },
            priority: 94,
          });
        }
      }
    }
  }

  // 24d. N주 뒤/후/전 + 요일 (예: "2주 뒤 화요일", "3주 후 금요일", "2주 전 월요일")
  {
    const KO_WEEKDAYS_NUM: Array<{ word: string; weekday: number }> = [
      { word: "일요일", weekday: 0 }, { word: "일욜", weekday: 0 },
      { word: "월요일", weekday: 1 }, { word: "월욜", weekday: 1 },
      { word: "화요일", weekday: 2 }, { word: "화욜", weekday: 2 },
      { word: "수요일", weekday: 3 }, { word: "수욜", weekday: 3 },
      { word: "목요일", weekday: 4 }, { word: "목욜", weekday: 4 },
      { word: "금요일", weekday: 5 }, { word: "금욜", weekday: 5 },
      { word: "토요일", weekday: 6 }, { word: "토욜", weekday: 6 },
    ];
    for (const { word: dw, weekday } of KO_WEEKDAYS_NUM) {
      const re = new RegExp(`(\\d+)\\s*주\\s*([뒤후전])\\s*${dw}`, "g");
      let m: RegExpExecArray | null;
      while ((m = re.exec(text))) {
        const n = Number(m[1]);
        const weekOffset = m[2] === "전" ? -n : n;
        out.push({
          text: m[0], start: m.index, end: m.index + m[0].length,
          expression: { kind: "weekday_in_week", weekOffset, weekday },
          priority: 95,
        });
      }
    }
  }

  // 24c. (다음|오는|다가오는|지난|저번|이전|이번) 영업일/업무일 — 업무형 상대 표현
  //      기준일에서 주말/공휴일을 건너뛰며 다음/이전 business day를 단일 날짜로 반환.
  {
    const BIZ_RULES: Array<{ word: string; token: NamedToken }> = [
      { word: "다가오는", token: "next_business_day" },
      { word: "다음", token: "next_business_day" },
      { word: "오는", token: "next_business_day" },
      { word: "지난", token: "prev_business_day" },
      { word: "저번", token: "prev_business_day" },
      { word: "이전", token: "prev_business_day" },
      { word: "이번", token: "today_or_next_business_day" },
    ];
    for (const { word, token } of BIZ_RULES) {
      const re = new RegExp(`(?<![가-힣])${word}\\s*(영업일|업무일)`, "g");
      let m: RegExpExecArray | null;
      while ((m = re.exec(text))) {
        out.push({
          text: m[0],
          start: m.index,
          end: m.index + m[0].length,
          expression: { kind: "named", name: token },
          priority: 90,
        });
      }
    }
  }

  // 24d. (다음|오는|다가오는|지난|저번|이전|이번) 공휴일/휴일 — 가장 가까운 공휴일 단일 날짜
  {
    const HOLIDAY_RULES: Array<{ word: string; token: NamedToken }> = [
      { word: "다가오는", token: "next_holiday" },
      { word: "다음", token: "next_holiday" },
      { word: "오는", token: "next_holiday" },
      { word: "지난", token: "prev_holiday" },
      { word: "저번", token: "prev_holiday" },
      { word: "이전", token: "prev_holiday" },
      { word: "이번", token: "today_or_next_holiday" },
    ];
    for (const { word, token } of HOLIDAY_RULES) {
      const re = new RegExp(`(?<![가-힣])${word}\\s*(공휴일|휴일)`, "g");
      let m: RegExpExecArray | null;
      while ((m = re.exec(text))) {
        out.push({
          text: m[0],
          start: m.index,
          end: m.index + m[0].length,
          expression: { kind: "named", name: token },
          priority: 90,
        });
      }
    }
  }

  // 24e. 단독 요일 (prefix 없음) — nearestFuture=true로 가장 가까운 해당 요일.
  //      "목요일", "금욜" 등 prefix 없이 쓴 경우. 우선순위 60으로 prefix 규칙에 양보.
  {
    const KO_WEEKDAYS_STANDALONE: Array<{ word: string; weekday: number }> = [
      { word: "일요일", weekday: 0 },
      { word: "월요일", weekday: 1 },
      { word: "화요일", weekday: 2 },
      { word: "수요일", weekday: 3 },
      { word: "목요일", weekday: 4 },
      { word: "금요일", weekday: 5 },
      { word: "토요일", weekday: 6 },
      { word: "일욜", weekday: 0 },
      { word: "월욜", weekday: 1 },
      { word: "화욜", weekday: 2 },
      { word: "수욜", weekday: 3 },
      { word: "목욜", weekday: 4 },
      { word: "금욜", weekday: 5 },
      { word: "토욜", weekday: 6 },
    ];
    for (const { word, weekday } of KO_WEEKDAYS_STANDALONE) {
      const re = new RegExp(`(?<![가-힣])${word}`, "g");
      let m: RegExpExecArray | null;
      while ((m = re.exec(text))) {
        out.push({
          text: m[0],
          start: m.index,
          end: m.index + m[0].length,
          expression: { kind: "weekday_in_week", weekOffset: 0, weekday, nearest: true },
          priority: 60,
        });
      }
    }
  }

  // 25. (재작년|작년|올해|내년|후년|지난해|금년|...) + 오늘/어제/내일/모레/그저께/글피
  //     "작년 오늘" = 1년 전 이맘때 (같은 월/일).
  //     NamedExpression.yearOffset 으로 emit하여 resolveNamed가 처리.
  {
    const YEAR_PREFIXES: Array<{ word: string; offset: number }> = [
      { word: "재작년", offset: -2 },
      { word: "제작년", offset: -2 },
      { word: "지난해", offset: -1 },
      { word: "작년", offset: -1 },
      { word: "전년", offset: -1 },
      { word: "올해", offset: 0 },
      { word: "금년", offset: 0 },
      { word: "내년", offset: 1 },
      { word: "후년", offset: 2 },
    ];
    const DAY_WORDS: Array<{ word: string; token: NamedToken }> = [
      { word: "오늘", token: "today" },
      { word: "어제", token: "yesterday" },
      { word: "내일", token: "tomorrow" },
      { word: "모레", token: "모레" },
      { word: "글피", token: "글피" },
      { word: "그저께", token: "그저께" },
    ];
    for (const { word: pw, offset } of YEAR_PREFIXES) {
      for (const { word: dw, token } of DAY_WORDS) {
        const re = new RegExp(`${pw}\\s*${dw}`, "g");
        let m: RegExpExecArray | null;
        while ((m = re.exec(text))) {
          out.push({
            text: m[0],
            start: m.index,
            end: m.index + m[0].length,
            expression: { kind: "named", name: token, yearOffset: offset },
            priority: 93,
          });
        }
      }
    }
  }

  // 26. (prefix) M월 D일 — "내년 1월 1일", "작년 3월 15일"
  //     기존 rule 20은 "일" 없는 경우만 처리. 여기서는 D일 포함.
  {
    const PREFIXES: Array<{ word: string; offset: number }> = [
      { word: "재작년", offset: -2 },
      { word: "제작년", offset: -2 },
      { word: "지난해", offset: -1 },
      { word: "작년", offset: -1 },
      { word: "올해", offset: 0 },
      { word: "금년", offset: 0 },
      { word: "내년", offset: 1 },
      { word: "후년", offset: 2 },
    ];
    for (const { word, offset } of PREFIXES) {
      const re = new RegExp(
        `${word}\\s*(\\d{1,2})\\s*월\\s*(\\d{1,2})\\s*일`,
        "g",
      );
      let m: RegExpExecArray | null;
      while ((m = re.exec(text))) {
        out.push({
          text: m[0],
          start: m.index,
          end: m.index + m[0].length,
          expression: {
            kind: "absolute",
            yearOffset: offset,
            month: Number(m[1]),
            day: Number(m[2]),
          },
          priority: 97,
        });
      }
    }
  }

  // 26b. 음력 M월 D일 — "음력 1월 1일" = 설날
  {
    const re = /음력\s*(\d{1,2})\s*월\s*(\d{1,2})\s*일/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      out.push({
        text: m[0],
        start: m.index,
        end: m.index + m[0].length,
        expression: {
          kind: "absolute",
          yearOffset: 0,
          month: Number(m[1]),
          day: Number(m[2]),
          lunar: true,
        },
        priority: 97,
      });
    }
  }

  // 26c. 음력 M월 — "음력 1월" (day 없음)
  {
    const re = /음력\s*(\d{1,2})\s*월(?!\s*\d+\s*일)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      out.push({
        text: m[0],
        start: m.index,
        end: m.index + m[0].length,
        expression: {
          kind: "absolute",
          yearOffset: 0,
          month: Number(m[1]),
          lunar: true,
        },
        priority: 93,
      });
    }
  }

  // 27a. <date>부터 D일까지  (끝 날짜에서 월 생략 → 시작 월 상속)
  //      지원 형태: "YYYY년 M월 D일부터 D일까지", "M월 D일부터 D일까지",
  //                 "M월 D일 ~ D일"
  {
    const datePat = "(?:(\\d{4})\\s*년\\s*)?(\\d{1,2})\\s*월\\s*(\\d{1,2})\\s*일";
    const re = new RegExp(
      `${datePat}\\s*(?:부터|~|-|에서)\\s*(\\d{1,2})\\s*일(?:\\s*까지)?`,
      "g",
    );
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      const y1 = m[1] ? Number(m[1]) : undefined;
      const mo1 = Number(m[2]);
      const d1 = Number(m[3]);
      const d2 = Number(m[4]);
      if (d2 <= d1) continue; // invalid or reversed range — skip
      const startExpr: AbsoluteExpression = {
        kind: "absolute",
        ...(y1 !== undefined ? { year: y1 } : { yearOffset: 0 }),
        month: mo1,
        day: d1,
      };
      const endExpr: AbsoluteExpression = {
        kind: "absolute",
        ...(y1 !== undefined ? { year: y1 } : { yearOffset: 0 }),
        month: mo1,
        day: d2,
      };
      out.push({
        text: m[0],
        start: m.index,
        end: m.index + m[0].length,
        expression: {
          kind: "range",
          start: startExpr,
          end: endExpr,
        },
        priority: 98,
      });
    }
  }

  // 27. <date>부터 <date>까지  범위 연결자
  //     지원 형태: "M월 D일부터 M월 D일까지", "YYYY년 M월 D일부터 ~ 까지" 등
  {
    const datePat = "(?:(\\d{4})\\s*년\\s*)?(\\d{1,2})\\s*월\\s*(\\d{1,2})\\s*일";
    const re = new RegExp(`${datePat}\\s*부터\\s*${datePat}\\s*까지`, "g");
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      const y1 = m[1] ? Number(m[1]) : undefined;
      const mo1 = Number(m[2]);
      const d1 = Number(m[3]);
      const y2 = m[4] ? Number(m[4]) : undefined;
      const mo2 = Number(m[5]);
      const d2 = Number(m[6]);
      // 연도 생략 시 yearOffset=0 고정 → ambiguity shift가 range 끝을
      // 작년으로 밀어 범위가 뒤집히는 현상 방지.
      const startExpr: AbsoluteExpression = {
        kind: "absolute",
        ...(y1 !== undefined ? { year: y1 } : { yearOffset: 0 }),
        month: mo1,
        day: d1,
      };
      const endExpr: AbsoluteExpression = {
        kind: "absolute",
        ...(y2 !== undefined ? { year: y2 } : { yearOffset: 0 }),
        month: mo2,
        day: d2,
      };
      out.push({
        text: m[0],
        start: m.index,
        end: m.index + m[0].length,
        expression: {
          kind: "range",
          start: startExpr,
          end: endExpr,
        },
        priority: 98,
      });
    }
  }

  // 27c. <start>부터 N(일|주일|주|개월|달|년)간/동안 — 시작일 + 지속기간 → range
  //      지원 start: 오늘/내일/어제/모레/그저께/엊그제/글피/그글피,
  //              YYYY년 M월 D일, M월 D일.
  //      지원 duration: 일주일/한 주/한 달/한 해/일년 (단일어),
  //              또는 N(일|주일|주|개월|달|년).
  {
    const NAMED_START_MAP: Record<string, NamedToken> = {
      오늘: "today",
      내일: "tomorrow",
      어제: "yesterday",
      모레: "모레",
      그저께: "그저께",
      엊그제: "엊그제",
      글피: "글피",
      그글피: "그글피",
    };
    const re =
      /(?:(오늘|내일|어제|모레|그저께|엊그제|글피|그글피)|(?:(\d{4})\s*년\s*)?(\d{1,2})\s*월\s*(\d{1,2})\s*일)\s*(?:부터|~|-)\s*(?:(일주일|한\s*주|한\s*달|한\s*해|일\s*년)|(\d+)\s*(일|주일|주|개월|달|년))\s*(?:간|동안)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      let startExpr: DateExpression;
      if (m[1]) {
        startExpr = { kind: "named", name: NAMED_START_MAP[m[1]] };
      } else {
        const y = m[2] ? Number(m[2]) : undefined;
        startExpr = {
          kind: "absolute",
          ...(y !== undefined ? { year: y } : { yearOffset: 0 }),
          month: Number(m[3]),
          day: Number(m[4]),
        };
      }
      let days: number | null = null;
      if (m[5]) {
        const w = m[5].replace(/\s+/g, "");
        if (w === "일주일" || w === "한주") days = 7;
        else if (w === "한달") days = 30;
        else if (w === "한해" || w === "일년") days = 365;
      } else {
        const n = Number(m[6]);
        const unit = m[7];
        if (unit === "일") days = n;
        else if (unit === "주" || unit === "주일") days = n * 7;
        else if (unit === "개월" || unit === "달") days = n * 30;
        else if (unit === "년") days = n * 365;
      }
      if (days === null || days < 1) continue;
      out.push({
        text: m[0],
        start: m.index,
        end: m.index + m[0].length,
        expression: {
          kind: "range",
          start: startExpr,
          durationDays: days,
        },
        priority: 98,
      });
    }
  }

  // 28. M/D ~ M/D 날짜 범위 ("4/15~4/18", "3/1 - 3/31")
  //     슬래시 구분 월/일 쌍을 tilde/dash로 연결한 형식. 연도 없으므로 yearOffset=0.
  {
    const re =
      /(?<![\d./])(\d{1,2})\s*\/\s*(\d{1,2})\s*[~\-]\s*(\d{1,2})\s*\/\s*(\d{1,2})(?!\s*[\/\d:])/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      const mo1 = Number(m[1]);
      const d1 = Number(m[2]);
      const mo2 = Number(m[3]);
      const d2 = Number(m[4]);
      if (mo1 < 1 || mo1 > 12 || mo2 < 1 || mo2 > 12) continue;
      if (d1 < 1 || d1 > 31 || d2 < 1 || d2 > 31) continue;
      out.push({
        text: m[0],
        start: m.index,
        end: m.index + m[0].length,
        expression: {
          kind: "range",
          start: { kind: "absolute", yearOffset: 0, month: mo1, day: d1 },
          end: { kind: "absolute", yearOffset: 0, month: mo2, day: d2 },
        },
        priority: 97,
      });
    }
  }

  // 28b. M/D 단일 (슬래시 구분, 연도 없음). 예: "4/15" → 올해 4월 15일.
  //      28 범위 규칙보다 priority 낮게 두어 "4/15~4/18" 내부 단일 매치는 묻히게 함.
  {
    const re = /(?<![\d./:])(\d{1,2})\s*\/\s*(\d{1,2})(?!\s*[\/\d:~\-])/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      const mo = Number(m[1]);
      const d = Number(m[2]);
      if (mo < 1 || mo > 12 || d < 1 || d > 31) continue;
      out.push({
        text: m[0],
        start: m.index,
        end: m.index + m[0].length,
        expression: { kind: "absolute", month: mo, day: d },
        priority: 82,
      });
    }
  }

  // 28c. D일 ~ D일 범위 ("15~18일", "15일 ~ 18일"). 시간 범위 "N시~M시"와 구분 위해 "일" 요구.
  //      yearOffset=0, monthOffset=0 (기준월). priority를 "N시~M시"(~82)보다 높게.
  {
    const re =
      /(?<![\d가-힣])(\d{1,2})\s*일?\s*[~\-]\s*(\d{1,2})\s*일(?!\s*(?:전|뒤|후|이상|이하|이내|동안|간|째|부터|까지|치))/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      const d1 = Number(m[1]);
      const d2 = Number(m[2]);
      if (d1 < 1 || d1 > 31 || d2 < 1 || d2 > 31) continue;
      if (d2 < d1) continue;
      out.push({
        text: m[0],
        start: m.index,
        end: m.index + m[0].length,
        expression: {
          kind: "range",
          start: { kind: "absolute", day: d1 },
          end: { kind: "absolute", day: d2 },
        },
        priority: 90,
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

  // 29. "이맘때" 기준일 대비 (퍼지 표현)
  //     "이맘때" 단독 → 오늘 ± fuzzy window.
  //     "(재작년|작년|올해|내년|...) 이맘때" → NamedExpression.yearOffset + fuzzy.
  {
    const YEAR_PREFIXES: Array<{ word: string; offset: number }> = [
      { word: "재작년", offset: -2 },
      { word: "제작년", offset: -2 },
      { word: "지난해", offset: -1 },
      { word: "작년", offset: -1 },
      { word: "전년", offset: -1 },
      { word: "올해", offset: 0 },
      { word: "금년", offset: 0 },
      { word: "내년", offset: 1 },
      { word: "후년", offset: 2 },
    ];
    for (const { word: pw, offset } of YEAR_PREFIXES) {
      const re = new RegExp(`${pw}\\s*이맘때`, "g");
      let m: RegExpExecArray | null;
      while ((m = re.exec(text))) {
        out.push({
          text: m[0],
          start: m.index,
          end: m.index + m[0].length,
          expression: {
            kind: "named",
            name: "today",
            yearOffset: offset,
            fuzzy: true,
          },
          priority: 93,
        });
      }
    }
    // 단독 "이맘때" — prefix 없음
    {
      const re = /(?<![가-힣])이맘때(?![가-힣])/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(text))) {
        out.push({
          text: m[0],
          start: m.index,
          end: m.index + m[0].length,
          expression: { kind: "named", name: "today", fuzzy: true },
          priority: 75,
        });
      }
    }
  }

  // 30. 퍼지 접미사 "쯤" / "경" — 기존 매치 뒤에 붙으면 해당 표현을 fuzzy=true로 확장.
  //     Absolute/Named 표현에만 적용. 원본 매치는 그대로 두고, priority를 높인 확장 매치를 추가.
  {
    const fuzzyBase = [...out];
    for (const base of fuzzyBase) {
      if (base.end >= text.length) continue;
      const rest = text.slice(base.end);
      const fm = /^\s*(쯤|경)(?![가-힣])/.exec(rest);
      if (!fm) continue;
      const expr = base.expression;
      if (expr.kind === "absolute") {
        out.push({
          text: text.slice(base.start, base.end + fm[0].length),
          start: base.start,
          end: base.end + fm[0].length,
          expression: { ...expr, fuzzy: true },
          priority: base.priority + 5,
        });
      } else if (expr.kind === "named") {
        out.push({
          text: text.slice(base.start, base.end + fm[0].length),
          start: base.start,
          end: base.end + fm[0].length,
          expression: { ...expr, fuzzy: true },
          priority: base.priority + 5,
        });
      }
    }
  }

  // --- 시간 매칭 ---
  const timeMatches = findTimeMatchesKo(text);

  // 기존 date 매치에 시간 붙이기 (내일 오후 3시, 다음주 월요일 저녁)
  const attached: Match[] = [];
  for (const base of out) {
    const a = tryAttachTime(text, base, timeMatches);
    if (a) attached.push(a);
  }
  out.push(...attached);

  // 독립 시간 매치 (오후 3시, 저녁, 15:30 → base=today)
  for (const tm of timeMatches) {
    out.push({
      text: tm.text,
      start: tm.start,
      end: tm.end,
      expression: {
        kind: "datetime",
        base: { kind: "named", name: "today" },
        time: tm.time,
      },
      priority: tm.priority,
    });
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

export const KOREAN_DATE_RESIDUAL_KEYWORDS = [
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
  "제작년",
  "어제",
  "오늘",
  "내일",
  "낼",
  "모레",
  "글피",
  "그저께",
  "엊그제",
  "그제",
  "작일",
  "전일",
  "금일",
  "명일",
  "익일",
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
  // 축약/구어 표현 안전망 (룰로 매칭되지 못하면 LLM 폴백)
  "이달",
  "전전월",
  "전월",
  "익월",
  "당월",
  "전전주",
  "담주",
  "차주",
  "전주",
  "주중",
  "초순",
  "하순",
  "분기말",
  "분기초",
  "반년",
  "내일모레",
  "동월",
  "동기",
  "전년",
  "마지막 주",
  "마지막 영업일",
  "첫 영업일",
  "금욜",
  "토욜",
  "일욜",
  "월욜",
  "화욜",
  "수욜",
  "목욜",
  "이맘때",
  "쯤",
  // time-of-day residual keywords
  "오전",
  "오후",
  "새벽",
  "아침",
  "점심",
  "정오",
  "저녁",
  "자정",
];

/**
 * 매치된 스팬들을 제거한 잔여 텍스트에 날짜 관련 키워드가 남아있는지 확인.
 * 남아있으면 LLM 폴백 필요 (partial match).
 */
export function hasResidualDateContent(
  text: string,
  matches: Match[],
  keywords: readonly string[] = KOREAN_DATE_RESIDUAL_KEYWORDS,
): boolean {
  let residual = "";
  let cursor = 0;
  const ordered = [...matches].sort((a, b) => a.start - b.start);
  for (const m of ordered) {
    residual += text.slice(cursor, m.start);
    cursor = m.end;
  }
  residual += text.slice(cursor);

  const lower = residual.toLowerCase();
  for (const kw of keywords) {
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
