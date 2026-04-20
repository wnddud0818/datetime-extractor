import { describe, expect, it } from "vitest";
import { extract } from "../src/index.js";
import { runRules } from "../src/rules/engine.js";

describe("range connectors", () => {
  it("10월부터 12월까지 → month range", async () => {
    const parsed = runRules("10월부터 12월까지");
    expect(parsed.confidence).toBe(1.0);
    expect(parsed.expressions).toEqual([
      {
        text: "10월부터 12월까지",
        expression: {
          kind: "range",
          start: { kind: "absolute", month: 10 },
          end: { kind: "absolute", month: 12 },
        },
      },
    ]);

    const result = await extract({
      text: "10월부터 12월까지",
      referenceDate: "2026-04-20",
      outputModes: ["range"],
    });
    expect(result.hasDate).toBe(true);
    expect(result.expressions[0].results).toEqual([
      {
        mode: "range",
        value: { start: "2025-10-01", end: "2025-12-31" },
      },
    ]);

    const edgeRefResult = await extract({
      text: "10월부터 12월까지",
      referenceDate: "2025-11-17",
      outputModes: ["range"],
    });
    expect(edgeRefResult.expressions[0].results).toEqual([
      {
        mode: "range",
        value: { start: "2025-10-01", end: "2025-12-31" },
      },
    ]);
  });

  it("이번주 월요일부터 금요일까지 → same-week weekday range", async () => {
    const parsed = runRules("이번주 월요일부터 금요일까지");
    expect(parsed.confidence).toBe(1.0);
    expect(parsed.expressions).toEqual([
      {
        text: "이번주 월요일부터 금요일까지",
        expression: {
          kind: "range",
          start: { kind: "weekday_in_week", weekOffset: 0, weekday: 1 },
          end: { kind: "weekday_in_week", weekOffset: 0, weekday: 5 },
        },
      },
    ]);

    const result = await extract({
      text: "이번주 월요일부터 금요일까지",
      referenceDate: "2026-04-20",
      outputModes: ["range"],
    });
    expect(result.hasDate).toBe(true);
    expect(result.expressions[0].results).toEqual([
      {
        mode: "range",
        value: { start: "2026-04-20", end: "2026-04-24" },
      },
    ]);
  });

  it("오늘부터 다음주까지 → relative period range", async () => {
    const parsed = runRules("오늘부터 다음주까지");
    expect(parsed.confidence).toBe(1.0);
    expect(parsed.expressions).toEqual([
      {
        text: "오늘부터 다음주까지",
        expression: {
          kind: "range",
          start: { kind: "named", name: "today" },
          end: { kind: "relative", unit: "week", offset: 1 },
        },
      },
    ]);

    const result = await extract({
      text: "오늘부터 다음주까지",
      referenceDate: "2026-04-20",
      outputModes: ["range"],
    });
    expect(result.hasDate).toBe(true);
    expect(result.expressions[0].results).toEqual([
      {
        mode: "range",
        value: { start: "2026-04-20", end: "2026-05-03" },
      },
    ]);
  });

  it("1월부터 3월까지 → quarter-like month span", async () => {
    const parsed = runRules("1월부터 3월까지");
    expect(parsed.confidence).toBe(1.0);
    expect(parsed.expressions).toEqual([
      {
        text: "1월부터 3월까지",
        expression: {
          kind: "range",
          start: { kind: "absolute", month: 1 },
          end: { kind: "absolute", month: 3 },
        },
      },
    ]);

    const result = await extract({
      text: "1월부터 3월까지",
      referenceDate: "2026-04-20",
      outputModes: ["range"],
    });
    expect(result.hasDate).toBe(true);
    expect(result.expressions[0].results).toEqual([
      {
        mode: "range",
        value: { start: "2026-01-01", end: "2026-03-31" },
      },
    ]);

    const edgeRefResult = await extract({
      text: "1월부터 3월까지",
      referenceDate: "2025-01-10",
      outputModes: ["range"],
    });
    expect(edgeRefResult.expressions[0].results).toEqual([
      {
        mode: "range",
        value: { start: "2025-01-01", end: "2025-03-31" },
      },
    ]);
  });

  it("explicit symbolic day ranges → merge into a single range", async () => {
    const cases = [
      {
        text: "2025-04-12 ~ 2025-05-15",
        expectedText: "2025-04-12 ~ 2025-05-15",
        expected: { start: "2025-04-12", end: "2025-05-15" },
      },
      {
        text: "2025-04-12~2025-05-15",
        expectedText: "2025-04-12~2025-05-15",
        expected: { start: "2025-04-12", end: "2025-05-15" },
      },
      {
        text: "2025/04/12 ~ 2025/05/15",
        expectedText: "2025/04/12 ~ 2025/05/15",
        expected: { start: "2025-04-12", end: "2025-05-15" },
      },
      {
        text: "2025.04.12 ~ 2025.05.15",
        expectedText: "2025.04.12 ~ 2025.05.15",
        expected: { start: "2025-04-12", end: "2025-05-15" },
      },
      {
        text: "20250412~20250515",
        expectedText: "20250412~20250515",
        expected: { start: "2025-04-12", end: "2025-05-15" },
      },
      {
        text: "25-04-12 ~ 25-05-15",
        expectedText: "25-04-12 ~ 25-05-15",
        expected: { start: "2025-04-12", end: "2025-05-15" },
      },
    ] as const;

    for (const { text, expectedText, expected } of cases) {
      const parsed = runRules(text);
      expect(parsed.confidence).toBe(1.0);
      expect(parsed.residualText).toBe("");
      expect(parsed.expressions).toEqual([
        {
          text: expectedText,
          expression: {
            kind: "range",
            start: {
              kind: "absolute",
              year: Number(expected.start.slice(0, 4)),
              month: Number(expected.start.slice(5, 7)),
              day: Number(expected.start.slice(8, 10)),
            },
            end: {
              kind: "absolute",
              year: Number(expected.end.slice(0, 4)),
              month: Number(expected.end.slice(5, 7)),
              day: Number(expected.end.slice(8, 10)),
            },
          },
        },
      ]);

      const result = await extract({
        text,
        referenceDate: "2026-04-20",
        outputModes: ["range"],
      });
      expect(result.hasDate).toBe(true);
      expect(result.expressions[0].results).toEqual([
        {
          mode: "range",
          value: expected,
        },
      ]);
    }
  });

  it("1~2월 → shorthand month range", async () => {
    const parsed = runRules("1~2월 거래내역 알려줘");
    expect(parsed.confidence).toBe(1.0);
    expect(parsed.expressions).toEqual([
      {
        text: "1~2월",
        expression: {
          kind: "range",
          start: { kind: "absolute", month: 1 },
          end: { kind: "absolute", month: 2 },
        },
      },
    ]);

    const result = await extract({
      text: "1~2월 거래내역 알려줘",
      referenceDate: "2026-04-20",
      outputModes: ["range"],
    });
    expect(result.hasDate).toBe(true);
    expect(result.expressions[0].results).toEqual([
      {
        mode: "range",
        value: { start: "2026-01-01", end: "2026-02-28" },
      },
    ]);
  });

  it("작년 1~2월 → year-prefixed shorthand month range", async () => {
    const text = "작년 1~2월 거래내역 알려줘";
    const parsed = runRules(text);
    expect(parsed.confidence).toBe(1.0);
    expect(parsed.expressions).toEqual([
      {
        text: "작년 1~2월",
        expression: {
          kind: "range",
          start: { kind: "absolute", yearOffset: -1, month: 1 },
          end: { kind: "absolute", yearOffset: -1, month: 2 },
        },
      },
    ]);

    const result = await extract({
      text,
      referenceDate: "2026-04-20",
      outputModes: ["range"],
    });
    expect(result.hasDate).toBe(true);
    expect(result.expressions[0].results).toEqual([
      {
        mode: "range",
        value: { start: "2025-01-01", end: "2025-02-28" },
      },
    ]);
  });

  it("지난 1~2월 → colloquial shorthand month range", async () => {
    const text = "지난 1~2월 거래내역 알려줘";
    const parsed = runRules(text);
    expect(parsed.confidence).toBe(1.0);
    expect(parsed.expressions).toEqual([
      {
        text: "지난 1~2월",
        expression: {
          kind: "range",
          start: { kind: "absolute", month: 1 },
          end: { kind: "absolute", month: 2 },
        },
      },
    ]);

    const result = await extract({
      text,
      referenceDate: "2026-04-20",
      outputModes: ["range"],
    });
    expect(result.hasDate).toBe(true);
    expect(result.expressions[0].results).toEqual([
      {
        mode: "range",
        value: { start: "2026-01-01", end: "2026-02-28" },
      },
    ]);
  });

  it("연도 prefix가 붙은 1월부터 3월까지 → 같은 연도 범위로 고정", async () => {
    const cases = [
      "작년 1월부터 3월까지",
      "지난해 1월부터 3월까지",
      "전년 1월부터 3월까지",
      "지난년도 1월부터 3월까지",
    ];

    for (const text of cases) {
      const parsed = runRules(text);
      expect(parsed.confidence).toBe(1.0);
      expect(parsed.expressions).toEqual([
        {
          text,
          expression: {
            kind: "range",
            start: { kind: "absolute", yearOffset: -1, month: 1 },
            end: { kind: "absolute", yearOffset: -1, month: 3 },
          },
        },
      ]);

      const result = await extract({
        text,
        referenceDate: "2026-04-20",
        outputModes: ["range"],
      });
      expect(result.hasDate).toBe(true);
      expect(result.expressions[0].results).toEqual([
        {
          mode: "range",
          value: { start: "2025-01-01", end: "2025-03-31" },
        },
      ]);
    }
  });

  it("23년 4월부터 8월까지 → 2자리 연도 월 범위", async () => {
    const parsed = runRules("23년 4월부터 8월까지");
    expect(parsed.confidence).toBe(1.0);
    expect(parsed.expressions).toEqual([
      {
        text: "23년 4월부터 8월까지",
        expression: {
          kind: "range",
          start: { kind: "absolute", year: 2023, month: 4 },
          end: { kind: "absolute", year: 2023, month: 8 },
        },
      },
    ]);

    const result = await extract({
      text: "23년 4월부터 8월까지",
      referenceDate: "2026-04-20",
      outputModes: ["range"],
    });
    expect(result.hasDate).toBe(true);
    expect(result.expressions[0].results).toEqual([
      {
        mode: "range",
        value: { start: "2023-04-01", end: "2023-08-31" },
      },
    ]);
  });

  it("시작 월부터 N개월간도 calendar month range로 병합", async () => {
    const cases = [
      {
        text: "23년 4월부터 3개월간",
        expression: {
          kind: "range" as const,
          start: { kind: "absolute" as const, year: 2023, month: 4 },
          duration: { unit: "month" as const, amount: 3 },
        },
        expected: { start: "2023-04-01", end: "2023-06-30" },
      },
      {
        text: "작년 4월부터 한 달간",
        expression: {
          kind: "range" as const,
          start: { kind: "absolute" as const, yearOffset: -1, month: 4 },
          duration: { unit: "month" as const, amount: 1 },
        },
        expected: { start: "2025-04-01", end: "2025-04-30" },
      },
      {
        text: "2023년 4월 15일부터 3개월간",
        expression: {
          kind: "range" as const,
          start: { kind: "absolute" as const, year: 2023, month: 4, day: 15 },
          duration: { unit: "month" as const, amount: 3 },
        },
        expected: { start: "2023-04-15", end: "2023-07-14" },
      },
    ];

    for (const { text, expression, expected } of cases) {
      const parsed = runRules(text);
      expect(parsed.confidence).toBe(1.0);
      expect(parsed.expressions).toEqual([{ text, expression }]);

      const result = await extract({
        text,
        referenceDate: "2026-04-20",
        outputModes: ["range"],
      });
      expect(result.hasDate).toBe(true);
      expect(result.expressions[0].results).toEqual([
        {
          mode: "range",
          value: expected,
        },
      ]);
    }
  });
});
