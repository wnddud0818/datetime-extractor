import type {
  DateExpression,
  AbsoluteExpression,
} from "../types.js";
import {
  type Match,
  type FilterSuffixMap,
  tryAttachFilter,
} from "./patterns.js";
import {
  ENGLISH_DAY_WORDS,
  ENGLISH_NAMED_ALIASES,
  MONTH_NAMES,
  MONTH_NAME_ALT,
  ENGLISH_WEEKDAYS,
  ENGLISH_WEEKDAY_ALT,
} from "./numerals.js";

export const ENGLISH_FILTER_SUFFIX_MAP: FilterSuffixMap = [
  { re: /^\s*(business\s+days?)/i, filter: "business_days" },
  { re: /^\s*weekdays?/i, filter: "weekdays" },
  { re: /^\s*weekends?/i, filter: "weekends" },
  { re: /^\s*(public\s+)?holidays?/i, filter: "holidays" },
  { re: /^\s*saturdays?/i, filter: "saturdays" },
  { re: /^\s*sundays?/i, filter: "sundays" },
];

const MONTH_ALT = MONTH_NAME_ALT;

function monthFromName(word: string): number {
  return MONTH_NAMES[word.toLowerCase()];
}

/**
 * 영어 매치 후보를 반환. 한국어 `findMatchesKo`와 동일한 Match 포맷.
 */
