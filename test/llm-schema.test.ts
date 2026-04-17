import { describe, it, expect } from "vitest";
import { llmOutputSchema } from "../src/extractor/schema.js";

/**
 * LLM 출력 스키마 검증 (Ollama 없이도 통과).
 * 실제 LLM이 뱉을 법한 응답 형태를 Zod 스키마로 파싱.
 */

describe("LLM output schema", () => {
  it("빈 배열 (날짜 없음) → valid", () => {
    const r = llmOutputSchema.safeParse({ expressions: [] });
    expect(r.success).toBe(true);
  });

  it("absolute 단일 → valid", () => {
    const r = llmOutputSchema.safeParse({
      expressions: [
        {
          text: "2025-12-25",
          expression: { kind: "absolute", year: 2025, month: 12, day: 25 },
          confidence: 1.0,
        },
      ],
    });
    expect(r.success).toBe(true);
  });

  it("relative month offset=-1 → valid", () => {
    const r = llmOutputSchema.safeParse({
      expressions: [
        {
          text: "저번 달",
          expression: { kind: "relative", unit: "month", offset: -1 },
        },
      ],
    });
    expect(r.success).toBe(true);
  });

  it("filter + relative 결합 → valid", () => {
    const r = llmOutputSchema.safeParse({
      expressions: [
        {
          text: "작년 공휴일",
          expression: {
            kind: "filter",
            base: { kind: "relative", unit: "year", offset: -1 },
            filter: "holidays",
          },
        },
      ],
    });
    expect(r.success).toBe(true);
  });

  it("named 한국어 수사 → valid", () => {
    const r = llmOutputSchema.safeParse({
      expressions: [
        {
          text: "사흘 전",
          expression: { kind: "named", name: "사흘", direction: "past" },
        },
      ],
    });
    expect(r.success).toBe(true);
  });

  it("중첩 range (relative ~ named) → valid", () => {
    const r = llmOutputSchema.safeParse({
      expressions: [
        {
          text: "3개월 전부터 보름 동안",
          expression: {
            kind: "range",
            start: { kind: "relative", unit: "month", offset: -3 },
            end: { kind: "named", name: "보름", direction: "future" },
          },
        },
      ],
    });
    expect(r.success).toBe(true);
  });

  it("잘못된 filter → invalid", () => {
    const r = llmOutputSchema.safeParse({
      expressions: [
        {
          text: "x",
          expression: {
            kind: "filter",
            base: { kind: "relative", unit: "month", offset: 0 },
            filter: "invalid_filter",
          },
        },
      ],
    });
    expect(r.success).toBe(false);
  });

  it("잘못된 unit → invalid", () => {
    const r = llmOutputSchema.safeParse({
      expressions: [
        {
          text: "x",
          expression: { kind: "relative", unit: "century", offset: 0 },
        },
      ],
    });
    expect(r.success).toBe(false);
  });

  it("필수 필드 누락 (expressions 없음) → invalid", () => {
    const r = llmOutputSchema.safeParse({ hello: [] });
    expect(r.success).toBe(false);
  });

  it("복수 표현 (3월 4월) → valid", () => {
    const r = llmOutputSchema.safeParse({
      expressions: [
        { text: "3월", expression: { kind: "absolute", month: 3 } },
        { text: "4월", expression: { kind: "absolute", month: 4 } },
      ],
    });
    expect(r.success).toBe(true);
  });
});
