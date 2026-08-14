// ── AI Provider abstraction (Akame) ────────────────────────────
// The MATRIX app's assistant, Akame, calls this backend. The provider's API
// key lives ONLY on the server (env: AI_API_KEY) and is never shipped in the
// APK. Swapping the underlying provider (OpenAI, Anthropic, a self-hosted
// model, …) is a server-side change — the app's contract is unchanged.

export interface AIProvider {
  readonly name: string;
  generateResponse(input: GenerateInput): Promise<string>;
  summarize?(text: string): Promise<string>;
  moderate?(text: string): Promise<{ flagged: boolean; categories?: string[] }>;
}

export interface GenerateInput {
  prompt: string;
  history?: { role: 'user' | 'assistant'; content: string }[];
  systemPrompt?: string;
}

// A no-op provider used when AI_API_KEY is absent (dev/test). It returns a
// deterministic canned reply so the Akame surface is exercised end-to-end
// without a real provider. The app never knows which provider answered.
export class MockAIProvider implements AIProvider {
  readonly name = 'mock';

  async generateResponse(input: GenerateInput): Promise<string> {
    const replies = [
      'Processando dados da rede… Como posso ajudar?',
      'Conexão estabelecida. Qual sua próxima diretiva?',
      'Sistemas operacionais. Pergunte algo sobre o MATRIX.',
      'Akame online. Interaja com cuidado.',
    ];
    const idx = (input.prompt.length + (input.history?.length ?? 0)) % replies.length;
    return replies[idx];
  }
}

// Lazy singleton accessor. The concrete provider is selected from env so
// the key never appears in client code or logs.
let _provider: AIProvider | null = null;

export function getAIProvider(): AIProvider {
  if (_provider) return _provider;
  _provider = createAIProvider();
  return _provider;
}

export function setAIProvider(provider: AIProvider): void {
  _provider = provider;
}

function createAIProvider(): AIProvider {
  const apiKey = process.env.AI_API_KEY?.trim();
  const providerName = (process.env.AI_PROVIDER ?? 'mock').toLowerCase();

  if (!apiKey || providerName === 'mock') {
    return new MockAIProvider();
  }

  // Real providers are wired here when an API key is configured. Kept as
  // named branches so adding one is a contained change and the key never
  // leaves this function.
  switch (providerName) {
    case 'openai':
      return new OpenAICompatibleProvider(apiKey, process.env.AI_BASE_URL ?? 'https://api.openai.com/v1');
    case 'anthropic':
      return new AnthropicProvider(apiKey);
    default:
      return new MockAIProvider();
  }
}

// Minimal OpenAI-compatible chat completion provider. The key is read from
// env and sent only to the provider's API over HTTPS — never logged.
class OpenAICompatibleProvider implements AIProvider {
  readonly name = 'openai';
  constructor(
    private readonly apiKey: string,
    private readonly baseUrl: string,
    private readonly model = process.env.AI_MODEL ?? 'gpt-4o-mini',
  ) {}

  async generateResponse(input: GenerateInput): Promise<string> {
    const messages = [
      ...(input.systemPrompt ? [{ role: 'system', content: input.systemPrompt }] : []),
      ...(input.history ?? []).map((h) => ({ role: h.role, content: h.content })),
      { role: 'user', content: input.prompt },
    ];
    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({ model: this.model, messages, max_tokens: 512 }),
    });
    if (!res.ok) {
      throw new Error(`AI provider error: ${res.status}`);
    }
    const data = (await res.json()) as { choices: { message: { content: string } }[] };
    return data.choices[0]?.message?.content ?? '';
  }
}

class AnthropicProvider implements AIProvider {
  readonly name = 'anthropic';
  constructor(
    private readonly apiKey: string,
    private readonly model = process.env.AI_MODEL ?? 'claude-3-5-sonnet-20241022',
  ) {}

  async generateResponse(input: GenerateInput): Promise<string> {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: 512,
        system: input.systemPrompt ?? 'You are Akame, the MATRIX assistant.',
        messages: [
          ...(input.history ?? []).map((h) => ({ role: h.role, content: h.content })),
          { role: 'user', content: input.prompt },
        ],
      }),
    });
    if (!res.ok) {
      throw new Error(`AI provider error: ${res.status}`);
    }
    const data = (await res.json()) as { content: { text: string }[] };
    return data.content[0]?.text ?? '';
  }
}
