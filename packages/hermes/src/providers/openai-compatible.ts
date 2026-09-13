import type {
  HermesToolDefinition,
  ModelMessage,
  ModelProvider,
  ModelRequest,
  ModelResponse,
  ModelToolCall,
} from '../types';

export interface OpenAICompatibleOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  temperature?: number;
  maxTokens?: number;
}

interface OpenAIResponse {
  choices?: Array<{
    message?: {
      content?: string | null;
      tool_calls?: Array<{
        id?: string;
        type?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
    finish_reason?: string | null;
  }>;
}

export class OpenAICompatibleProvider implements ModelProvider {
  readonly name = 'openai-compatible';
  private readonly options: OpenAICompatibleOptions;

  constructor(options: OpenAICompatibleOptions) {
    this.options = {
      baseUrl: options.baseUrl.replace(/\/+$/, ''),
      apiKey: options.apiKey,
      model: options.model,
      temperature: options.temperature,
      maxTokens: options.maxTokens,
    };
  }

  async complete(request: ModelRequest, signal?: AbortSignal): Promise<ModelResponse> {
    const response = await fetch(`${this.options.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.options.apiKey}`,
      },
      body: JSON.stringify({
        model: this.options.model,
        messages: request.messages.map(toOpenAIMessage),
        tools: request.tools.map(toOpenAITool),
        temperature: request.temperature ?? this.options.temperature ?? 0.2,
        max_tokens: request.maxTokens ?? this.options.maxTokens ?? 2048,
      }),
      signal,
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Model provider returned ${response.status}: ${body.slice(0, 400)}`);
    }

    const data = (await response.json()) as OpenAIResponse;
    const choice = data.choices?.[0];
    const message = choice?.message ?? {};
    const toolCalls: ModelToolCall[] = (message.tool_calls ?? []).map((call) => ({
      id: call.id ?? crypto.randomUUID(),
      type: 'function',
      function: {
        name: call.function?.name ?? '',
        arguments: call.function?.arguments ?? '{}',
      },
    }));

    const finish = choice?.finish_reason ?? 'stop';
    return {
      content: message.content ?? '',
      toolCalls,
      finishReason:
        finish === 'tool_calls' ? 'tool_calls' : finish === 'length' ? 'length' : 'stop',
    };
  }
}

function toOpenAIMessage(message: ModelMessage): Record<string, unknown> {
  const result: Record<string, unknown> = {
    role: message.role,
    content: message.content,
  };
  if (message.name) result.name = message.name;
  if (message.role === 'tool' && message.toolCallId) {
    result.tool_call_id = message.toolCallId;
  }
  if (message.toolCalls && message.toolCalls.length > 0) {
    result.tool_calls = message.toolCalls.map((call) => ({
      id: call.id,
      type: call.type,
      function: {
        name: call.function.name,
        arguments: call.function.arguments,
      },
    }));
  }
  return result;
}

function toOpenAITool(tool: HermesToolDefinition): Record<string, unknown> {
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters ?? { type: 'object', properties: {} },
    },
  };
}
