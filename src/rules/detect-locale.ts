/**
 * 입력 텍스트의 locale을 감지.
 * Hangul 음절 블록(U+AC00~U+D7AF)이 하나라도 있으면 한국어로 판정.
 * 혼합 입력은 한국어 지배 (프로젝트 컨텍스트상 한국어 비중이 높음).
 */
export function detectLocale(text: string): "ko" | "en" {
  return /[\uAC00-\uD7AF]/.test(text) ? "ko" : "en";
}
