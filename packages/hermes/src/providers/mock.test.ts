import { describe, expect, it } from 'vitest';
import { HermesAgentRuntime } from '../runtime';
import { makeTool } from '../tools';
import { MockProvider } from './mock';

describe('MockProvider replies', () => {
  it('strips group mentions instead of echoing them back', async () => {
    const runtime = new HermesAgentRuntime({ provider: new MockProvider() });

    const result = await runtime.run({ goal: '@ChatAgent 助理 你好' });

    expect(result.text).toContain('你好');
    expect(result.text).not.toContain('@ChatAgent');
  });

  it('acknowledges a short instruction without pretending to have done work', async () => {
    const runtime = new HermesAgentRuntime({ provider: new MockProvider() });

    const result = await runtime.run({ goal: '跟进一下供应商报价' });

    expect(result.outcome.status).toBe('succeeded');
    expect(result.text).toContain('收到');
    expect(result.text).not.toContain('已完成');
  });

  it('summarises a tool result instead of dumping raw JSON', async () => {
    const tool = makeTool(
      {
        name: 'send_message',
        description: 'send',
        parameters: { type: 'object', properties: { to: { type: 'string' } } },
      },
      async () => ({ ok: true, output: { delivered: true }, summary: 'sent to self' }),
    );
    const runtime = new HermesAgentRuntime({ provider: new MockProvider(), tools: [tool] });

    const result = await runtime.run({ goal: '请发送通知给李四' });

    expect(result.toolCalls.length).toBeGreaterThan(0);
    expect(result.text).not.toContain('{"ok"');
  });
});