export function findMatchesEn(text: string): Match[] {
  const out: Match[] = [];

  // 1. ISO 절대 (2025-12-25, 2025/12/25, 2025.12.25) — 언어 공통
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

  // 1b. 구분자 없는 YYYYMMDD (20250412). 언어 공통.
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

  // 1c. 구분자 없는 MMDD (0412 → April 12). 연도는 ambiguityStrategy로 해석.
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

  // 2. US M/D/Y — "3/15/2025" (M/D/Y 기본)
  {
    const re = /\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/g;
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
          year: Number(m[3]),
          month: mo,
          day: d,
        },
        priority: 98,
      });
    }
  }

  // 3. "March 1, 2025" / "March 1st 2025" / "March 1st, 2025"
  {
    const re = new RegExp(
      `\\b(${MONTH_ALT})\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4})\\b`,
      "gi",
    );
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      out.push({
        text: m[0],
        start: m.index,
        end: m.index + m[0].length,
        expression: {
          kind: "absolute",
          year: Number(m[3]),
          month: monthFromName(m[1]),
          day: Number(m[2]),
        },
        priority: 96,
      });
    }
  }

  // 3b. "1 March 2025" / "1st March 2025" (영국식 어순도 지원)
  {
    const re = new RegExp(
      `\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(${MONTH_ALT})\\s+(\\d{4})\\b`,
      "gi",
    );
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      out.push({
        text: m[0],
        start: m.index,
        end: m.index + m[0].length,
        expression: {
          kind: "absolute",
          year: Number(m[3]),
          month: monthFromName(m[2]),
          day: Number(m[1]),
        },
        priority: 96,
      });
    }
  }

  // 4. "March 1" / "Mar 1st" (연도 없음)
  {
    const re = new RegExp(
      `\\b(${MONTH_ALT})\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b(?!\\s*,?\\s*\\d{4})`,
      "gi",
    );
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      const d = Number(m[2]);
      if (d < 1 || d > 31) continue;
      out.push({
        text: m[0],
        start: m.index,
        end: m.index + m[0].length,
        expression: {
          kind: "absolute",
          month: monthFromName(m[1]),
          day: d,
        },
        priority: 85,
      });
    }
  }

  // 5. "March 2025" (연도 + 월 이름)
  {
    const re = new RegExp(`\\b(${MONTH_ALT})\\s+(\\d{4})\\b`, "gi");
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      out.push({
        text: m[0],
        start: m.index,
        end: m.index + m[0].length,
        expression: {
          kind: "absolute",
          year: Number(m[2]),
          month: monthFromName(m[1]),
        },
        priority: 93,
      });
    }
  }

  // 6. 월 단독 (+filter). "March", "Dec"
  //    뒤에 숫자가 붙으면 다른 룰이 먹으므로 lookahead로 배제.
  {
    const re = new RegExp(`\\b(${MONTH_ALT})\\b(?!\\s+\\d)`, "gi");
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      const base: Match = {
        text: m[0],
        start: m.index,
        end: m.index + m[0].length,
        expression: { kind: "absolute", month: monthFromName(m[1]) },
        priority: 70,
      };
      const withFilter = tryAttachFilter(text, base.end, base, ENGLISH_FILTER_SUFFIX_MAP);
      out.push(withFilter ?? base);
    }
  }

  // 7. 연도 단독 (19xx / 20xx) — 독립 4자리 숫자만
  {
    const re = /(?<![\w-])(19|20)(\d{2})(?![\w-])/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      const base: Match = {
        text: m[0],
        start: m.index,
        end: m.index + m[0].length,
        expression: { kind: "absolute", year: Number(m[1] + m[2]) },
        priority: 65,
      };
      const withFilter = tryAttachFilter(text, base.end, base, ENGLISH_FILTER_SUFFIX_MAP);
      out.push(withFilter ?? base);
    }
  }

  // 8. early/mid/late March
  {
    const re = new RegExp(`\\b(early|mid|late)\\s+(${MONTH_ALT})\\b`, "gi");
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      const part = m[1].toLowerCase();
      const monthPart =
        part === "early" ? ("early" as const)
        : part === "mid" ? ("mid" as const)
        : ("late" as const);
      out.push({
        text: m[0],
        start: m.index,
        end: m.index + m[0].length,
        expression: {
          kind: "absolute",
          month: monthFromName(m[2]),
          monthPart,
        },
        priority: 88,
      });
    }
  }

  // 9. "first week of March"
  {
    const re = new RegExp(`\\bfirst\\s+week\\s+of\\s+(${MONTH_ALT})\\b`, "gi");
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      out.push({
        text: m[0],
        start: m.index,
        end: m.index + m[0].length,
        expression: {
          kind: "absolute",
          month: monthFromName(m[1]),
          firstWeek: true,
        },
        priority: 89,
      });
    }
  }

  // 10. "beginning/start/end of 2025"
  {
    const re = /\b(beginning|start|end)\s+of\s+(\d{4})\b/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      const part = m[1].toLowerCase();
      out.push({
        text: m[0],
        start: m.index,
        end: m.index + m[0].length,
        expression: {
          kind: "absolute",
          year: Number(m[2]),
          yearPart: part === "end" ? "late" : "early",
        },
        priority: 90,
      });
    }
  }

  // 11. "the 15th" (이번 달 15일)
  {
    const re = /\bthe\s+(\d{1,2})(?:st|nd|rd|th)\b/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      const d = Number(m[1]);
      if (d < 1 || d > 31) continue;
      out.push({
        text: m[0],
        start: m.index,
        end: m.index + m[0].length,
        expression: { kind: "absolute", day: d },
        priority: 68,
      });
    }
  }

  // 12. last/this/next/previous + day/week/month/year/quarter (+filter)
  {
    const UNITS: Record<string, "day" | "week" | "month" | "year" | "quarter"> = {
      day: "day",
      week: "week",
      month: "month",
      year: "year",
      quarter: "quarter",
    };
    const re = /\b(last|next|this|previous)\s+(day|week|month|year|quarter)\b/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      const dirWord = m[1].toLowerCase();
      const unitWord = m[2].toLowerCase();
      const offset =
        dirWord === "last" || dirWord === "previous" ? -1
        : dirWord === "next" ? 1
        : 0;
      const unit = UNITS[unitWord];
      const base: Match = {
        text: m[0],
        start: m.index,
        end: m.index + m[0].length,
        expression: { kind: "relative", unit, offset },
        priority: 75,
      };
      const withFilter = tryAttachFilter(text, base.end, base, ENGLISH_FILTER_SUFFIX_MAP);
      out.push(withFilter ?? base);
    }
  }

  // 13. "last March" / "next January"
  {
    const re = new RegExp(`\\b(last|next)\\s+(${MONTH_ALT})\\b`, "gi");
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      const dir = m[1].toLowerCase();
      const offset = dir === "last" ? -1 : 1;
      out.push({
        text: m[0],
        start: m.index,
        end: m.index + m[0].length,
        expression: {
          kind: "absolute",
          yearOffset: offset,
          month: monthFromName(m[2]),
        },
        priority: 86,
      });
    }
  }

  // 14. "N days/weeks/months/years ago"
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

  // 15. "in N days" / "N days from now" / "N days later"
  {
    const re =
      /\bin\s+(\d+)\s+(day|week|month|year)s?\b|\b(\d+)\s+(day|week|month|year)s?\s+(from\s+now|later)\b/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      const n = Number(m[1] ?? m[3]);
      const unitWord = (m[2] ?? m[4]).toLowerCase();
      const unit = unitWord as "day" | "week" | "month" | "year";
      out.push({
        text: m[0],
        start: m.index,
        end: m.index + m[0].length,
        expression: { kind: "relative", unit, offset: n },
        priority: 80,
      });
    }
  }

  // 16. yesterday/today/tomorrow (+filter)
  for (const { word, token } of ENGLISH_DAY_WORDS) {
    const re = new RegExp(`\\b${word}\\b`, "gi");
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      const base: Match = {
        text: m[0],
        start: m.index,
        end: m.index + m[0].length,
        expression: { kind: "named", name: token },
        priority: 72,
      };
      const withFilter = tryAttachFilter(text, base.end, base, ENGLISH_FILTER_SUFFIX_MAP);
      out.push(withFilter ?? base);
    }
  }

  // 17. "day after tomorrow" / "day before yesterday" / 18. "fortnight ago/from now"
  for (const alias of ENGLISH_NAMED_ALIASES) {
    const re = new RegExp(alias.pattern.source, alias.pattern.flags.includes("g") ? alias.pattern.flags : alias.pattern.flags + "g");
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      const expr: DateExpression = alias.direction
        ? { kind: "named", name: alias.token, direction: alias.direction }
        : { kind: "named", name: alias.token };
      out.push({
        text: m[0],
        start: m.index,
        end: m.index + m[0].length,
        expression: expr,
        priority: alias.direction ? 78 : 74,
      });
    }
  }

  // 19. "Q1" / "Q1 2025" / "Q2 of 2025"
  {
    const re = /\bQ([1-4])(?:\s+(?:of\s+)?(\d{4}))?\b/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      const q = Number(m[1]) as 1 | 2 | 3 | 4;
      if (m[2]) {
        out.push({
          text: m[0],
          start: m.index,
          end: m.index + m[0].length,
          expression: { kind: "quarter", quarter: q, year: Number(m[2]) },
          priority: 94,
        });
      } else {
        out.push({
          text: m[0],
          start: m.index,
          end: m.index + m[0].length,
          expression: { kind: "quarter", quarter: q, yearOffset: 0 },
          priority: 82,
        });
      }
    }
  }

  // 19b. "first quarter" / "second quarter of 2025" / "1st quarter"
  {
    const ORDINAL: Record<string, 1 | 2 | 3 | 4> = {
      first: 1, "1st": 1,
      second: 2, "2nd": 2,
      third: 3, "3rd": 3,
      fourth: 4, "4th": 4,
    };
    const re = /\b(first|second|third|fourth|1st|2nd|3rd|4th)\s+quarter(?:\s+of\s+(\d{4}))?\b/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      const q = ORDINAL[m[1].toLowerCase()];
      if (!q) continue;
      if (m[2]) {
        out.push({
          text: m[0],
          start: m.index,
          end: m.index + m[0].length,
          expression: { kind: "quarter", quarter: q, year: Number(m[2]) },
          priority: 94,
        });
      } else {
        out.push({
          text: m[0],
          start: m.index,
          end: m.index + m[0].length,
          expression: { kind: "quarter", quarter: q, yearOffset: 0 },
          priority: 82,
        });
      }
    }
  }

  // 20. "H1" / "H2 2025" / "H1 of 2025"
  {
    const re = /\bH([12])(?:\s+(?:of\s+)?(\d{4}))?\b/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      const half = Number(m[1]) as 1 | 2;
      if (m[2]) {
        out.push({
          text: m[0],
          start: m.index,
          end: m.index + m[0].length,
          expression: { kind: "half", half, year: Number(m[2]) },
          priority: 92,
        });
      } else {
        out.push({
          text: m[0],
          start: m.index,
          end: m.index + m[0].length,
          expression: { kind: "half", half, yearOffset: 0 },
          priority: 78,
        });
      }
    }
  }

  // 20b. "first/second half of 2025" / "first half"
  {
    const re = /\b(first|second|1st|2nd)\s+half(?:\s+of\s+(\d{4}))?\b/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      const w = m[1].toLowerCase();
      const half = (w === "first" || w === "1st" ? 1 : 2) as 1 | 2;
      if (m[2]) {
        out.push({
          text: m[0],
          start: m.index,
          end: m.index + m[0].length,
          expression: { kind: "half", half, year: Number(m[2]) },
          priority: 92,
        });
      } else {
        out.push({
          text: m[0],
          start: m.index,
          end: m.index + m[0].length,
          expression: { kind: "half", half, yearOffset: 0 },
          priority: 78,
        });
      }
    }
  }

  // 21. "past/last N days/weeks/months/years" (duration) — "N ago"와 구분
  //     "last month" (단수)는 rule 12가 먹고, "last 3 months"는 여기로.
  {
    const re = /\b(past|last)\s+(\d+)\s+(day|week|month|year)s?\b/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      const amount = Number(m[2]);
      const unit = m[3].toLowerCase() as "day" | "week" | "month" | "year";
      const base: Match = {
        text: m[0],
        start: m.index,
        end: m.index + m[0].length,
        expression: { kind: "duration", unit, amount, direction: "past" },
        priority: 83,
      };
      const withFilter = tryAttachFilter(text, base.end, base, ENGLISH_FILTER_SUFFIX_MAP);
      out.push(withFilter ?? base);
    }
  }

  // 21b. "since March 2025" / "since 2025" — range(start..today)
  {
    const re = new RegExp(
      `\\bsince\\s+(?:(${MONTH_ALT})\\s+)?(\\d{4})\\b`,
      "gi",
    );
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      const monthWord = m[1];
      const year = Number(m[2]);
      const startExpr: AbsoluteExpression = monthWord
        ? { kind: "absolute", year, month: monthFromName(monthWord) }
        : { kind: "absolute", year };
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

  // 22. last/next/this/previous + weekday
  {
    const re = new RegExp(
      `\\b(last|next|this|previous)\\s+(${ENGLISH_WEEKDAY_ALT})\\b`,
      "gi",
    );
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      const dirWord = m[1].toLowerCase();
      const dayWord = m[2].toLowerCase();
      const offset =
        dirWord === "last" || dirWord === "previous" ? -1
        : dirWord === "next" ? 1
        : 0;
      const weekday = ENGLISH_WEEKDAYS[dayWord];
      if (weekday === undefined) continue;
      out.push({
        text: m[0],
        start: m.index,
        end: m.index + m[0].length,
        expression: { kind: "weekday_in_week", weekOffset: offset, weekday },
        priority: 92,
      });
    }
  }

  return out;
}

export const ENGLISH_DATE_RESIDUAL_KEYWORDS: readonly string[] = [
  "yesterday",
  "today",
  "tomorrow",
  "last",
  "next",
  "this",
  "previous",
  "ago",
  "past",
  "since",
  "fortnight",
  "january", "february", "march", "april", "may", "june",
  "july", "august", "september", "october", "november", "december",
  "jan", "feb", "mar", "apr", "jun", "jul", "aug", "sept", "sep", "oct", "nov", "dec",
  "quarter", "half", "weekday", "weekdays", "weekend", "weekends",
  "business", "holiday", "holidays",
];
