import "./style.css";

import { cacheClear, cacheSize, extract } from "../src/index.ts";
import { browserExamples } from "../src/browser/examples.ts";
import type {
  ExtractedExpression,
  ExtractRequest,
  ExtractResponse,
  OutputMode,
} from "../src/types.ts";

const $ = <T extends Element>(selector: string): T => {
  const element = document.querySelector<T>(selector);
  if (!element) {
    throw new Error(`Missing element: ${selector}`);
  }
  return element;
};

const $$ = <T extends Element>(selector: string): T[] =>
  Array.from(document.querySelectorAll<T>(selector));

function todayIso(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function selectedModes(): OutputMode[] {
  return $$("#modes input[type='checkbox']:checked").map(
    (input) => (input as HTMLInputElement).value as OutputMode,
  );
}

function setModes(modes: OutputMode[]): void {
  $$("#modes input[type='checkbox']").forEach((input) => {
    (input as HTMLInputElement).checked = modes.includes(
      (input as HTMLInputElement).value as OutputMode,
    );
  });
}

function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function renderHighlight(text: string, expressions: ExtractedExpression[]): string {
  const spans = expressions
    .filter((expression) => expression.text)
    .map((expression) => {
      const start = text.indexOf(expression.text);
      return {
        start,
        end: start >= 0 ? start + expression.text.length : -1,
        temporality: expression.temporality,
      };
    })
    .filter((span) => span.start >= 0)
    .sort((a, b) => a.start - b.start);

  if (spans.length === 0) {
    return escapeHtml(text);
  }

  let cursor = 0;
  let output = "";

  for (const span of spans) {
    if (span.start < cursor) continue;
    output += escapeHtml(text.slice(cursor, span.start));
    const modifier = span.temporality ? ` temp-${span.temporality}` : "";
    const badge = span.temporality
      ? `<sup class="temp-badge">${span.temporality}</sup>`
      : "";
    output += `<span class="hl${modifier}">${escapeHtml(text.slice(span.start, span.end))}</span>${badge}`;
    cursor = span.end;
  }

  output += escapeHtml(text.slice(cursor));
  return output;
}

function activateTab(name: string): void {
  $$(".tab").forEach((tab) => {
    const active = (tab as HTMLButtonElement).dataset.tab === name;
    tab.classList.toggle("is-active", active);
    tab.setAttribute("aria-selected", active ? "true" : "false");
  });

  $$(".tab-panel").forEach((panel) => {
    const active = panel.id === `panel-${name}`;
    panel.classList.toggle("is-active", active);
    (panel as HTMLElement).hidden = !active;
  });
}

function initTabs(): void {
  $$(".tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      activateTab((tab as HTMLButtonElement).dataset.tab ?? "highlight");
    });
  });
}

function initCopyButtons(): void {
  $$(".copy-btn").forEach((button) => {
    button.addEventListener("click", async () => {
      const targetId = (button as HTMLButtonElement).dataset.target;
      if (!targetId) return;
      const target = document.getElementById(targetId);
      if (!target) return;

      const previous = button.textContent ?? "Copy";
      try {
        await navigator.clipboard.writeText(target.textContent ?? "");
        button.textContent = "Copied";
      } catch {
        button.textContent = "Copy failed";
      }

      window.setTimeout(() => {
        button.textContent = previous;
      }, 1400);
    });
  });
}

function updateCacheMeta(extraMessage = ""): void {
  const message = `Cache size: ${cacheSize()}${extraMessage ? ` | ${extraMessage}` : ""}`;
  $("#cache-meta").textContent = message;
}

function buildRuntimeNote(response: ExtractResponse, request: ExtractRequest): string {
  const notes = [
    "Rule-only browser runtime. LLM fallback is intentionally disabled.",
  ];

  if ((response.meta.ruleConfidence ?? 1) < 1) {
    notes.push(
      "Partial rule confidence detected. The old API page could optionally fall back to LLM here, but this page stays deterministic.",
    );
  }

  if (
    (request.outputModes ?? []).some((mode) =>
      ["holidays", "business_days", "all"].includes(mode),
    )
  ) {
    notes.push("Holiday and business-day outputs rely on bundled holiday data for 2024-2030.");
  }

  return notes.join(" ");
}

function showResults(): void {
  $("#results-empty").hidden = true;
  $("#results-content").hidden = false;
}

