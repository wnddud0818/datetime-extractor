import { extract, cacheClear } from "../src/index.js";

const queries = [
  "저번 달 잔액 알려줘",
  "3월 4월 잔액 알려줘",
  "사흘 전 날씨",
  "저번달 영업일",
  "이번 달 평일",
  "작년 공휴일",
  "어제 매출",
  "오늘 일정",
  "내일 날씨",
  "그저께 있었던 일",
  "보름 전",
  "7일 전",
  "2025-12-25 잔액",
  "2025년 3월 1일",
  "작년 매출",
  "올해 실적",
  "지난주 일정",
  "이번 주 일정",
  "last month sales",
  "what was the balance yesterday",
];

function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

async function bench(label: string, iterations: number, fn: () => Promise<number>) {
  const samples: number[] = [];
  // warm-up
  for (let i = 0; i < 3; i++) await fn();
  for (let i = 0; i < iterations; i++) {
    samples.push(await fn());
  }
  const p50 = percentile(samples, 50);
  const p95 = percentile(samples, 95);
  const avg = samples.reduce((a, b) => a + b, 0) / samples.length;
  console.log(
    `  ${label.padEnd(22)} p50=${p50.toFixed(2)}ms  p95=${p95.toFixed(2)}ms  avg=${avg.toFixed(2)}ms  (n=${iterations})`,
  );
}

async function main() {
  console.log("datetime-extractor 벤치마크");
  console.log("reference: 2026-04-17, timezone: Asia/Seoul\n");

  console.log("[룰 경로 (LLM 미경유)]");
  for (const q of queries.slice(0, 6)) {
    cacheClear();
    await bench(
      q.slice(0, 20),
      20,
      async () => {
        const t0 = performance.now();
        await extract({
          text: q,
          referenceDate: "2026-04-17",
          outputModes: ["range", "single", "business_days", "weekdays", "holidays"],
        });
        return performance.now() - t0;
      },
    );
  }

  console.log("\n[캐시 hit]");
  const q = queries[0];
  await extract({ text: q, referenceDate: "2026-04-17", outputModes: ["range"] });
  await bench(
    "cache hit",
    1000,
    async () => {
      const t0 = performance.now();
      await extract({
        text: q,
        referenceDate: "2026-04-17",
        outputModes: ["range"],
      });
      return performance.now() - t0;
    },
  );

  console.log("\n[종합 통계]");
  cacheClear();
  const all: number[] = [];
  for (const q of queries) {
    const t0 = performance.now();
    await extract({
      text: q,
      referenceDate: "2026-04-17",
      outputModes: ["range", "single"],
    });
    all.push(performance.now() - t0);
  }
  console.log(
    `  전체 쿼리(n=${queries.length}) p50=${percentile(all, 50).toFixed(2)}ms  p95=${percentile(all, 95).toFixed(2)}ms`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
