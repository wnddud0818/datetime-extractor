import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { extract, cacheClear } from "../src/index.js";
import type { OutputMode } from "../src/types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

interface GoldenCase {
  id: string;
  text: string;
  referenceDate: string;
  outputModes: OutputMode[];
  expected: {
    hasDate: boolean;
    expressions: Array<{
      single?: string;
      range?: { start: string; end: string };
      list?: string[];
      business_days?: string[];
      business_days_include?: string[];
      business_days_exclude?: string[];
      business_days_count_min?: number;
      weekdays_count_min?: number;
      holidays_include?: string[];
    }>;
  };
}

const golden: GoldenCase[] = JSON.parse(
  fs.readFileSync(path.join(__dirname, "fixtures", "golden.json"), "utf-8"),
);

// 룰 엔진으로 커버 가능한 케이스만 본 테스트에서 검증.
// LLM 필요 케이스는 이 파일에서 id 배열로 스킵한다.
const LLM_ONLY_IDS = new Set<string>([
  // "오늘의 운세 말고 다른 거" → LLM만 적용될 수 있음 (현재는 룰로 '오늘' 감지)
]);

describe("golden dataset (rule-path end-to-end)", () => {
  for (const c of golden) {
    if (LLM_ONLY_IDS.has(c.id)) continue;
    it(`${c.id}: ${c.text}`, async () => {
      cacheClear();
      const res = await extract({
        text: c.text,
        referenceDate: c.referenceDate,
        outputModes: c.outputModes,
      });
      expect(res.hasDate).toBe(c.expected.hasDate);
      if (!c.expected.hasDate) return;

      expect(res.expressions).toHaveLength(c.expected.expressions.length);

      for (let i = 0; i < c.expected.expressions.length; i++) {
        const exp = c.expected.expressions[i];
        const actual = res.expressions[i];

        if (exp.single) {
          const single = actual.results.find((r) => r.mode === "single");
          expect(single?.value).toBe(exp.single);
        }
        if (exp.range) {
          const range = actual.results.find((r) => r.mode === "range");
          expect(range?.value).toEqual(exp.range);
        }
        if (exp.business_days_include) {
          const bd = actual.results.find((r) => r.mode === "business_days");
          expect(bd?.mode).toBe("business_days");
          if (bd?.mode === "business_days") {
            for (const d of exp.business_days_include) {
              expect(bd.value).toContain(d);
            }
          }
        }
        if (exp.business_days_exclude) {
          const bd = actual.results.find((r) => r.mode === "business_days");
          if (bd?.mode === "business_days") {
            for (const d of exp.business_days_exclude) {
              expect(bd.value).not.toContain(d);
            }
          }
        }
        if (exp.business_days_count_min !== undefined) {
          const bd = actual.results.find((r) => r.mode === "business_days");
          if (bd?.mode === "business_days") {
            expect(bd.value.length).toBeGreaterThanOrEqual(
              exp.business_days_count_min,
            );
          }
        }
        if (exp.weekdays_count_min !== undefined) {
          const wd = actual.results.find((r) => r.mode === "weekdays");
          if (wd?.mode === "weekdays") {
            expect(wd.value.length).toBeGreaterThanOrEqual(
              exp.weekdays_count_min,
            );
          }
        }
        if (exp.holidays_include) {
          const h = actual.results.find((r) => r.mode === "holidays");
          if (h?.mode === "holidays") {
            for (const d of exp.holidays_include) {
              expect(h.value).toContain(d);
            }
          }
        }
      }
    });
  }

  it("path meta 반영 (룰 경로)", async () => {
    cacheClear();
    const r = await extract({
      text: "사흘 전",
      referenceDate: "2026-04-17",
      outputModes: ["single"],
    });
    expect(r.meta.path).toBe("rule");
    expect(r.meta.model).toBe("rules");
  });

  it("캐시 hit 동작", async () => {
    cacheClear();
    const req = {
      text: "어제",
      referenceDate: "2026-04-17",
      outputModes: ["single"] as OutputMode[],
    };
    await extract(req);
    const second = await extract(req);
    expect(second.meta.path).toBe("cache");
    expect(second.meta.latencyMs).toBeLessThan(20);
  });
});
