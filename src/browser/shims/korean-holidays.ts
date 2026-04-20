import fallbackBundle from "../../calendar/holidays-fallback.json";

type YearHolidays = Record<string, string>;
type HolidayBundle = Record<string, YearHolidays>;

const STORAGE_PREFIX = "datetime-extractor:holiday-cache:";
const bundle = fallbackBundle as HolidayBundle;
const memoryCache = new Map<number, YearHolidays>();

function readStorage(year: number): YearHolidays | null {
  if (typeof window === "undefined" || !window.localStorage) return null;
  try {
    const raw = window.localStorage.getItem(`${STORAGE_PREFIX}${year}`);
    return raw ? (JSON.parse(raw) as YearHolidays) : null;
  } catch {
    return null;
  }
}

function writeStorage(year: number, data: YearHolidays): void {
  if (typeof window === "undefined" || !window.localStorage) return;
  try {
    window.localStorage.setItem(`${STORAGE_PREFIX}${year}`, JSON.stringify(data));
  } catch {
    // Ignore storage failures in constrained browser environments.
  }
}

export async function getHolidays(year: number): Promise<YearHolidays> {
  if (memoryCache.has(year)) {
    return memoryCache.get(year)!;
  }

  const cached = readStorage(year);
  if (cached) {
    memoryCache.set(year, cached);
    return cached;
  }

  const bundled = bundle[String(year)] ?? {};
  memoryCache.set(year, bundled);
  writeStorage(year, bundled);
  return bundled;
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
