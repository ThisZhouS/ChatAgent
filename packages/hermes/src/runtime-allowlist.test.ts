/**
 * The tool surface is a per-run decision, not a request to the model.
 *
 * MockProvider calls send_message whenever the goal mentions sending, which makes it a
 * convenient adversary: with a chat-tier allowlist the call must be refused and the
 * tool's own executor must never run.
 */
import { describe, expect, it } from 'vitest';
import { HermesAgentRuntime, MockProvider, makeTool } from './index';
import type { ModelProvider, ModelRequest, ModelResponse } from './types';

/**
 * A deliberately misbehaving provider: it ignores the tool list it was given and keeps
 * asking for send_message. Real models do this too (stale context, prompt injection in a
 * document), so the refusal has to be enforced where the tool would run.
 */
class RogueProvider implements ModelProvider {
  readonly name = 'rogue';
  private calls = 0;

  async complete(request: ModelRequest): Promise<ModelResponse> {
    if (request.messages.some((message) => message.role === 'tool')) {
      return { content: 'done', toolCalls: [], finishReason: 'stop' };
    }
    this.calls += 1;
    return {
      content: '',
      toolCalls: [
        {
          id: `rogue-${this.calls}`,
          type: 'function',
          function: { name: 'send_message', arguments: JSON.stringify({ to: 'self', text: 'hi' }) },
        },
      ],
      finishReason: 'tool_calls',
    };
  }
}

function sendTool(calls: string[]) {
  return makeTool(
    {
      name: 'send_message',
      description: 'Send a message to a colleague',
      parameters: {
        type: 'object',
        properties: { to: { type: 'string' }, text: { type: 'string' } },
      },
    },
    async (args) => {
      calls.push(String(args.to));
      return { ok: true, output: args, summary: 'sent' };
    },
  );
}

function readTool(calls: string[]) {
  return makeTool(
    {
      name: 'parse_document',
      description: 'Read a document',
      parameters: { type: 'object', properties: {} },
    },
    async () => {
      calls.push('parse_document');
      return { ok: true, output: { text: 'ok' }, summary: 'parsed' };
    },
  );
}

describe('per-run tool allowlist', () => {
  it('refuses a tool outside the allowlist and never executes it', async () => {
    const calls: string[] = [];
    const runtime = new HermesAgentRuntime({
      provider: new RogueProvider(),
      tools: [sendTool(calls), readTool(calls)],
    });

    const result = await runtime.run({
      goal: '请发送通知给李四',
      allowedTools: ['parse_document'],
    });

    const refused = result.toolCalls.find((call) => call.tool === 'send_message');
    expect(refused, 'the model asked for a switched-off tool').toBeDefined();
    expect(refused?.ok).toBe(false);
    expect(refused?.summary).toContain('not available in this run');
    // The executor is the side effect: it must not have run at all.
    expect(calls).toEqual([]);
  });

  it('does not advertise switched-off tools to the model', async () => {
    const seen: string[][] = [];
    class SpyProvider extends MockProvider {
      override async complete(request: never) {
        const typed = request as unknown as { tools?: Array<{ name: string }> };
        seen.push((typed.tools ?? []).map((tool) => tool.name));
        return super.complete(request);
      }
    }
    const runtime = new HermesAgentRuntime({
      provider: new SpyProvider(),
      tools: [sendTool([]), readTool([])],
    });

    await runtime.run({ goal: '你好', allowedTools: ['parse_document'] });
    expect(seen.length).toBeGreaterThan(0);
    expect(seen[0]).toEqual(['parse_document']);
  });

  it('keeps every tool when no allowlist is given', async () => {
    const calls: string[] = [];
    const runtime = new HermesAgentRuntime({
      provider: new MockProvider(),
      tools: [sendTool(calls), readTool(calls)],
    });
    const result = await runtime.run({ goal: '请发送通知给李四' });
    expect(result.toolCalls.some((call) => call.tool === 'send_message' && call.ok)).toBe(true);
    expect(calls).toContain('self');
  });

  it('states the per-run rule text and the hard-coded boundaries in the prompt', async () => {
    const prompts: string[] = [];
    class PromptSpy extends MockProvider {
      override async complete(request: never) {
        const typed = request as unknown as { messages?: Array<{ role: string; content: string }> };
        const system = (typed.messages ?? []).find((message) => message.role === 'system');
        if (system) prompts.push(system.content);
        return super.complete(request);
      }
    }
    const runtime = new HermesAgentRuntime({ provider: new PromptSpy(), tools: [readTool([])] });
    await runtime.run({
      goal: '你好',
      extraSystemPrompt: 'CHAT tier: tools that send or write files are switched off.',
    });
    expect(prompts[0]).toContain('CHAT tier');
    expect(prompts[0]).toContain('Host-enforced boundaries');
  });
});
