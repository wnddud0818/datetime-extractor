import { LRUCache } from "lru-cache";
import type { ExtractResponse } from "../types.js";

export interface CacheKey {
  text: string;
  referenceDate: string;
  timezone: string;
  locale: string;
  outputModes: string[];
  enableLLM: boolean;
  forceLLM: boolean;
  defaultToToday: boolean;
  ambiguityStrategy: string;
  fiscalYearStart: number;
  weekStartsOn: number;
  contextDate: string;
  presentRangeEnd: string;
  defaultMeridiem: string;
  dateOnlyForDateModes: boolean;
  monthBoundaryMode: string;
  fuzzyDayWindow: number;
  timePeriodBounds: Record<string, unknown> | null;
}

const cache = new LRUCache<string, ExtractResponse>({
  max: 1000,
  ttl: 1000 * 60 * 60, // 1시간
});

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }

  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entryValue]) => entryValue !== undefined)
      .sort(([a], [b]) => a.localeCompare(b));
    return `{${entries
      .map(
        ([entryKey, entryValue]) =>
          `${JSON.stringify(entryKey)}:${stableStringify(entryValue)}`,
      )
      .join(",")}}`;
  }

  return JSON.stringify(value) ?? "null";
}

function keyOf(k: CacheKey): string {
  return stableStringify(k);
}

export function cacheGet(k: CacheKey): ExtractResponse | undefined {
  return cache.get(keyOf(k));
}

export function cacheSet(k: CacheKey, v: ExtractResponse): void {
  cache.set(keyOf(k), v);
}

export function cacheClear(): void {
  cache.clear();
}

export function cacheSize(): number {
  return cache.size;
}
