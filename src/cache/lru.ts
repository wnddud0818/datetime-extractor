import { LRUCache } from "lru-cache";
import type { ExtractResponse } from "../types.js";

export interface CacheKey {
  text: string;
  referenceDate: string;
  timezone: string;
  locale: string;
  outputModes: string;
}

const cache = new LRUCache<string, ExtractResponse>({
  max: 1000,
  ttl: 1000 * 60 * 60, // 1시간
});

function keyOf(k: CacheKey): string {
  return `${k.text}|${k.referenceDate}|${k.timezone}|${k.locale}|${k.outputModes}`;
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
