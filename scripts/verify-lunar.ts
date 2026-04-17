import fs from "node:fs";
import path from "node:path";
import KoreanLunarCalendar from "korean-lunar-calendar";

/**
 * holidays-fallback.json의 음력 기반 공휴일(설날/추석/부처님오신날)이
 * korean-lunar-calendar로 계산한 양력 날짜와 일치하는지 검증.
 */

interface LunarHoliday {
  name: string;
  lunarMonth: number;
  lunarDay: number;
  searchKeyword: string;
}

const LUNAR_HOLIDAYS: LunarHoliday[] = [
  { name: "설날", lunarMonth: 1, lunarDay: 1, searchKeyword: "설날" },
  { name: "부처님 오신 날", lunarMonth: 4, lunarDay: 8, searchKeyword: "부처님" },
  { name: "추석", lunarMonth: 8, lunarDay: 15, searchKeyword: "추석" },
];

function lunarToSolar(year: number, month: number, day: number) {
  const cal = new KoreanLunarCalendar();
  cal.setLunarDate(year, month, day, false);
  const s = cal.getSolarCalendar();
  return `${s.year}-${String(s.month).padStart(2, "0")}-${String(s.day).padStart(2, "0")}`;
}

function findKeyword(bundle: Record<string, string>, keyword: string): string | null {
  // "설날"과 "설날 연휴"를 구분하기 위해, "연휴"가 없는 정확한 이름을 우선 매치
  const entries = Object.entries(bundle);
  const exact = entries.find(([, name]) => {
    if (keyword === "설날") return name === "설날";
    if (keyword === "추석") return name === "추석" || name.startsWith("추석 /");
    return name.includes(keyword);
  });
  if (exact) return exact[0];
  // 폴백: 연휴 포함 매치
  const loose = entries.find(([, name]) => name.includes(keyword));
  return loose ? loose[0] : null;
}

const file = path.join(process.cwd(), "src", "calendar", "holidays-fallback.json");
const bundle = JSON.parse(fs.readFileSync(file, "utf-8")) as Record<
  string,
  Record<string, string>
>;

let mismatches = 0;
for (const year of Object.keys(bundle).sort()) {
  const y = Number(year);
  console.log(`\n=== ${year} ===`);
  for (const h of LUNAR_HOLIDAYS) {
    const expected = lunarToSolar(y, h.lunarMonth, h.lunarDay);
    const actual = findKeyword(bundle[year], h.searchKeyword);
    const status =
      actual === expected ? "OK" : actual ? `MISMATCH (got ${actual})` : "MISSING";
    const mark = status === "OK" ? "✓" : "✗";
    console.log(`  ${mark} ${h.name.padEnd(12)} 음 ${h.lunarMonth}/${h.lunarDay} → 양 ${expected}  ${status}`);
    if (status !== "OK") mismatches++;
  }
}

console.log(`\n불일치: ${mismatches}건`);
process.exit(mismatches > 0 ? 1 : 0);
