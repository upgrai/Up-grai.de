import Anthropic from '@anthropic-ai/sdk';
import type { ResolvedConnection } from '../connectors';

export interface LlmRequest {
  system: string;
  prompt: string;
}

export interface LlmResult {
  text: string;
  inputTokens: number;
  outputTokens: number;
  provider: string;
  model: string;
}

// Vorsichtige Kostenschätzung pro 1 Mio. Token in US-Cent; echte Preise je Modell weichen ab.
const EST_INPUT_CENTS_PER_M = 500;
const EST_OUTPUT_CENTS_PER_M = 2500;

export function estimateCents(r: Pick<LlmResult, 'inputTokens' | 'outputTokens'>): number {
  return Math.ceil((r.inputTokens * EST_INPUT_CENTS_PER_M + r.outputTokens * EST_OUTPUT_CENTS_PER_M) / 1_000_000);
}

async function gemini(c: ResolvedConnection, req: LlmRequest): Promise<LlmResult> {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(c.config.model)}:generateContent`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': c.secrets.apiKey },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: req.system }] },
        contents: [{ role: 'user', parts: [{ text: req.prompt }] }],
        generationConfig: { responseMimeType: 'application/json' },
      }),
    },
  );
  if (!res.ok) throw new Error(`Gemini HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = (await res.json()) as {
    candidates?: { content?: { parts?: { text?: string }[] } }[];
    usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
  };
  const text = data.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('') ?? '';
  return {
    text,
    inputTokens: data.usageMetadata?.promptTokenCount ?? 0,
    outputTokens: data.usageMetadata?.candidatesTokenCount ?? 0,
    provider: 'gemini',
    model: c.config.model,
  };
}

async function openai(c: ResolvedConnection, req: LlmRequest): Promise<LlmResult> {
  const res = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${c.secrets.apiKey}` },
    body: JSON.stringify({ model: c.config.model, instructions: req.system, input: req.prompt, text: { format: { type: 'json_object' } } }),
  });
  if (!res.ok) throw new Error(`OpenAI HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = (await res.json()) as {
    output?: { type: string; content?: { type: string; text?: string }[] }[];
    usage?: { input_tokens?: number; output_tokens?: number };
  };
  const text =
    data.output
      ?.filter((o) => o.type === 'message')
      .flatMap((o) => o.content ?? [])
      .filter((p) => p.type === 'output_text')
      .map((p) => p.text ?? '')
      .join('') ?? '';
  return {
    text,
    inputTokens: data.usage?.input_tokens ?? 0,
    outputTokens: data.usage?.output_tokens ?? 0,
    provider: 'openai',
    model: c.config.model,
  };
}

async function claude(c: ResolvedConnection, req: LlmRequest): Promise<LlmResult> {
  const client = new Anthropic({ apiKey: c.secrets.apiKey });
  const response = await client.beta.messages.create({
    model: c.config.model,
    max_tokens: 16000,
    system: req.system,
    messages: [{ role: 'user', content: req.prompt }],
    output_config: { effort: 'medium' },
    // Bei einer Ablehnung durch Sicherheitsfilter übernimmt serverseitig ein Ersatzmodell
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
  });
  if (response.stop_reason === 'refusal') throw new Error('Claude hat die Anfrage abgelehnt');
  const text = response.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
  return {
    text,
    inputTokens: response.usage.input_tokens,
    outputTokens: response.usage.output_tokens,
    provider: 'anthropic',
    model: response.model,
  };
}

export async function generate(conn: ResolvedConnection, req: LlmRequest): Promise<LlmResult> {
  switch (conn.provider) {
    case 'gemini':
      return gemini(conn, req);
    case 'openai':
      return openai(conn, req);
    case 'anthropic':
      return claude(conn, req);
    default:
      throw new Error(`Kein KI-Anbieter: ${conn.provider}`);
  }
}

/** JSON aus einer Modellantwort lesen (toleriert ```json-Zäune). */
export function parseModelJson<T>(text: string): T {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error('Modellantwort enthält kein JSON');
  return JSON.parse(trimmed.slice(start, end + 1)) as T;
}
