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
