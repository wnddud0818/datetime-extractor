import { randomInt } from "node:crypto";
import {
  addDays,
  addMonths,
  addQuarters,
  addWeeks,
  addYears,
  endOfMonth,
  endOfQuarter,
  endOfYear,
  format,
  startOfQuarter,
  startOfWeek,
  startOfYear,
} from "date-fns";
import { extract } from "../dist/index.js";

function mulberry32(seed) {
  return function next() {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const seed = randomInt(1, 2 ** 31 - 1);
const rand = mulberry32(seed);
const pick = (items) => items[Math.floor(rand() * items.length)];
const int = (min, max) => Math.floor(rand() * (max - min + 1)) + min;

const REFS = [
  new Date(2026, 0, 15),
  new Date(2026, 3, 20),
  new Date(2026, 5, 30),
  new Date(2026, 8, 17),
  new Date(2026, 10, 25),
  new Date(2026, 11, 29),
];

const SUFFIXES = [
  " 일정 괜찮아?",
  " 가능해?",
  " 어떻게 생각해?",
  " 문제없지?",
  " 괜찮을까?",
  " 어때?",
];

const PREFIXES = ["", "", "", "혹시 ", "이번 건 ", "그럼 "];
const WEEKDAYS = [
  { label: "일요일", js: 0 },
  { label: "월요일", js: 1 },
  { label: "화요일", js: 2 },
  { label: "수요일", js: 3 },
  { label: "목요일", js: 4 },
  { label: "금요일", js: 5 },
  { label: "토요일", js: 6 },
];

const YEAR_WORDS = [
  { label: "작년", offset: -1 },
  { label: "올해", offset: 0 },
  { label: "내년", offset: 1 },
];

function wrap(expr) {
  return `${pick(PREFIXES)}${expr}${pick(SUFFIXES)}`;
}

function fmt(date) {
  return format(date, "yyyy-MM-dd");
}

function sameDay(date) {
  return { start: fmt(date), end: fmt(date) };
}

function span(start, end) {
  return { start: fmt(start), end: fmt(end) };
}

function daysInMonth(year, month1) {
  return endOfMonth(new Date(year, month1 - 1, 1)).getDate();
}

function resolvePastYear(ref, month1, day) {
  const candidate = new Date(ref.getFullYear(), month1 - 1, day);
  return candidate > ref ? ref.getFullYear() - 1 : ref.getFullYear();
}

function weekdayDeltaFromMondayStart(weekdayJs) {
  return (weekdayJs - 1 + 7) % 7;
}

function quarterRange(year, quarter) {
  const start = new Date(year, (quarter - 1) * 3, 1);
  return span(start, endOfQuarter(start));
}

function halfRange(year, half) {
  return half === 1
    ? span(new Date(year, 0, 1), new Date(year, 5, 30))
    : span(new Date(year, 6, 1), new Date(year, 11, 31));
}

function yearPartRange(year, part) {
  return part === "start"
    ? span(new Date(year, 0, 1), new Date(year, 2, 31))
    : span(new Date(year, 9, 1), new Date(year, 11, 31));
}

function chooseYearExpr(ref) {
  if (rand() < 0.45) {
    const yearWord = pick(YEAR_WORDS);
    return { text: yearWord.label, year: ref.getFullYear() + yearWord.offset };
  }
  const year = int(ref.getFullYear() - 1, ref.getFullYear() + 2);
  return { text: `${year}년`, year };
}

function genNamedDay(ref) {
  const token = pick([
    { text: "그저께", offset: -2 },
    { text: "어제", offset: -1 },
    { text: "오늘", offset: 0 },
    { text: "내일", offset: 1 },
    { text: "모레", offset: 2 },
  ]);
  return {
    category: "named_day",
    referenceDate: fmt(ref),
    text: wrap(token.text),
    expected: sameDay(addDays(ref, token.offset)),
  };
}

function genRelativeDay(ref) {
  const amount = int(1, 45);
  const direction = pick([
    { text: "전", sign: -1 },
    { text: "후", sign: 1 },
    { text: "뒤", sign: 1 },
  ]);
  return {
    category: "relative_day",
    referenceDate: fmt(ref),
    text: wrap(`${amount}일 ${direction.text}`),
    expected: sameDay(addDays(ref, direction.sign * amount)),
  };
}

function genRelativeWeek(ref) {
  const amount = int(1, 16);
  const direction = pick([
    { text: "전", sign: -1 },
    { text: "후", sign: 1 },
    { text: "뒤", sign: 1 },
  ]);
  return {
    category: "relative_week",
    referenceDate: fmt(ref),
    text: wrap(`${amount}주 ${direction.text}`),
    expected: sameDay(addWeeks(ref, direction.sign * amount)),
  };
}

function genRelativeMonth(ref) {
  const amount = int(1, 18);
  const direction = pick([
    { text: "전", sign: -1 },
    { text: "후", sign: 1 },
    { text: "뒤", sign: 1 },
  ]);
  return {
    category: "relative_month",
    referenceDate: fmt(ref),
    text: wrap(`${amount}개월 ${direction.text}`),
    expected: sameDay(addMonths(ref, direction.sign * amount)),
  };
}

function genRelativeYear(ref) {
  const amount = int(1, 4);
  const direction = pick([
    { text: "전", sign: -1 },
    { text: "후", sign: 1 },
    { text: "뒤", sign: 1 },
  ]);
  return {
    category: "relative_year",
    referenceDate: fmt(ref),
    text: wrap(`${amount}년 ${direction.text}`),
    expected: sameDay(addYears(ref, direction.sign * amount)),
  };
}

function genWeekWeekday(ref) {
  const modifier = pick([
    { text: "지난 주", offset: -1 },
    { text: "지난주", offset: -1 },
    { text: "전주", offset: -1 },
    { text: "이번 주", offset: 0 },
    { text: "이번주", offset: 0 },
    { text: "금주", offset: 0 },
    { text: "다음 주", offset: 1 },
    { text: "다음주", offset: 1 },
    { text: "차주", offset: 1 },
    { text: "다다음 주", offset: 2 },
    { text: "다다음주", offset: 2 },
  ]);
  const weekday = pick(WEEKDAYS);
  const weekRef = addWeeks(ref, modifier.offset);
  const weekStart = startOfWeek(weekRef, { weekStartsOn: 1 });
  const date = addDays(weekStart, weekdayDeltaFromMondayStart(weekday.js));
  return {
    category: "week_weekday",
    referenceDate: fmt(ref),
    text: wrap(`${modifier.text} ${weekday.label}`),
    expected: sameDay(date),
  };
}

function genUpcomingWeekday(ref) {
  const weekday = pick(WEEKDAYS.filter((item) => item.js !== ref.getDay()));
  let delta = (weekday.js - ref.getDay() + 7) % 7;
  if (delta === 0) delta = 7;
  return {
    category: "upcoming_weekday",
    referenceDate: fmt(ref),
    text: wrap(`${pick(["오는", "다가오는"])} ${weekday.label}`),
    expected: sameDay(addDays(ref, delta)),
  };
}

function genWeekend(ref) {
  const modifier = pick([
    { text: "지난 주말", offset: -1 },
    { text: "지난주말", offset: -1 },
    { text: "이번 주말", offset: 0 },
    { text: "이번주말", offset: 0 },
    { text: "다음 주말", offset: 1 },
    { text: "다음주말", offset: 1 },
  ]);
  const weekStart = startOfWeek(addWeeks(ref, modifier.offset), { weekStartsOn: 1 });
  return {
    category: "weekend",
    referenceDate: fmt(ref),
    text: wrap(modifier.text),
    expected: span(addDays(weekStart, 5), addDays(weekStart, 6)),
  };
}

function genExplicitDate(ref) {
  const year = int(ref.getFullYear() - 1, ref.getFullYear() + 2);
  const month = int(1, 12);
  const day = int(1, daysInMonth(year, month));
  const expr = pick([
    `${year}년 ${month}월 ${day}일`,
    `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`,
    `${year}/${String(month).padStart(2, "0")}/${String(day).padStart(2, "0")}`,
    `${year}.${String(month).padStart(2, "0")}.${String(day).padStart(2, "0")}`,
  ]);
  return {
    category: "explicit_date",
    referenceDate: fmt(ref),
    text: wrap(expr),
    expected: sameDay(new Date(year, month - 1, day)),
  };
}

function genYearlessDate(ref) {
  const month = int(1, 12);
  const day = int(1, daysInMonth(ref.getFullYear(), month));
  const year = resolvePastYear(ref, month, day);
  const expr = pick([`${month}월 ${day}일`, `${month}/${day}`]);
  return {
    category: "yearless_date",
    referenceDate: fmt(ref),
    text: wrap(expr),
    expected: sameDay(new Date(year, month - 1, day)),
  };
}

function genMonthOnly(ref) {
  const mode = rand();
  const month = int(1, 12);
  let expr = "";
  let year = ref.getFullYear();
  if (mode < 0.34) {
    year = resolvePastYear(ref, month, 1);
    expr = `${month}월`;
  } else if (mode < 0.67) {
    const yearExpr = chooseYearExpr(ref);
    year = yearExpr.year;
    expr = `${yearExpr.text} ${month}월`;
  } else {
    year = int(ref.getFullYear() - 1, ref.getFullYear() + 2);
    expr = `${year}년 ${month}월`;
  }
  return {
    category: "month_only",
    referenceDate: fmt(ref),
    text: wrap(expr),
    expected: span(new Date(year, month - 1, 1), endOfMonth(new Date(year, month - 1, 1))),
  };
}

function genMonthPart(ref) {
  const part = pick([
    { text: "초", start: 1, end: 10 },
    { text: "중순", start: 11, end: 20 },
    { text: "말", start: 21, end: 31 },
  ]);
  const month = int(1, 12);
  let expr = "";
  let year = ref.getFullYear();
  if (rand() < 0.5) {
    year = resolvePastYear(ref, month, 1);
    expr = `${month}월 ${part.text}`;
  } else {
    const yearExpr = chooseYearExpr(ref);
    year = yearExpr.year;
    expr = `${yearExpr.text} ${month}월 ${part.text}`;
  }
  const last = daysInMonth(year, month);
  return {
    category: "month_part",
    referenceDate: fmt(ref),
    text: wrap(expr),
    expected: span(new Date(year, month - 1, part.start), new Date(year, month - 1, Math.min(part.end, last))),
  };
}

function genYearOnly(ref) {
  let expr = "";
  let year = ref.getFullYear();
  if (rand() < 0.5) {
    const yearWord = pick(YEAR_WORDS);
    year = ref.getFullYear() + yearWord.offset;
    expr = yearWord.label;
  } else {
    year = int(ref.getFullYear() - 1, ref.getFullYear() + 2);
    expr = `${year}년`;
  }
  return {
    category: "year_only",
    referenceDate: fmt(ref),
    text: wrap(expr),
    expected: span(startOfYear(new Date(year, 0, 1)), endOfYear(new Date(year, 0, 1))),
  };
}

function genQuarter(ref) {
  const quarter = pick([1, 2, 3, 4]);
  const yearExpr = chooseYearExpr(ref);
  return {
    category: "quarter",
    referenceDate: fmt(ref),
    text: wrap(`${yearExpr.text} ${quarter}분기`),
    expected: quarterRange(yearExpr.year, quarter),
  };
}

function genRelativeQuarter(ref) {
  const relative = pick([
    { text: "지난 분기", offset: -1 },
    { text: "이번 분기", offset: 0 },
    { text: "다음 분기", offset: 1 },
  ]);
  const shifted = addQuarters(ref, relative.offset);
  const start = startOfQuarter(shifted);
  return {
    category: "relative_quarter",
    referenceDate: fmt(ref),
    text: wrap(relative.text),
    expected: span(start, endOfQuarter(start)),
  };
}

function genHalf(ref) {
  const half = pick([1, 2]);
  const label = half === 1 ? "상반기" : "하반기";
  const yearExpr = chooseYearExpr(ref);
  return {
    category: "half",
    referenceDate: fmt(ref),
    text: wrap(`${yearExpr.text} ${label}`),
    expected: halfRange(yearExpr.year, half),
  };
}

function genYearPart(ref) {
  const part = pick([
    { text: "초", key: "start" },
    { text: "말", key: "end" },
  ]);
  if (rand() < 0.3) {
    const expr = part.key === "start" ? "연초" : "연말";
    return {
      category: "year_part",
      referenceDate: fmt(ref),
      text: wrap(expr),
      expected: yearPartRange(ref.getFullYear(), part.key),
    };
  }
  const yearWord = pick(YEAR_WORDS);
  const year = ref.getFullYear() + yearWord.offset;
  return {
    category: "year_part",
    referenceDate: fmt(ref),
    text: wrap(`${yearWord.label} ${part.text}`),
    expected: yearPartRange(year, part.key),
  };
}

function genExplicitRange(ref) {
  const startYear = int(ref.getFullYear() - 1, ref.getFullYear() + 1);
  const startMonth = int(1, 12);
  const startDay = int(1, daysInMonth(startYear, startMonth));
  const start = new Date(startYear, startMonth - 1, startDay);
  const end = addDays(start, int(1, 14));
  return {
    category: "explicit_range",
    referenceDate: fmt(ref),
    text: wrap(
      `${start.getFullYear()}년 ${start.getMonth() + 1}월 ${start.getDate()}일부터 ` +
        `${end.getFullYear()}년 ${end.getMonth() + 1}월 ${end.getDate()}일까지`,
    ),
    expected: span(start, end),
  };
}

function genYearlessRange(ref) {
  const month = int(1, 12);
  const year = resolvePastYear(ref, month, 1);
  const maxDay = Math.min(daysInMonth(year, month), 26);
  const startDay = int(1, Math.max(1, maxDay - 3));
  const endDay = int(startDay + 1, Math.min(startDay + 5, daysInMonth(year, month)));
  return {
    category: "yearless_range",
    referenceDate: fmt(ref),
    text: wrap(`${month}월 ${startDay}일부터 ${endDay}일까지`),
    expected: span(new Date(year, month - 1, startDay), new Date(year, month - 1, endDay)),
  };
}

const generators = [
  genNamedDay,
  genRelativeDay,
  genRelativeWeek,
  genRelativeMonth,
  genRelativeYear,
  genWeekWeekday,
  genUpcomingWeekday,
  genWeekend,
  genExplicitDate,
  genYearlessDate,
  genMonthOnly,
  genMonthPart,
  genYearOnly,
  genQuarter,
  genRelativeQuarter,
  genHalf,
  genYearPart,
  genExplicitRange,
  genYearlessRange,
];

const target = 300;
const tests = [];
const seen = new Set();

while (tests.length < target) {
  const ref = pick(REFS);
  const test = pick(generators)(ref);
  const dedupeKey = `${test.referenceDate}||${test.text}`;
  if (seen.has(dedupeKey)) continue;
  seen.add(dedupeKey);
  tests.push(test);
}

const failures = [];
const categoryStats = new Map();
let exact = 0;
let any = 0;

for (const test of tests) {
  const response = await extract({
    text: test.text,
    referenceDate: test.referenceDate,
    timezone: "Asia/Seoul",
    outputModes: ["range"],
  });

  const predicted = response.expressions
    .flatMap((expr) => expr.results)
    .filter((result) => result.mode === "range")
    .map((result) => result.value);

  const anyMatch = predicted.some(
    (value) => value.start === test.expected.start && value.end === test.expected.end,
  );
  const isExact = predicted.length === 1 && anyMatch;

  const stat = categoryStats.get(test.category) ?? { total: 0, exact: 0, any: 0 };
  stat.total += 1;
  if (anyMatch) stat.any += 1;
  if (isExact) stat.exact += 1;
  categoryStats.set(test.category, stat);

  if (anyMatch) any += 1;
  if (isExact) {
    exact += 1;
    continue;
  }

  failures.push({
    category: test.category,
    referenceDate: test.referenceDate,
    text: test.text,
    expected: test.expected,
    predicted,
    kind: anyMatch ? "match_with_extras" : predicted.length === 0 ? "miss" : "wrong",
  });
}

const categorySummary = [...categoryStats.entries()]
  .map(([category, stat]) => ({
    category,
    total: stat.total,
    exact: stat.exact,
    exactAccuracy: Number(((stat.exact / stat.total) * 100).toFixed(1)),
    anyAccuracy: Number(((stat.any / stat.total) * 100).toFixed(1)),
  }))
  .sort((left, right) => left.exactAccuracy - right.exactAccuracy || left.category.localeCompare(right.category));

console.log(
  JSON.stringify(
    {
      seed,
      total: tests.length,
      exact,
      exactAccuracy: Number(((exact / tests.length) * 100).toFixed(2)),
      any,
      anyAccuracy: Number(((any / tests.length) * 100).toFixed(2)),
      categorySummary,
      sampleFailures: failures.slice(0, 20),
    },
    null,
    2,
  ),
);
