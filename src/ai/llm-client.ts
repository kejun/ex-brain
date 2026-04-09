/**
 * Unified LLM Client Module
 * 
 * Provides centralized LLM calling functionality with:
 * - Retry mechanism (exponential backoff, max 3 retries)
 * - Error classification (APIError, TimeoutError, RateLimitError)
 * - Timeout control
 * - Unified API key resolution
 */

import type { ResolvedLLM } from "../settings";

// ---------------------------------------------------------------------------
// Error Classes
// ---------------------------------------------------------------------------

export class LLMError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly statusCode?: number,
    public readonly retryable: boolean = false,
  ) {
    super(message);
    this.name = "LLMError";
  }
}

export class APIError extends LLMError {
  constructor(message: string, statusCode?: number) {
    super(message, "API_ERROR", statusCode, false);
    this.name = "APIError";
  }
}

export class TimeoutError extends LLMError {
  constructor(message: string = "LLM request timed out") {
    super(message, "TIMEOUT_ERROR", undefined, true);
    this.name = "TimeoutError";
  }
}

export class RateLimitError extends LLMError {
  constructor(message: string = "Rate limit exceeded", retryAfter?: number) {
    super(message, "RATE_LIMIT_ERROR", 429, true);
    this.name = "RateLimitError";
    this.retryAfter = retryAfter;
  }
  readonly retryAfter?: number;
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface LLMClientConfig {
  /** Maximum number of retry attempts (default: 3) */
  maxRetries?: number;
  /** Base delay for exponential backoff in ms (default: 1000) */
  baseDelay?: number;
  /** Maximum delay cap in ms (default: 10000) */
  maxDelay?: number;
  /** Request timeout in ms (default: 60000) */
  timeout?: number;
}

const DEFAULT_CONFIG: Required<LLMClientConfig> = {
  maxRetries: 3,
  baseDelay: 1000,
  maxDelay: 10000,
  timeout: 60000,
};

// ---------------------------------------------------------------------------
// API Key Resolution
// ---------------------------------------------------------------------------

/**
 * Resolve API key from LLM configuration.
 * Checks direct apiKey first, then falls back to environment variable.
 */
export function resolveApiKey(llm: ResolvedLLM): string {
  if (llm.apiKey) return llm.apiKey;
  if (llm.apiKeyEnv) return process.env[llm.apiKeyEnv] ?? "";
  return "";
}

/**
 * Check if LLM is properly configured with an API key.
 */
export function isLLMConfigured(llm: ResolvedLLM): boolean {
  return !!resolveApiKey(llm);
}

// ---------------------------------------------------------------------------
// LLM Call with Retry
// ---------------------------------------------------------------------------

/**
 * Call LLM with unified fetch, retry mechanism, error handling, and timeout.
 * 
 * @param llm - Resolved LLM configuration
 * @param prompt - Prompt to send to the LLM
 * @param maxTokens - Maximum tokens in response
 * @param systemPrompt - Optional system prompt (default provided)
 * @param config - Optional client configuration
 * @returns Raw response text from LLM, or empty string on failure
 */
export async function callLLM(
  llm: ResolvedLLM,
  prompt: string,
  maxTokens: number,
  systemPrompt: string = "You are a helpful assistant. Always output valid JSON.",
  config: LLMClientConfig = {},
): Promise<string> {
  const apiKey = resolveApiKey(llm);
  if (!apiKey) {
    return "";
  }

  const cfg = { ...DEFAULT_CONFIG, ...config };
  const url = llm.baseURL.endsWith("/") 
    ? llm.baseURL + "chat/completions" 
    : llm.baseURL + "/chat/completions";

  const body = {
    model: llm.model,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: prompt },
    ],
    temperature: 0.1,
    max_tokens: maxTokens,
    enable_thinking: false,
  };

  let lastError: LLMError | null = null;

  for (let attempt = 0; attempt <= cfg.maxRetries; attempt++) {
    try {
      const response = await callWithTimeout(
        fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify(body),
        }),
        cfg.timeout,
      );

      if (!response.ok) {
        const text = await response.text().catch(() => "");
        lastError = classifyError(response.status, text, response.statusText);
        
        // Don't retry for non-retryable errors
        if (!lastError.retryable || attempt === cfg.maxRetries) {
          console.warn(`[llm-client] LLM call failed after ${attempt + 1} attempt(s): ${lastError.message}`);
          return "";
        }
        
        const delay = calculateBackoff(attempt, cfg.baseDelay, cfg.maxDelay, (lastError as RateLimitError).retryAfter);
        console.warn(`[llm-client] Retrying after ${delay}ms (attempt ${attempt + 1}/${cfg.maxRetries})`);
        await sleep(delay);
        continue;
      }

      const data = await response.json();
      return data.choices?.[0]?.message?.content?.trim() ?? "";
      
    } catch (error) {
      // Classify the error
      if (error instanceof TimeoutError) {
        lastError = error;
      } else if (error instanceof LLMError) {
        lastError = error;
      } else {
        // Unknown error - wrap it
        const msg = error instanceof Error ? error.message : String(error);
        lastError = new APIError(`Unexpected error: ${msg}`);
      }

      // Don't retry if we've exhausted attempts
      if (attempt === cfg.maxRetries) {
        console.warn(`[llm-client] LLM call failed after ${attempt + 1} attempt(s): ${lastError.message}`);
        return "";
      }

      // Check if error is retryable
      if (!lastError.retryable) {
        console.warn(`[llm-client] Non-retryable error: ${lastError.message}`);
        return "";
      }

      const delay = calculateBackoff(attempt, cfg.baseDelay, cfg.maxDelay);
      console.warn(`[llm-client] Retrying after ${delay}ms (attempt ${attempt + 1}/${cfg.maxRetries}): ${lastError.message}`);
      await sleep(delay);
    }
  }

  return "";
}

