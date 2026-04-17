import type { NamedToken } from "../types.js";

// 방향성 없는 토큰: 기준일 기준의 고정 offset
// 방향성 있는 토큰(사흘, 나흘 등): 절대값. direction에 따라 +/-
const BASE: Record<NamedToken, number> = {
  today: 0,
  yesterday: -1,
  tomorrow: 1,
  그저께: -2,
  엊그제: -2,
  모레: 2,
  글피: 3,
  그글피: 4,
  하루: 1,
  이틀: 2,
  사흘: 3,
  나흘: 4,
  닷새: 5,
  엿새: 6,
  이레: 7,
  여드레: 8,
  아흐레: 9,
  열흘: 10,
  보름: 15,
};

export const KOREAN_NUMERAL_OFFSETS = BASE;

const DIRECTIONAL: ReadonlySet<NamedToken> = new Set([
  "하루",
  "이틀",
  "사흘",
  "나흘",
  "닷새",
  "엿새",
  "이레",
  "여드레",
  "아흐레",
  "열흘",
  "보름",
]);

export function isDirectionalNumeral(name: NamedToken): boolean {
  return DIRECTIONAL.has(name);
}
