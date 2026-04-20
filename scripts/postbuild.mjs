import fs from "node:fs";
import path from "node:path";

const distCalendarDir = new URL("../dist/calendar/", import.meta.url);

fs.mkdirSync(distCalendarDir, { recursive: true });

for (const relativePath of ["src/calendar/holidays-fallback.json"]) {
  const sourcePath = new URL(`../${relativePath}`, import.meta.url);
  const fileName = path.basename(relativePath);
  const destPath = new URL(`../dist/calendar/${fileName}`, import.meta.url);
  fs.copyFileSync(sourcePath, destPath);
}
