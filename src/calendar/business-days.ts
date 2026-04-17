import { eachDayOfInterval, getDay, format } from "date-fns";
import { getHolidays } from "./korean-holidays.js";

export function isWeekend(date: Date): boolean {
  const d = getDay(date);
  return d === 0 || d === 6;
}

export function isWeekday(date: Date): boolean {
  const d = getDay(date);
  return d >= 1 && d <= 5;
}

export async function isBusinessDay(date: Date): Promise<boolean> {
  if (isWeekend(date)) return false;
  const iso = format(date, "yyyy-MM-dd");
  const year = Number(iso.slice(0, 4));
  const holidays = await getHolidays(year);
  return !(iso in holidays);
}

export async function listBusinessDays(
  start: Date,
  end: Date,
): Promise<string[]> {
  const days = eachDayOfInterval({ start, end });
  const out: string[] = [];
  for (const d of days) {
    if (await isBusinessDay(d)) {
      out.push(format(d, "yyyy-MM-dd"));
    }
  }
  return out;
}

export function listWeekdays(start: Date, end: Date): string[] {
  return eachDayOfInterval({ start, end })
    .filter(isWeekday)
    .map((d) => format(d, "yyyy-MM-dd"));
}

export function listWeekends(start: Date, end: Date): string[] {
  return eachDayOfInterval({ start, end })
    .filter(isWeekend)
    .map((d) => format(d, "yyyy-MM-dd"));
}

export function listSaturdays(start: Date, end: Date): string[] {
  return eachDayOfInterval({ start, end })
    .filter((d) => getDay(d) === 6)
    .map((d) => format(d, "yyyy-MM-dd"));
}

export function listSundays(start: Date, end: Date): string[] {
  return eachDayOfInterval({ start, end })
    .filter((d) => getDay(d) === 0)
    .map((d) => format(d, "yyyy-MM-dd"));
}

export async function listHolidaysInRange(
  start: Date,
  end: Date,
): Promise<string[]> {
  const startYear = start.getFullYear();
  const endYear = end.getFullYear();
  const out: string[] = [];
  for (let y = startYear; y <= endYear; y++) {
    const holidays = await getHolidays(y);
    for (const date of Object.keys(holidays)) {
      if (date >= format(start, "yyyy-MM-dd") && date <= format(end, "yyyy-MM-dd")) {
        out.push(date);
      }
    }
  }
  return out.sort();
}
