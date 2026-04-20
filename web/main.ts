import "./style.css";

import { cacheClear, cacheSize, extract } from "../src/index.ts";
import { browserExamples } from "../src/browser/examples.ts";
import type {
  ExtractedExpression,
  ExtractRequest,
  ExtractResponse,
  OutputMode,
  ResolvedValue,
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

const MODE_LABELS: Record<OutputMode, string> = {
  single: "단일 날짜",
  range: "기간",
  list: "날짜 목록",
  business_days: "영업일",
  weekdays: "평일",
  holidays: "공휴일",
  all: "전체 묶음",
  datetime: "날짜+시간",
};

const TEMPORALITY_LABELS: Record<
  NonNullable<ExtractedExpression["temporality"]>,
  string
> = {
  past: "과거",
  present: "현재",
  future: "미래",
};

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

function formatRangeValue(value: { start: string; end: string }): string {
  return `${value.start} ~ ${value.end}`;
}

function formatListPreview(values: string[]): string {
  if (values.length === 0) {
    return "0개";
  }

  const preview = values.slice(0, 3).join(", ");
  return values.length > 3
    ? `${values.length}개 (${preview} 외 ${values.length - 3}개)`
    : `${values.length}개 (${preview})`;
}

function summarizeAllModes(value: Extract<ResolvedValue, { mode: "all" }>["value"]): string {
  const parts: string[] = [];

  if (value.single) {
    parts.push(`단일 날짜 ${value.single}`);
  }
  if (value.range) {
    parts.push(`기간 ${formatRangeValue(value.range)}`);
  }
  if (value.list) {
    parts.push(`날짜 목록 ${formatListPreview(value.list)}`);
  }
  if (value.business_days) {
    parts.push(`영업일 ${formatListPreview(value.business_days)}`);
  }
  if (value.weekdays) {
    parts.push(`평일 ${formatListPreview(value.weekdays)}`);
  }
  if (value.holidays) {
    parts.push(`공휴일 ${formatListPreview(value.holidays)}`);
  }
  if (value.datetime) {
    parts.push(`날짜+시간 ${formatRangeValue(value.datetime)}`);
  }

  return parts.join(" / ") || "묶인 결과 없음";
}

function summarizeResolvedValue(result: ResolvedValue): string {
  switch (result.mode) {
    case "single":
      return result.value;
    case "range":
    case "datetime":
      return formatRangeValue(result.value);
    case "list":
    case "business_days":
    case "weekdays":
    case "holidays":
      return formatListPreview(result.value);
    case "all":
      return summarizeAllModes(result.value);
    default:
      return "요약 불가";
  }
}

function renderHighlightSummary(response: ExtractResponse): string {
  const expressions = response.expressions ?? [];

  if (expressions.length === 0) {
    const emptyMessage = response.meta.error
      ? `추출 중 오류가 발생했습니다: ${response.meta.error}`
      : "감지된 날짜 표현이 없습니다. 문장을 바꾸거나 출력 모드를 조정해 다시 시도해보세요.";

    return `
      <h3 class="summary-title">결과 요약</h3>
      <p class="summary-copy">${escapeHtml(emptyMessage)}</p>
    `;
  }

  const returnedModes = new Set<OutputMode>();
  const temporalityCounts: Record<
    NonNullable<ExtractedExpression["temporality"]>,
    number
  > = {
    past: 0,
    present: 0,
    future: 0,
  };
  let timedExpressions = 0;

  expressions.forEach((expression) => {
    expression.results.forEach((result) => returnedModes.add(result.mode));
    if (expression.temporality) {
      temporalityCounts[expression.temporality] += 1;
    }
    if (expression.time) {
      timedExpressions += 1;
    }
  });

  const modeList = Array.from(returnedModes);
  const modeText = modeList.length
    ? modeList.map((mode) => MODE_LABELS[mode]).join(", ")
    : "반환된 모드 없음";
  const temporalityText = (
    Object.entries(temporalityCounts) as Array<
      [keyof typeof temporalityCounts, number]
    >
  )
    .filter(([, count]) => count > 0)
    .map(([key, count]) => `${TEMPORALITY_LABELS[key]} ${count}개`)
    .join(" · ");

  const summaryCards = [
    { label: "감지 표현", value: `${expressions.length}개` },
    { label: "반환 모드", value: `${modeList.length}개` },
    { label: "시간 포함", value: `${timedExpressions}개` },
    { label: "시점 분포", value: temporalityText || "없음" },
  ]
    .map(
      (item) => `
        <div class="summary-stat">
          <span class="summary-stat__label">${item.label}</span>
          <strong class="summary-stat__value">${escapeHtml(item.value)}</strong>
        </div>
      `,
    )
    .join("");

  const modeTags = modeList
    .map(
      (mode) =>
        `<span class="summary-chip">${escapeHtml(MODE_LABELS[mode])}</span>`,
    )
    .join("");

  const items = expressions
    .map((expression, index) => {
      const metaParts: string[] = [];
      if (expression.temporality) {
        metaParts.push(TEMPORALITY_LABELS[expression.temporality]);
      }
      if (expression.time) {
        metaParts.push(`${expression.time.startTime} ~ ${expression.time.endTime}`);
      }
      if (expression.confidence !== undefined) {
        metaParts.push(`신뢰도 ${Math.round(expression.confidence * 100)}%`);
      }

      const resultsText = expression.results.length
        ? expression.results
            .map(
              (result) =>
                `${MODE_LABELS[result.mode]}: ${summarizeResolvedValue(result)}`,
            )
            .join(" / ")
        : "반환된 결과가 없습니다.";

      return `
        <article class="summary-item">
          <div class="summary-item__header">
            <span class="summary-item__index">${index + 1}</span>
            <div class="summary-item__body">
              <h4 class="summary-item__title">"${escapeHtml(expression.text)}"</h4>
              <p class="summary-item__meta">${escapeHtml(metaParts.join(" · ") || "추가 메타 정보 없음")}</p>
            </div>
          </div>
          <p class="summary-item__result">${escapeHtml(resultsText)}</p>
        </article>
      `;
    })
    .join("");

  const intro = `총 ${expressions.length}개 표현을 감지했고, ${modeText} 형식으로 결과를 만들었습니다. ${
    timedExpressions > 0
      ? `이 중 ${timedExpressions}개는 시간 정보까지 포함합니다.`
      : "시간 정보가 포함된 표현은 없습니다."
  }`;

  return `
    <h3 class="summary-title">결과 요약</h3>
    <div class="summary-grid">${summaryCards}</div>
    <p class="summary-copy">${escapeHtml(intro)}</p>
    <div class="summary-tags">${modeTags}</div>
    <div class="summary-list">${items}</div>
  `;
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

      const previous = button.textContent ?? "복사";
      try {
        await navigator.clipboard.writeText(target.textContent ?? "");
        button.textContent = "복사됨";
      } catch {
        button.textContent = "복사 실패";
      }

      window.setTimeout(() => {
        button.textContent = previous;
      }, 1400);
    });
  });
}

