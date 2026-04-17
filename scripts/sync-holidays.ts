import fs from "node:fs";
import path from "node:path";
import { fetchHolidaysFromAPI } from "../src/calendar/korean-holidays.js";

/**
 * 공공데이터포털 특일 API에서 최신 공휴일 데이터를 긁어와
 * src/calendar/holidays-fallback.json 에 병합한다.
 *
 * 사용법:
 *   HOLIDAY_API_KEY=xxx npx tsx scripts/sync-holidays.ts 2024 2030
 */
async function main() {
  const apiKey = process.env.HOLIDAY_API_KEY;
  if (!apiKey) {
    console.error("HOLIDAY_API_KEY 환경변수가 필요합니다.");
    process.exit(1);
  }

  const [fromArg, toArg] = process.argv.slice(2);
  const fromYear = Number(fromArg ?? new Date().getFullYear() - 1);
  const toYear = Number(toArg ?? fromYear + 6);

  const targetFile = path.join(
    process.cwd(),
    "src",
    "calendar",
    "holidays-fallback.json",
  );
  const existing: Record<string, Record<string, string>> = fs.existsSync(
    targetFile,
  )
    ? JSON.parse(fs.readFileSync(targetFile, "utf-8"))
    : {};

  for (let year = fromYear; year <= toYear; year++) {
    process.stdout.write(`동기화 ${year} ... `);
    try {
      const data = await fetchHolidaysFromAPI(year, apiKey);
      existing[String(year)] = data;
      console.log(`${Object.keys(data).length}건`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.log(`실패: ${msg}`);
    }
  }

  fs.writeFileSync(targetFile, JSON.stringify(existing, null, 2));
  console.log(`저장 완료: ${targetFile}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
