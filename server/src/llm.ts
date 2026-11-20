// OpenAI-compatible client (Chat Completions or Responses API) using native fetch.
// With no API key configured every caller falls back to the offline fake behaviour.

const env = (...names: string[]) => names.map((name) => process.env[name]).find((value) => value?.trim())?.trim();

const API_KEY = env('CODEX_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY') ?? '';
// Google keys: classic "AIza..." and the newer "AQ." format. AI_PROVIDER=gemini forces it.
const isGeminiKey = process.env.AI_PROVIDER === 'gemini'
  || (process.env.AI_PROVIDER !== 'openai' && /^(AIza|AQ\.)/.test(API_KEY));
const configuredBaseUrl = env('CODEX_BASE_URL', 'OPENAI_BASE_URL');
const configuredModel = env('CODEX_MODEL', 'OPENAI_MODEL', 'GEMINI_MODEL');

const BASE_URL = (
  configuredBaseUrl && !(isGeminiKey && configuredBaseUrl === 'https://api.openai.com/v1')
    ? configuredBaseUrl
    : isGeminiKey
      ? 'https://generativelanguage.googleapis.com/v1beta/openai'
      : 'https://api.openai.com/v1'
).replace(/\/+$/, '');

const MODEL =
  configuredModel && !(isGeminiKey && configuredModel === 'gpt-4o-mini')
    ? configuredModel
    : isGeminiKey
      ? 'gemini-3.1-flash-lite'
      : 'gpt-4o-mini';

const FALLBACK_MODEL = isGeminiKey && !configuredModel ? 'gemini-3-flash-preview' : undefined;

const API_STYLE = !isGeminiKey && env('CODEX_API_STYLE', 'OPENAI_API_STYLE') === 'responses' ? 'responses' : 'chat';

export const llmEnabled = API_KEY.length > 0 && process.env.AI_PROVIDER !== 'fake';
export const llmDescription = llmEnabled
  ? `${MODEL} via ${BASE_URL} (${API_STYLE === 'chat' ? '/chat/completions' : '/responses'})`
  : 'offline scripted replies (set CODEX_API_KEY or OPENAI_API_KEY to enable)';

export interface ChatTurn {
  role: 'user' | 'assistant';
  content: string;
}

interface CompleteOptions {
  instructions: string;
  turns: ChatTurn[];
  timeoutMs: number;
  signal?: AbortSignal;
}

export async function complete({ instructions, turns, timeoutMs, signal }: CompleteOptions): Promise<string> {
  if (!llmEnabled) throw new Error('LLM is not configured');
  try {
    return await requestCompletion(MODEL, { instructions, turns, timeoutMs, signal });
  } catch (error) {
    if (FALLBACK_MODEL && !signal?.aborted && /HTTP (429|503)\b/.test(errorMessage(error))) {
      console.warn(`[llm] ${MODEL} unavailable, retrying with ${FALLBACK_MODEL}`);
      return requestCompletion(FALLBACK_MODEL, { instructions, turns, timeoutMs, signal });
    }
    throw error;
  }
}

async function requestCompletion(
  model: string,
  { instructions, turns, timeoutMs, signal }: CompleteOptions,
): Promise<string> {
  const signals = [AbortSignal.timeout(Math.max(timeoutMs, 1))];
  if (signal) signals.push(signal);

  // Gemini "thinks" by default; disabling or lowering reasoning keeps chat replies fast.
  const defaultReasoning = isGeminiKey
    ? (model.includes('flash-lite-latest') ? 'low' : 'none')
    : undefined;
  const reasoning = env('AI_REASONING_EFFORT') ?? defaultReasoning;
  const body = API_STYLE === 'chat'
    ? { model, messages: [{ role: 'system', content: instructions }, ...turns], ...(reasoning && { reasoning_effort: reasoning }) }
    : { model, instructions, input: turns, store: false, ...(reasoning && { reasoning: { effort: reasoning } }) };

  const response = await fetch(`${BASE_URL}/${API_STYLE === 'chat' ? 'chat/completions' : 'responses'}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${API_KEY}` },
    body: JSON.stringify(body),
    signal: AbortSignal.any(signals),
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${(await response.text()).replace(/\s+/g, ' ').slice(0, 300)}`);
  }
  const data = (await response.json()) as any;
  const text = API_STYLE === 'chat' ? chatText(data) : responsesText(data);
  if (!text.trim()) throw new Error('empty completion');
  return text.trim();
}

function chatText(data: any): string {
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((part: any) => part?.text ?? '').join('');
  return '';
}

function responsesText(data: any): string {
  if (typeof data?.output_text === 'string') return data.output_text;
  return (data?.output ?? [])
    .filter((item: any) => item?.type === 'message')
    .flatMap((item: any) => item.content ?? [])
    .filter((part: any) => part?.type === 'output_text')
    .map((part: any) => part.text)
    .join('');
}

/** Caps concurrent calls, e.g. so a history page cannot fire 30 translations at once. */
export function limitConcurrency(max: number) {
  let active = 0;
  const queue: (() => void)[] = [];
  return async <T,>(task: () => Promise<T>): Promise<T> => {
    if (active >= max) await new Promise<void>((resolve) => queue.push(resolve));
    active++;
    try {
      return await task();
    } finally {
      active--;
      queue.shift()?.();
    }
  };
}

export const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));
