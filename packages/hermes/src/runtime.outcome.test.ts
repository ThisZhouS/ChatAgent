import { describe, expect, it } from 'vitest';
import { HermesAgentRuntime } from './runtime';
import { makeTool } from './tools';
import type { ModelProvider, ModelRequest, ModelResponse } from './types';

function providerReturning(...responses: ModelResponse[]): ModelProvider {
  let index = 0;
  return {
    name: 'stub',
    async complete(_request: ModelRequest): Promise<ModelResponse> {
      const response = responses[Math.min(index, responses.length - 1)];
      index += 1;
      if (!response) throw new Error('no stub response configured');
      return response;
    },
  };
}

describe('HermesAgentRuntime outcomes', () => {
  it('reports provider failure as a failed outcome instead of empty success', async () => {
    const provider: ModelProvider = {
      name: 'throwing',
      async complete() {
        throw new Error('gateway 502');
      },
    };
    const runtime = new HermesAgentRuntime({ provider });

    const result = await runtime.run({ goal: 'hello' });

    expect(result.outcome.status).toBe('failed');
    if (result.outcome.status === 'failed') {
      expect(result.outcome.code).toBe('provider_error');
      expect(result.outcome.retryable).toBe(true);
    }
    expect(result.text).toBe('');
  });

  it('reports an empty model response as failed, never completed', async () => {
    const runtime = new HermesAgentRuntime({
      provider: providerReturning({ content: '   ', toolCalls: [], finishReason: 'stop' }),
    });

    const result = await runtime.run({ goal: 'hello' });

    expect(result.outcome.status).toBe('failed');
    if (result.outcome.status === 'failed') {
      expect(result.outcome.code).toBe('empty_response');
    }
  });

  it('maps truncated output to incomplete', async () => {
    const runtime = new HermesAgentRuntime({
      provider: providerReturning({ content: 'partial answer', toolCalls: [], finishReason: 'length' }),
    });

    const result = await runtime.run({ goal: 'long answer' });

    expect(result.outcome.status).toBe('incomplete');
    if (result.outcome.status === 'incomplete') {
      expect(result.outcome.reason).toBe('output_limit');
    }
  });

  it('maps tool-step exhaustion to incomplete', async () => {
    const tool = makeTool(
      {
        name: 'noop',
        description: 'noop',
        parameters: { type: 'object', properties: {} },
      },
      async () => ({ ok: true, output: null, summary: 'noop done' }),
    );
    const runtime = new HermesAgentRuntime({
      provider: providerReturning({
        content: '',
        toolCalls: [
          { id: 'c1', type: 'function', function: { name: 'noop', arguments: '{}' } },
        ],
        finishReason: 'tool_calls',
      }),
      tools: [tool],
      config: { maxToolSteps: 2 },
    });

    const result = await runtime.run({ goal: 'loop forever' });

    expect(result.outcome.status).toBe('incomplete');
    if (result.outcome.status === 'incomplete') {
      expect(result.outcome.reason).toBe('step_limit');
    }
  });

  it('does not execute a tool when arguments are not valid JSON', async () => {
    let executed = 0;
    const tool = makeTool(
      {
        name: 'dangerous',
        description: 'side effect',
        parameters: { type: 'object', properties: {} },
      },
      async () => {
        executed += 1;
        return { ok: true, output: null, summary: 'executed' };
      },
    );
    const runtime = new HermesAgentRuntime({
      provider: providerReturning(
        {
          content: '',
          toolCalls: [
            { id: 'c1', type: 'function', function: { name: 'dangerous', arguments: '{not json' } },
          ],
          finishReason: 'tool_calls',
        },
        { content: 'recovered', toolCalls: [], finishReason: 'stop' },
      ),
      tools: [tool],
    });

    const result = await runtime.run({ goal: 'run tool' });

    expect(executed).toBe(0);
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0]?.ok).toBe(false);
    expect(result.outcome.status).toBe('succeeded');
  });

  it('rejects non-object tool arguments without executing', async () => {
    let executed = 0;
    const tool = makeTool(
      {
        name: 'dangerous',
        description: 'side effect',
        parameters: { type: 'object', properties: {} },
      },
      async () => {
        executed += 1;
        return { ok: true, output: null, summary: 'executed' };
      },
    );
    const runtime = new HermesAgentRuntime({
      provider: providerReturning(
        {
          content: '',
          toolCalls: [{ id: 'c1', type: 'function', function: { name: 'dangerous', arguments: '["x"]' } }],
          finishReason: 'tool_calls',
        },
        { content: 'done', toolCalls: [], finishReason: 'stop' },
      ),
      tools: [tool],
    });

    await runtime.run({ goal: 'run tool' });

    expect(executed).toBe(0);
  });

  it('propagates abort as cancelled', async () => {
    const controller = new AbortController();
    const provider: ModelProvider = {
      name: 'abortable',
      async complete(_request, signal) {
        return await new Promise<ModelResponse>((_resolve, reject) => {
          signal?.addEventListener('abort', () => {
            const error = new Error('aborted');
            error.name = 'AbortError';
            reject(error);
          });
        });
      },
    };
    const runtime = new HermesAgentRuntime({ provider });

    const pending = runtime.run({ goal: 'wait', signal: controller.signal });
    controller.abort();
    const result = await pending;

    expect(result.outcome.status).toBe('cancelled');
  });
});
