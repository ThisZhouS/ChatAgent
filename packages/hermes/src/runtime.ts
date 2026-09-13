import type { AgentEvent } from '@chatagent/contracts';
import { buildSystemPrompt } from './system-prompt';
import { ToolRegistry } from './tools';
import type {
  HermesRuntimeConfig,
  ModelMessage,
  ModelProvider,
  ModelResponse,
  ModelToolCall,
  RunRequest,
  RunResult,
  Tool,
  ToolCallRecord,
} from './types';

export interface HermesAgentRuntimeOptions {
  provider: ModelProvider;
  tools?: Tool[];
  config?: HermesRuntimeConfig;
}

export class HermesAgentRuntime {
  readonly registry = new ToolRegistry();
  provider: ModelProvider;
  config: HermesRuntimeConfig;

  constructor(options: HermesAgentRuntimeOptions) {
    this.provider = options.provider;
    this.config = options.config ?? {};
    if (options.tools) this.registry.registerAll(options.tools);
  }

  async run(request: RunRequest): Promise<RunResult> {
    const maxToolSteps = this.config.maxToolSteps ?? 8;
    const events: AgentEvent[] = [];
    const toolCalls: ToolCallRecord[] = [];
    const runId = request.runId ?? crypto.randomUUID();
    const emit = (event: AgentEvent) => {
      events.push(event);
      request.onEvent?.(event);
    };

    const account = request.account ?? { displayName: 'ChatAgent', persona: '' };
    const systemPrompt = buildSystemPrompt({
      displayName: account.displayName,
      persona: account.persona || 'Be concise and complete real work.',
      tools: this.registry.listDefinitions(),
      extra: this.config.extraSystemPrompt,
    });

    const messages: ModelMessage[] = [
      { role: 'system', content: systemPrompt },
      ...(request.history ?? []),
      { role: 'user', content: request.goal },
    ];

    emit({ type: 'turn_start', runId, goal: request.goal, at: new Date().toISOString() });

    try {
      for (let step = 0; step < maxToolSteps; step += 1) {
        request.signal?.throwIfAborted();

        let response: ModelResponse;
        try {
          response = await this.provider.complete(
            {
              messages,
              tools: this.registry.listDefinitions(),
              temperature: this.config.temperature,
              maxTokens: this.config.maxTokens,
            },
            request.signal,
          );
        } catch (error) {
          if (isAbortError(error)) {
            return this.finishCancelled(runId, 'model request aborted', toolCalls, events, emit);
          }
          const message = describeError(error);
          emit({ type: 'turn_error', runId, error: message, at: new Date().toISOString() });
          return {
            runId,
            outcome: { status: 'failed', code: 'provider_error', message, retryable: true },
            text: '',
            toolCalls,
            events,
          };
        }

        if (response.toolCalls.length === 0) {
          const text = response.content.trim();
          if (!text) {
            emit({
              type: 'turn_error',
              runId,
              error: 'model returned no content and no tool calls',
              at: new Date().toISOString(),
            });
            return {
              runId,
              outcome: {
                status: 'failed',
                code: 'empty_response',
                message: '模型未返回任何内容或工具调用。',
                retryable: true,
              },
              text: '',
              toolCalls,
              events,
            };
          }

          emit({ type: 'assistant_message', runId, text, at: new Date().toISOString() });
          emit({ type: 'turn_end', runId, result: text, at: new Date().toISOString() });

          if (response.finishReason === 'length') {
            return {
              runId,
              outcome: {
                status: 'incomplete',
                reason: 'output_limit',
                message: '模型输出达到长度上限，结果不完整。',
              },
              text,
              toolCalls,
              events,
            };
          }

          return {
            runId,
            outcome: { status: 'succeeded', summary: text },
            text,
            toolCalls,
            events,
          };
        }

        // Record the assistant's tool-call turn and then execute each tool.
        messages.push({
          role: 'assistant',
          content: response.content,
          toolCalls: response.toolCalls,
        });

        for (const call of response.toolCalls) {
          request.signal?.throwIfAborted();
          const record = await this.executeToolCall(call, request, runId, emit);
          toolCalls.push(record);
          messages.push({
            role: 'tool',
            toolCallId: call.id,
            content: JSON.stringify({
              ok: record.ok,
              summary: record.summary,
              output: record.output,
            }),
          });
        }
      }

      const message = `达到最大工具执行步数（${maxToolSteps}），任务未完成。`;
      emit({ type: 'assistant_message', runId, text: message, at: new Date().toISOString() });
      emit({ type: 'turn_end', runId, result: message, at: new Date().toISOString() });
      return {
        runId,
        outcome: { status: 'incomplete', reason: 'step_limit', message },
        text: message,
        toolCalls,
        events,
      };
    } catch (error) {
      if (isAbortError(error)) {
        return this.finishCancelled(runId, 'run aborted', toolCalls, events, emit);
      }
      const message = describeError(error);
      emit({ type: 'turn_error', runId, error: message, at: new Date().toISOString() });
      return {
        runId,
        outcome: { status: 'failed', code: 'internal_error', message, retryable: false },
        text: '',
        toolCalls,
        events,
      };
    }
  }

