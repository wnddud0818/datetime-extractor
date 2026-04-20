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
});