/**
 * Classify HTTP error into appropriate error type.
 */
function classifyError(status: number, responseText: string, statusText: string): LLMError {
  const truncatedText = responseText.slice(0, 200);
  
  switch (status) {
    case 429:
      // Try to extract retry-after from response
      const retryAfterMatch = responseText.match(/retry[- ]?after["']?\s*[:=]\s*(\d+)/i);
      const retryAfter = retryAfterMatch ? parseInt(retryAfterMatch[1], 10) : undefined;
      return new RateLimitError(`Rate limited: ${statusText} - ${truncatedText}`, retryAfter);
    
    case 408:
    case 504:
      return new TimeoutError(`Request timeout: ${statusText}`);
    
    case 500:
    case 502:
    case 503:
      return new APIError(`Server error (${status}): ${truncatedText}`, status);
    
    default:
      if (status >= 500) {
        return new APIError(`Server error (${status}): ${truncatedText}`, status);
      }
      if (status >= 400) {
        return new APIError(`Client error (${status}): ${truncatedText}`, status);
      }
      return new APIError(`HTTP error (${status}): ${truncatedText}`, status);
  }
}

/**
 * Calculate exponential backoff delay with jitter.
 */
function calculateBackoff(
  attempt: number,
  baseDelay: number,
  maxDelay: number,
  retryAfter?: number,
): number {
  // If server specified retry-after, use that
  if (retryAfter && retryAfter > 0) {
    return Math.min(retryAfter * 1000, maxDelay);
  }
  
  // Exponential backoff: baseDelay * 2^attempt
  const exponentialDelay = baseDelay * Math.pow(2, attempt);
  
  // Add jitter (±25%)
  const jitter = exponentialDelay * 0.25 * (Math.random() * 2 - 1);
  
  return Math.min(Math.round(exponentialDelay + jitter), maxDelay);
}

/**
 * Sleep for specified milliseconds.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Wrap fetch with timeout using Promise.race.
 */
async function callWithTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timeoutId: NodeJS.Timeout;
  
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new TimeoutError(`Request timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    clearTimeout(timeoutId!);
  }
}

// ---------------------------------------------------------------------------
// Re-export settings type for convenience
// ---------------------------------------------------------------------------

export type { ResolvedLLM } from "../settings";