  private finishCancelled(
    runId: string,
    reason: string,
    toolCalls: ToolCallRecord[],
    events: AgentEvent[],
    emit: (event: AgentEvent) => void,
  ): RunResult {
    emit({ type: 'turn_error', runId, error: 'aborted', at: new Date().toISOString() });
    return {
      runId,
      outcome: { status: 'cancelled', reason },
      text: '',
      toolCalls,
      events,
    };
  }

  private async executeToolCall(
    call: ModelToolCall,
    request: RunRequest,
    runId: string,
    emit: (event: AgentEvent) => void,
  ): Promise<ToolCallRecord> {
    const toolName = call.function.name;
    const parsed = parseToolArguments(call.function.arguments);

    if (!parsed.ok) {
      // Invalid arguments must never reach a tool implementation.
      emit({
        type: 'tool_call_start',
        runId,
        tool: toolName,
        args: {},
        at: new Date().toISOString(),
      });
      emit({
        type: 'tool_call_result',
        runId,
        tool: toolName,
        ok: false,
        summary: parsed.message,
        at: new Date().toISOString(),
      });
      return {
        tool: toolName,
        args: {},
        ok: false,
        summary: parsed.message,
        output: null,
      };
    }

    emit({
      type: 'tool_call_start',
      runId,
      tool: toolName,
      args: parsed.args,
      at: new Date().toISOString(),
    });

    const result = await this.registry.execute(toolName, parsed.args, {
      runId,
      accountId: request.accountId,
      conversationId: request.conversationId,
      taskId: request.taskId,
      organizationId: request.organizationId,
      ownerId: request.ownerId,
      isOrgAdmin: request.isOrgAdmin,
      signal: request.signal,
      log: (message) => {
        emit({
          type: 'thinking',
          runId,
          text: message,
          at: new Date().toISOString(),
        });
      },
    });

    emit({
      type: 'tool_call_result',
      runId,
      tool: toolName,
      ok: result.ok,
      summary: result.summary,
      at: new Date().toISOString(),
    });

    return {
      tool: toolName,
      args: parsed.args,
      ok: result.ok,
      summary: result.summary,
      output: result.output,
    };
  }
}

type ParsedArguments =
  | { ok: true; args: Record<string, unknown> }
  | { ok: false; message: string };

function parseToolArguments(raw: string): ParsedArguments {
  let value: unknown;
  try {
    value = raw.trim() === '' ? {} : JSON.parse(raw);
  } catch {
    return { ok: false, message: '工具参数不是合法 JSON，已跳过执行。' };
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, message: '工具参数必须是 JSON 对象，已跳过执行。' };
  }
  return { ok: true, args: value as Record<string, unknown> };
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError');
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return 'unknown error';
}
