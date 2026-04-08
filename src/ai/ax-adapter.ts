/**
 * Ax Adapter — bridges ex-brain settings to @ax-llm/ax AI instances.
 *
 * Provides a single factory to create Ax AI clients from ex-brain's
 * ResolvedLLM configuration, supporting any OpenAI-compatible endpoint.
 *
 * Fix: Injects enable_thinking: false for DashScope/qwen compatibility.
 * qwen3.5-plus has thinking mode enabled by default, which doesn't support
 * the tool_choice format Ax uses for complex object outputs.
 */

import { ai, AxAIOpenAI, type AxAIServiceOptions } from "@ax-llm/ax";
import type { ResolvedLLM } from "../settings";

// ---------------------------------------------------------------------------
// Custom fetch wrapper: inject enable_thinking: false
// ---------------------------------------------------------------------------

function createThinkingDisabledFetch(originalFetch: typeof fetch): typeof fetch {
  return async function (input: RequestInfo | URL, init?: RequestInit) {
    if (init?.body && typeof init.body === "string") {
      try {
        const body = JSON.parse(init.body);
        // Disable thinking mode for DashScope/qwen compatibility
        // qwen3.5-plus thinking mode doesn't support tool_choice with object format
        body.enable_thinking = false;
        init.body = JSON.stringify(body);
      } catch {
        // Not JSON, leave as-is
      }
    }
    return originalFetch(input, init);
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Create an Ax AI instance from ex-brain LLM settings.
 * Returns null if no API key is configured.
 */
export function createAxAI(llm: ResolvedLLM): AxAIOpenAI<string> | null {
  const apiKey = resolveApiKey(llm);
  if (!apiKey) return null;

  // Wrap fetch to inject enable_thinking: false for DashScope compatibility
  const wrappedFetch = createThinkingDisabledFetch(fetch);

  const options: AxAIServiceOptions = {
    fetch: wrappedFetch,
  };

  // ex-brain uses OpenAI-compatible endpoints (DashScope, etc.)
  // AxAIOpenAI supports custom apiURL for any compatible endpoint.
  return ai({
    name: "openai",
    apiKey,
    ...(llm.baseURL ? { apiURL: llm.baseURL } : {}),
    ...(llm.model ? { config: { model: llm.model } } : {}),
    options,
  });
}

/**
 * Resolve API key from LLM config (direct key or env var).
 */
export function resolveApiKey(llm: ResolvedLLM): string {
  if (llm.apiKey) return llm.apiKey;
  if (llm.apiKeyEnv) return process.env[llm.apiKeyEnv] ?? "";
  return "";
}

/**
 * Check if LLM is properly configured with an API key.
 */
export function isConfigured(llm: ResolvedLLM): boolean {
  return !!resolveApiKey(llm);
}
