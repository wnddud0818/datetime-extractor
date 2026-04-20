import path from "node:path";
import { defineConfig } from "vite";

const browserHolidayShim = path.resolve(
  __dirname,
  "src/browser/shims/korean-holidays.ts",
);
const browserOllamaShim = path.resolve(
  __dirname,
  "src/browser/shims/ollama-client.ts",
);

export default defineConfig({
  root: path.resolve(__dirname, "web"),
  publicDir: false,
  resolve: {
    alias: [
      {
        find: "./extractor/ollama-client.js",
        replacement: browserOllamaShim,
      },
      {
        find: "./calendar/korean-holidays.js",
        replacement: browserHolidayShim,
      },
      {
        find: "./korean-holidays.js",
        replacement: browserHolidayShim,
      },
    ],
  },
  build: {
    outDir: path.resolve(__dirname, "web-dist"),
    emptyOutDir: true,
  },
});