function renderResponse(
  text: string,
  request: ExtractRequest,
  response: ExtractResponse,
): void {
  showResults();

  const pathBadge = $("#path-badge");
  pathBadge.hidden = false;
  pathBadge.textContent = response.meta.path;

  const hasDateBadge = $("#hasdate-badge");
  hasDateBadge.hidden = false;
  hasDateBadge.textContent = `hasDate: ${response.hasDate}`;

  const latencyBadge = $("#latency-badge");
  latencyBadge.hidden = false;
  latencyBadge.textContent = `${response.meta.latencyMs}ms in browser`;

  const breakdown = response.meta.latencyBreakdown
    ? Object.entries(response.meta.latencyBreakdown)
        .filter(([, value]) => value !== undefined)
        .map(([key, value]) => `${key}=${Math.round(value as number)}ms`)
        .join(" | ")
    : "";
  $("#latency-breakdown").textContent = breakdown;

  $("#runtime-note").textContent = buildRuntimeNote(response, request);
  $("#highlighted").innerHTML = renderHighlight(text, response.expressions ?? []);
  $("#dsl").textContent = JSON.stringify(
    (response.expressions ?? []).map((expression) => ({
      text: expression.text,
      expression: expression.expression,
      confidence: expression.confidence,
    })),
    null,
    2,
  );

  const resolvedPayload = {
    hasDate: response.hasDate,
    expressions: (response.expressions ?? []).map((expression) => ({
      text: expression.text,
      temporality: expression.temporality,
      results: expression.results,
      ...(expression.time ? { time: expression.time } : {}),
    })),
    meta: response.meta,
  };
  $("#resolved").textContent = JSON.stringify(resolvedPayload, null, 2);
  updateCacheMeta();
}

async function doExtract(): Promise<void> {
  const text = ($("#text") as HTMLTextAreaElement).value.trim();
  if (!text) return;

  const extractButton = $("#extract-btn") as HTMLButtonElement;
  extractButton.disabled = true;
  extractButton.textContent = "Extracting...";

  const fiscalYearStart = Number.parseInt(
    ($("#fiscalYearStart") as HTMLInputElement).value,
    10,
  );
  const weekStartsOn = Number.parseInt(
    ($("#weekStartsOn") as HTMLSelectElement).value,
    10,
  ) as 0 | 1;

  const request: ExtractRequest = {
    text,
    referenceDate: ($("#refDate") as HTMLInputElement).value || undefined,
    timezone: ($("#tz") as HTMLSelectElement).value,
    locale: ($("#locale") as HTMLSelectElement).value as ExtractRequest["locale"],
    outputModes: selectedModes(),
    enableLLM: false,
    forceLLM: false,
    defaultToToday: ($("#defaultToToday") as HTMLInputElement).checked,
    ambiguityStrategy: ($("#ambiguityStrategy") as HTMLSelectElement).value as ExtractRequest["ambiguityStrategy"],
    fiscalYearStart: Number.isFinite(fiscalYearStart) ? fiscalYearStart : 1,
    weekStartsOn,
    contextDate: ($("#contextDate") as HTMLInputElement).value || undefined,
    presentRangeEnd: ($("#presentRangeEnd") as HTMLSelectElement).value as ExtractRequest["presentRangeEnd"],
    defaultMeridiem:
      (($("#defaultMeridiem") as HTMLSelectElement).value || undefined) as
        | "am"
        | "pm"
        | undefined,
    dateOnlyForDateModes: ($("#dateOnlyForDateModes") as HTMLInputElement).checked,
  };

  let response: ExtractResponse;
  try {
    response = await extract(request);
  } catch (error) {
    response = {
      hasDate: false,
      expressions: [],
      meta: {
        referenceDate: request.referenceDate ?? todayIso(),
        timezone: request.timezone ?? "Asia/Seoul",
        model: "rules-only",
        path: "rule",
        latencyMs: 0,
        error: error instanceof Error ? error.message : String(error),
      },
    };
  }

  extractButton.disabled = false;
  extractButton.textContent = "Extract";
  renderResponse(text, request, response);
}

function loadExamples(): void {
  const container = $("#examples");
  container.innerHTML = "";

  browserExamples.forEach((example) => {
    const button = document.createElement("button");
    button.className = `example-btn${example.disabled ? " example-btn--disabled" : ""}`;
    button.type = "button";
    button.textContent = example.label;
    button.disabled = !!example.disabled;
    if (example.disabledReason) {
      button.title = example.disabledReason;
    }

    button.addEventListener("click", () => {
      ($("#text") as HTMLTextAreaElement).value = example.text;
      setModes(example.modes);
      void doExtract();
    });

    container.appendChild(button);
  });
}

function wireEvents(): void {
  ($("#extract-btn") as HTMLButtonElement).addEventListener("click", () => {
    void doExtract();
  });

  ($("#text") as HTMLTextAreaElement).addEventListener("keydown", (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
      event.preventDefault();
      void doExtract();
    }
  });

  ($("#clear-cache-btn") as HTMLButtonElement).addEventListener("click", () => {
    cacheClear();
    updateCacheMeta("Cleared");
  });
}

function boot(): void {
  ($("#refDate") as HTMLInputElement).value = todayIso();
  activateTab("highlight");
  initTabs();
  initCopyButtons();
  wireEvents();
  loadExamples();
  updateCacheMeta();
}

boot();
