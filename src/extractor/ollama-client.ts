import { Ollama } from "ollama";
import { SYSTEM_PROMPT, FEW_SHOT_EXAMPLES } from "./prompt.js";
import { llmOutputSchema, ollamaJsonSchema, type LLMOutput } from "./schema.js";

const DEFAULT_MODEL = process.env.OLLAMA_MODEL ?? "qwen2.5:3b-instruct";
const DEFAULT_HOST = process.env.OLLAMA_HOST ?? "http://localhost:11434";

let clientInstance: Ollama | null = null;

function client(): Ollama {
  if (!clientInstance) {
    clientInstance = new Ollama({ host: DEFAULT_HOST });
  }
  return clientInstance;
}

function buildMessages(userText: string): Array<{ role: "system" | "user" | "assistant"; content: string }> {
  const msgs: Array<{ role: "system" | "user" | "assistant"; content: string }> = [
    { role: "system", content: SYSTEM_PROMPT },
  ];
  for (const ex of FEW_SHOT_EXAMPLES) {
    msgs.push({ role: "user", content: ex.user });
    msgs.push({ role: "assistant", content: ex.assistant });
  }
  msgs.push({ role: "user", content: userText });
  return msgs;
}

export interface LLMCallResult {
  output: LLMOutput | null;
  error?: string;
  rawContent?: string;
}

export async function callLLM(
  userText: string,
  options?: { model?: string; temperature?: number },
): Promise<LLMCallResult> {
  const model = options?.model ?? DEFAULT_MODEL;
  const temperature = options?.temperature ?? 0;
  try {
    const res = await client().chat({
      model,
      messages: buildMessages(userText),
      format: ollamaJsonSchema as object,
      options: {
        temperature,
        seed: 42,
        num_predict: 512,
        num_ctx: 4096,
      },
      keep_alive: "10m",
    });
    const content = res.message?.content ?? "";
    if (!content.trim()) {
      return { output: null, error: "empty_content" };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch {
      return { output: null, error: "json_parse_failed", rawContent: content };
    }
    const validated = llmOutputSchema.safeParse(parsed);
    if (!validated.success) {
      return {
        output: null,
        error: `schema_validation_failed: ${validated.error.message}`,
        rawContent: content,
      };
    }
    return { output: validated.data, rawContent: content };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { output: null, error: `ollama_error: ${msg}` };
  }
}

export async function callLLMWithRetry(userText: string): Promise<LLMCallResult> {
  const first = await callLLM(userText, { temperature: 0 });
  if (first.output) return first;
  // 재시도: 온도 살짝 올려서
  const retry = await callLLM(userText, { temperature: 0.2 });
  return retry.output ? retry : first;
}

export async function warmUp(model?: string): Promise<void> {
  const m = model ?? DEFAULT_MODEL;
  try {
    await client().generate({
      model: m,
      prompt: "warmup",
      stream: false,
      options: { num_predict: 1 },
      keep_alive: "10m",
    });
  } catch {
    // 워밍업 실패는 무시
  }
}

export function getModelName(): string {
  return DEFAULT_MODEL;
}
