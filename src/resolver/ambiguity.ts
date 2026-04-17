import type { DateExpression } from "../types.js";
import type { ResolveContext } from "./resolve.js";

/**
 * 모호 표현을 명확하게 해석한 DateExpression을 반환.
 * 현재 구현은 주로 "월 단독" (absolute with only month)의 연도 해석을 담당.
 */
export function resolveAmbiguity(
  expr: DateExpression,
  _ctx: ResolveContext,
): DateExpression {
  // 현재는 pass-through. 추후 "지난 3월" 같은 명시적 룰 추가 가능.
  return expr;
}
