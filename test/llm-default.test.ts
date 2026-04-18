import { beforeEach, describe, expect, it, vi } from "vitest";

const llmMocks = vi.hoisted(() => ({
  callLLMWithRetry: vi.fn(),
  getModelName: vi.fn(() => "mock-llm"),
  warmUp: vi.fn(),
}));

vi.mock("../src/extractor/ollama-client.js", () => ({
  callLLMWithRetry: llmMocks.callLLMWithRetry,
  getModelName: llmMocks.getModelName,
  warmUp: llmMocks.warmUp,
}));

import { cacheClear, extract } from "../src/index.js";

describe("LLM 기본값", () => {
  beforeEach(() => {
    cacheClear();
    llmMocks.callLLMWithRetry.mockReset();
    llmMocks.getModelName.mockReset();
    llmMocks.getModelName.mockReturnValue("mock-llm");
  });

  it("기본값으로는 날짜 미감지 시 LLM 폴백을 호출하지 않는다", async () => {
    llmMocks.callLLMWithRetry.mockResolvedValue({
      output: {
        expressions: [
          {
            text: "보통예금 얼마 있어?",
            expression: { kind: "named", name: "today" },
            confidence: 0.72,
          },
        ],
      },
      error: undefined,
    });

    const res = await extract({
      text: "보통예금 얼마 있어?",
      referenceDate: "2025-11-17",
      outputModes: ["single"],
    });

    expect(llmMocks.callLLMWithRetry).not.toHaveBeenCalled();
    expect(res.hasDate).toBe(false);
    expect(res.expressions).toHaveLength(0);
    expect(res.meta.path).toBe("rule");
    expect(res.meta.model).toBe("rules");
  });

  it("enableLLM=true면 날짜 미감지 시 LLM 폴백을 사용한다", async () => {
    llmMocks.callLLMWithRetry.mockResolvedValue({
      output: {
        expressions: [
          {
            text: "보통예금 얼마 있어?",
            expression: { kind: "named", name: "today" },
            confidence: 0.72,
          },
        ],
      },
      error: undefined,
    });

    const res = await extract({
      text: "보통예금 얼마 있어?",
      referenceDate: "2025-11-17",
      outputModes: ["single"],
      enableLLM: true,
    });

    expect(llmMocks.callLLMWithRetry).toHaveBeenCalledOnce();
    expect(res.hasDate).toBe(true);
    expect(res.meta.path).toBe("llm");
    expect(res.meta.model).toBe("mock-llm");
    const single = res.expressions[0].results.find((x) => x.mode === "single");
    expect(single?.value).toBe("2025-11-17");
  });

  it("forceLLM=true면 enableLLM 기본값과 관계없이 LLM을 사용한다", async () => {
    llmMocks.callLLMWithRetry.mockResolvedValue({
      output: {
        expressions: [
          {
            text: "보통예금 얼마 있어?",
            expression: { kind: "named", name: "today" },
            confidence: 0.72,
          },
        ],
      },
      error: undefined,
    });

    const res = await extract({
      text: "보통예금 얼마 있어?",
      referenceDate: "2025-11-17",
      outputModes: ["single"],
      forceLLM: true,
    });

    expect(llmMocks.callLLMWithRetry).toHaveBeenCalledOnce();
    expect(res.hasDate).toBe(true);
    expect(res.meta.path).toBe("llm");
  });
});
