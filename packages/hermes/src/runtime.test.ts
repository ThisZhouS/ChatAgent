import { describe, expect, it } from 'vitest';
import { HermesAgentRuntime, MockProvider, makeTool } from './index';

describe('HermesAgentRuntime', () => {
  it('answers directly when no tool is needed', async () => {
    const runtime = new HermesAgentRuntime({ provider: new MockProvider() });
    const result = await runtime.run({ goal: '你好' });
    expect(result.text).toContain('ChatAgent');
    expect(result.toolCalls).toHaveLength(0);
  });

  it('runs a tool call and returns a final result', async () => {
    const calls: string[] = [];
    const tool = makeTool(
      {
        name: 'send_message',
        description: 'Send a message',
        parameters: { type: 'object', properties: { to: { type: 'string' }, text: { type: 'string' } } },
      },
      async (args) => {
        calls.push(String(args.to));
        return { ok: true, output: args, summary: 'sent' };
      },
    );

    const runtime = new HermesAgentRuntime({
      provider: new MockProvider(),
      tools: [tool],
    });

    const result = await runtime.run({ goal: '请发送通知给李四' });
    expect(result.toolCalls.length).toBeGreaterThan(0);
    expect(result.toolCalls[0]?.tool).toBe('send_message');
    expect(calls).toContain('self');
  });

  it('surfaces unknown tool errors instead of throwing', async () => {
    const runtime = new HermesAgentRuntime({ provider: new MockProvider() });
    const result = await runtime.registry.execute('missing', {}, {
      runId: 'r1',
      log: () => undefined,
    });
    expect(result.ok).toBe(false);
    expect(result.summary).toContain('Unknown tool');
  });
});
