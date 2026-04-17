const $ = (s) => document.querySelector(s);

function todayIso() {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

$("#refDate").value = todayIso();

function selectedModes() {
  return Array.from(
    document.querySelectorAll('.modes input[type="checkbox"]:checked'),
  ).map((el) => el.value);
}

function setModes(modes) {
  document.querySelectorAll('.modes input[type="checkbox"]').forEach((el) => {
    el.checked = modes.includes(el.value);
  });
}

function escapeHtml(s) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function renderHighlight(text, expressions) {
  const spans = [];
  for (const e of expressions) {
    const idx = text.indexOf(e.text);
    if (idx >= 0)
      spans.push({
        start: idx,
        end: idx + e.text.length,
        temporality: e.temporality,
      });
  }
  spans.sort((a, b) => a.start - b.start);
  let out = "";
  let cursor = 0;
  for (const s of spans) {
    if (s.start < cursor) continue;
    out += escapeHtml(text.slice(cursor, s.start));
    const tCls = s.temporality ? ` temp-${s.temporality}` : "";
    const tBadge = s.temporality
      ? `<sup class="temp-badge${tCls}">${s.temporality}</sup>`
      : "";
    out += `<span class="hl${tCls}">${escapeHtml(text.slice(s.start, s.end))}</span>${tBadge}`;
    cursor = s.end;
  }
  out += escapeHtml(text.slice(cursor));
  return out || escapeHtml(text);
}

async function doExtract() {
  const text = $("#text").value.trim();
  if (!text) return;

  const fyRaw = parseInt($("#fiscalYearStart").value, 10);
  const body = {
    text,
    referenceDate: $("#refDate").value || undefined,
    timezone: $("#tz").value,
    locale: $("#locale").value,
    outputModes: selectedModes(),
    forceLLM: $("#forceLLM").checked,
    defaultToToday: $("#defaultToToday").checked,
    ambiguityStrategy: $("#ambiguityStrategy").value,
    fiscalYearStart: Number.isFinite(fyRaw) ? fyRaw : 1,
    weekStartsOn: parseInt($("#weekStartsOn").value, 10),
    contextDate: $("#contextDate").value || undefined,
  };

  const t0 = performance.now();
  const res = await fetch("/api/extract", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const clientMs = Math.round(performance.now() - t0);
  const data = await res.json();

  // Path badge
  const pathBadge = $("#path-badge");
  pathBadge.hidden = false;
  pathBadge.className = `badge path-${data.meta?.path ?? "rule"}`;
  pathBadge.textContent = data.meta?.path ?? "?";

  // Latency badge
  const latencyBadge = $("#latency-badge");
  latencyBadge.hidden = false;
  latencyBadge.textContent = `${data.meta?.latencyMs ?? clientMs}ms (서버) / ${clientMs}ms (클라이언트)`;

  // hasDate badge
  const hdBadge = $("#hasdate-badge");
  hdBadge.hidden = false;
  hdBadge.className = `badge hasdate-${data.hasDate}`;
  hdBadge.textContent = `hasDate: ${data.hasDate}`;

  // Breakdown
  const bd = data.meta?.latencyBreakdown;
  if (bd) {
    const parts = Object.entries(bd)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => `${k}=${Math.round(v)}ms`);
    $("#latency-breakdown").textContent = parts.join(" · ");
  } else {
    $("#latency-breakdown").textContent = "";
  }

  $("#highlighted").innerHTML = renderHighlight(text, data.expressions ?? []);
  $("#dsl").textContent = JSON.stringify(
    (data.expressions ?? []).map((e) => ({
      text: e.text,
      expression: e.expression,
      confidence: e.confidence,
    })),
    null,
    2,
  );
  $("#resolved").textContent = JSON.stringify(
    (data.expressions ?? []).map((e) => ({
      text: e.text,
      temporality: e.temporality,
      results: e.results,
    })),
    null,
    2,
  );

  if (data.meta?.error) {
    $("#resolved").textContent += `\n\n⚠️ ${data.meta.error}`;
  }
}

$("#extract-btn").addEventListener("click", doExtract);
$("#text").addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === "Enter") doExtract();
});

$("#clear-cache-btn").addEventListener("click", async () => {
  await fetch("/api/cache/clear", { method: "POST" });
  alert("캐시를 비웠습니다");
});

async function loadExamples() {
  const res = await fetch("/api/examples");
  const examples = await res.json();
  const container = $("#examples");
  container.innerHTML = "";
  for (const ex of examples) {
    const btn = document.createElement("button");
    btn.textContent = ex.label;
    btn.type = "button";
    btn.addEventListener("click", () => {
      $("#text").value = ex.text;
      if (ex.modes) setModes(ex.modes);
      doExtract();
    });
    container.appendChild(btn);
  }
}
loadExamples();
