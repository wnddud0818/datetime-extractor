import express from "express";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import {
  extract,
  cacheClear,
  cacheSize,
  warmUp,
} from "../src/index.js";
import type { ExtractRequest } from "../src/types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json({ limit: "100kb" }));
app.use(express.static(path.join(__dirname, "public")));

app.post("/api/extract", async (req, res) => {
  try {
    const body = req.body as ExtractRequest;
    if (!body?.text || typeof body.text !== "string") {
      res.status(400).json({ error: "text is required" });
      return;
    }
    const result = await extract(body);
    res.json(result);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    res.status(500).json({ error: msg });
  }
});

app.post("/api/cache/clear", (_req, res) => {
  cacheClear();
  res.json({ ok: true, size: cacheSize() });
});

app.get("/api/examples", (_req, res) => {
  const file = path.join(__dirname, "golden-examples.json");
  const data = fs.readFileSync(file, "utf-8");
  res.type("application/json").send(data);
});

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, cacheSize: cacheSize() });
});

const PORT = Number(process.env.PORT ?? 3000);

// 시작 시 워밍업 (비차단)
warmUp().catch(() => {
  // 무시 — Ollama 없어도 룰 경로는 동작
});

app.listen(PORT, () => {
  console.log(`datetime-extractor test page: http://localhost:${PORT}`);
});