function updateCacheMeta(extraMessage = ""): void {
  const message = `캐시 크기: ${cacheSize()}${extraMessage ? ` | ${extraMessage}` : ""}`;
  $("#cache-meta").textContent = message;
}

function buildRuntimeNote(response: ExtractResponse, request: ExtractRequest): string {
  const notes = [
    "브라우저에서 룰 엔진만 실행하는 정적 페이지입니다. LLM 폴백은 의도적으로 비활성화되어 있습니다.",
  ];

  if ((response.meta.ruleConfidence ?? 1) < 1) {
    notes.push(
      "룰 신뢰도가 완전 일치보다 낮습니다. 기존 API 페이지라면 여기서 LLM 보완 경로를 선택할 수 있었지만, 이 페이지는 결정론적 동작만 유지합니다.",
    );
  }

  if (
    (request.outputModes ?? []).some((mode) =>
      ["holidays", "business_days", "all"].includes(mode),
    )
  ) {
    notes.push("공휴일과 영업일 결과는 2024년부터 2030년까지 번들된 공휴일 데이터를 기준으로 계산합니다.");
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
  pathBadge.textContent = `경로: ${response.meta.path}`;

  const hasDateBadge = $("#hasdate-badge");
  hasDateBadge.hidden = false;
  hasDateBadge.textContent = response.hasDate ? "날짜 감지됨" : "날짜를 찾지 못함";

  const latencyBadge = $("#latency-badge");
  latencyBadge.hidden = false;
  latencyBadge.textContent = `브라우저 처리 시간 ${response.meta.latencyMs}ms`;

  const breakdown = response.meta.latencyBreakdown
    ? Object.entries(response.meta.latencyBreakdown)
        .filter(([, value]) => value !== undefined)
        .map(([key, value]) => `${key}=${Math.round(value as number)}ms`)
        .join(" · ")
    : "";
  $("#latency-breakdown").textContent = breakdown;

  $("#runtime-note").textContent = buildRuntimeNote(response, request);
  $("#highlight-summary").innerHTML = renderHighlightSummary(response);
  $("#highlight-summary").classList.toggle(
    "summary-box--empty",
    (response.expressions ?? []).length === 0,
  );
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
  extractButton.textContent = "추출 중...";

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
  extractButton.textContent = "추출 실행";
  renderResponse(text, request, response);
}

function loadExamples(): void {
  const container = $("#examples");
  container.innerHTML = "";

  browserExamples.forEach((example) => {
    const wrapper = document.createElement("div");
    wrapper.className = "example-item";
    const button = document.createElement("button");
    button.className = `example-btn${example.disabled ? " example-btn--disabled" : ""}`;
    button.type = "button";
    button.textContent = example.label;
    button.disabled = !!example.disabled;

    button.addEventListener("click", () => {
      ($("#text") as HTMLTextAreaElement).value = example.text;
      setModes(example.modes);
      void doExtract();
    });

    wrapper.appendChild(button);

    if (example.disabledReason) {
      const help = document.createElement("span");
      help.className = "help-tip";
      help.tabIndex = 0;
      help.setAttribute("aria-label", `${example.label} 도움말`);
      help.dataset.tip = example.disabledReason;
      help.textContent = "?";
      wrapper.appendChild(help);
    }

    container.appendChild(wrapper);
  });
}

function wireEvents(): void {
  $$(".help-tip").forEach((tip) => {
    tip.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
    });
  });

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
    updateCacheMeta("캐시를 비웠습니다");
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
