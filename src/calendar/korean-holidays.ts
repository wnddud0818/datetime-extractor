import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { XMLParser } from "fast-xml-parser";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const FALLBACK_PATH = path.join(__dirname, "holidays-fallback.json");
const CACHE_DIR = path.join(os.homedir(), ".datetime-extractor-cache");

type YearHolidays = Record<string, string>; // "YYYY-MM-DD" -> name
type HolidayBundle = Record<string, YearHolidays>;

let fallbackBundle: HolidayBundle | null = null;
const memoryCache = new Map<number, YearHolidays>();

function loadFallback(): HolidayBundle {
  if (fallbackBundle) return fallbackBundle;
  const raw = fs.readFileSync(FALLBACK_PATH, "utf-8");
  fallbackBundle = JSON.parse(raw) as HolidayBundle;
  return fallbackBundle;
}

function loadDiskCache(year: number): YearHolidays | null {
  const file = path.join(CACHE_DIR, `${year}.json`);
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch {
    return null;
  }
}

function saveDiskCache(year: number, data: YearHolidays): void {
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(
      path.join(CACHE_DIR, `${year}.json`),
      JSON.stringify(data, null, 2),
    );
  } catch {
    // 캐시 저장 실패는 무시
  }
}

export async function fetchHolidaysFromAPI(
  year: number,
  apiKey: string,
): Promise<YearHolidays> {
  const result: YearHolidays = {};
  const parser = new XMLParser({ ignoreAttributes: false });

  for (let month = 1; month <= 12; month++) {
    const url =
      `https://apis.data.go.kr/B090041/openapi/service/SpcdeInfoService/getRestDeInfo` +
      `?solYear=${year}&solMonth=${String(month).padStart(2, "0")}` +
      `&ServiceKey=${encodeURIComponent(apiKey)}&_type=xml&numOfRows=50`;

    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`Holiday API HTTP ${res.status} for ${year}-${month}`);
    }
    const xml = await res.text();
    const json = parser.parse(xml);
    const items = json?.response?.body?.items?.item;
    if (!items) continue;
    const list = Array.isArray(items) ? items : [items];
    for (const item of list) {
      if (item.isHoliday === "Y" || item.isHoliday === "y") {
        const locdate = String(item.locdate);
        const iso = `${locdate.slice(0, 4)}-${locdate.slice(4, 6)}-${locdate.slice(6, 8)}`;
        result[iso] = String(item.dateName ?? "공휴일");
      }
    }
  }
  return result;
}

export async function getHolidays(year: number): Promise<YearHolidays> {
  if (memoryCache.has(year)) return memoryCache.get(year)!;

  const disk = loadDiskCache(year);
  if (disk) {
    memoryCache.set(year, disk);
    return disk;
  }

  const apiKey = process.env.HOLIDAY_API_KEY;
  if (apiKey) {
    try {
      const fromApi = await fetchHolidaysFromAPI(year, apiKey);
      if (Object.keys(fromApi).length > 0) {
        saveDiskCache(year, fromApi);
        memoryCache.set(year, fromApi);
        return fromApi;
      }
    } catch {
      // API 실패 시 폴백으로
    }
  }

  const bundle = loadFallback();
  const fallback = bundle[String(year)] ?? {};
  memoryCache.set(year, fallback);
  return fallback;
}

export async function isHoliday(dateIso: string): Promise<boolean> {
  const year = Number(dateIso.slice(0, 4));
  const holidays = await getHolidays(year);
  return dateIso in holidays;
}

export async function listHolidays(
  year: number,
): Promise<Array<{ date: string; name: string }>> {
  const holidays = await getHolidays(year);
  return Object.entries(holidays)
    .map(([date, name]) => ({ date, name }))
    .sort((a, b) => a.date.localeCompare(b.date));
}
