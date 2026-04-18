import type { NamedToken } from "../types.js";

export const KOREAN_DAY_NUMERALS: Array<{ word: string; token: NamedToken }> = [
  { word: "사흘", token: "사흘" },
  { word: "나흘", token: "나흘" },
  { word: "닷새", token: "닷새" },
  { word: "엿새", token: "엿새" },
  { word: "이레", token: "이레" },
  { word: "여드레", token: "여드레" },
  { word: "아흐레", token: "아흐레" },
  { word: "열흘", token: "열흘" },
  { word: "보름", token: "보름" },
  { word: "이틀", token: "이틀" },
  { word: "하루", token: "하루" },
];

export const KOREAN_DAY_WORDS: Array<{ word: string; token: NamedToken }> = [
  { word: "그저께", token: "그저께" },
  { word: "엊그제", token: "엊그제" },
  { word: "그제", token: "그저께" },
  { word: "어제", token: "yesterday" },
  { word: "오늘", token: "today" },
  { word: "내일", token: "tomorrow" },
  { word: "모레", token: "모레" },
  { word: "글피", token: "글피" },
  { word: "그글피", token: "그글피" },
];

export const ENGLISH_DAY_WORDS: Array<{ word: string; token: NamedToken }> = [
  { word: "yesterday", token: "yesterday" },
  { word: "today", token: "today" },
  { word: "tomorrow", token: "tomorrow" },
];

/**
 * 영어 구동 표현을 기존 한국어 NamedToken에 매핑.
 * 타입 변경 없이 의미만 재사용.
 */
export const ENGLISH_NAMED_ALIASES: Array<{ pattern: RegExp; token: NamedToken; direction?: "past" | "future" }> = [
  { pattern: /\bday\s+after\s+tomorrow\b/i, token: "모레" },
  { pattern: /\bday\s+before\s+yesterday\b/i, token: "그저께" },
  { pattern: /\bfortnight\s+ago\b/i, token: "보름", direction: "past" },
  { pattern: /\bfortnight\s+from\s+now\b/i, token: "보름", direction: "future" },
];

/**
 * 영어 월 이름 → 월 번호. 소문자 키.
 * 축약형(Jan, Feb...)과 전체형(January, February...) 모두 지원.
 */
export const MONTH_NAMES: Record<string, number> = {
  jan: 1, january: 1,
  feb: 2, february: 2,
  mar: 3, march: 3,
  apr: 4, april: 4,
  may: 5,
  jun: 6, june: 6,
  jul: 7, july: 7,
  aug: 8, august: 8,
  sep: 9, sept: 9, september: 9,
  oct: 10, october: 10,
  nov: 11, november: 11,
  dec: 12, december: 12,
};

/** 월 이름 정규식 alternation. 긴 이름을 먼저 시도. */
export const MONTH_NAME_ALT =
  "january|february|march|april|may|june|july|august|september|october|november|december|" +
  "jan|feb|mar|apr|jun|jul|aug|sept|sep|oct|nov|dec";

/** 영어 요일 이름 → JS getDay 값. */
export const ENGLISH_WEEKDAYS: Record<string, number> = {
  sun: 0, sunday: 0,
  mon: 1, monday: 1,
  tue: 2, tues: 2, tuesday: 2,
  wed: 3, wednes: 3, wednesday: 3,
  thu: 4, thur: 4, thurs: 4, thursday: 4,
  fri: 5, friday: 5,
  sat: 6, satur: 6, saturday: 6,
};

export const ENGLISH_WEEKDAY_ALT =
  "sunday|monday|tuesday|wednesday|thursday|friday|saturday|" +
  "sun|mon|tues|tue|wednes|wed|thurs|thur|thu|fri|satur|sat";
