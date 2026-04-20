import type { OutputMode } from "../types.js";

export interface BrowserExample {
  label: string;
  text: string;
  modes: OutputMode[];
  disabled?: boolean;
  disabledReason?: string;
}

export const browserExamples: BrowserExample[] = [
  { label: "지난달 매출", text: "last month sales", modes: ["range"] },
  { label: "내일 오후 3시 회의", text: "tomorrow 3pm meeting", modes: ["datetime"] },
  { label: "다음 달 영업일", text: "next month business days", modes: ["business_days"] },
  { label: "2025년 2분기", text: "Q2 2025 revenue", modes: ["range"] },
  { label: "최근 30일", text: "past 30 days", modes: ["range"] },
  { label: "모레 일정", text: "day after tomorrow appointment", modes: ["single"] },
  {
    label: "복잡한 표현 예제",
    text: "3 months before for the next half-month weekdays",
    modes: ["weekdays"],
    disabled: true,
    disabledReason:
      "이 예제는 원래 LLM 폴백에 기대던 표현이라 정적 룰 전용 페이지에서는 비활성화되어 있습니다.",
  },
];
