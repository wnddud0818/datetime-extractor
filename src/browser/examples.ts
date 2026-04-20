import type { OutputMode } from "../types.js";

export interface BrowserExample {
  label: string;
  text: string;
  modes: OutputMode[];
  disabled?: boolean;
  disabledReason?: string;
}

export const browserExamples: BrowserExample[] = [
  { label: "Last month", text: "last month sales", modes: ["range"] },
  { label: "Tomorrow 3pm", text: "tomorrow 3pm meeting", modes: ["datetime"] },
  { label: "Next month business days", text: "next month business days", modes: ["business_days"] },
  { label: "Q2 2025", text: "Q2 2025 revenue", modes: ["range"] },
  { label: "Past 30 days", text: "past 30 days", modes: ["range"] },
  { label: "Day after tomorrow", text: "day after tomorrow appointment", modes: ["single"] },
  {
    label: "Complex phrase (LLM disabled)",
    text: "3 months before for the next half-month weekdays",
    modes: ["weekdays"],
    disabled: true,
    disabledReason: "This example previously relied on LLM fallback and is intentionally disabled here.",
  },
];
