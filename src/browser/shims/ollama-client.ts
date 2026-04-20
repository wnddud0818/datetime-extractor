export interface LLMCallResult {
  output: null;
  error?: string;
  rawContent?: string;
}

const DISABLED_ERROR = "llm_disabled_in_browser_rule_page";

export async function callLLM(): Promise<LLMCallResult> {
  return { output: null, error: DISABLED_ERROR };
}

export async function callLLMWithRetry(): Promise<LLMCallResult> {
  return { output: null, error: DISABLED_ERROR };
}

export async function warmUp(): Promise<void> {
  return;
}

export function getModelName(): string {
  return "rules-only";
}
