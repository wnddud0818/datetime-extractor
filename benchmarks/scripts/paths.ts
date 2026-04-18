import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));

export const benchmarksDir = path.resolve(scriptDir, "..");
export const repoRoot = path.resolve(benchmarksDir, "..");
export const datasetsDir = path.join(benchmarksDir, "datasets");
export const reportsDir = path.join(benchmarksDir, "reports");
export const sourceDatasetsDir = path.join(datasetsDir, "source");

export function ensureBenchmarkDirs(): void {
  fs.mkdirSync(datasetsDir, { recursive: true });
  fs.mkdirSync(reportsDir, { recursive: true });
  fs.mkdirSync(sourceDatasetsDir, { recursive: true });
}
