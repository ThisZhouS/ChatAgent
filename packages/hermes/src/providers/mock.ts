import type {
  HermesToolDefinition,
  ModelProvider,
  ModelRequest,
  ModelResponse,
  ModelToolCall,
} from '../types';

/**
 * Deterministic offline provider. It makes the whole stack runnable without
 * any model key: it picks a sensible tool for common intents, otherwise it
 * answers directly. After a tool result is observed it produces a final text.
 */
export class MockProvider implements ModelProvider {
  readonly name = 'mock';

  async complete(request: ModelRequest, _signal?: AbortSignal): Promise<ModelResponse> {
    const hasToolResult = request.messages.some((message) => message.role === 'tool');
    if (hasToolResult) {
      const toolMessage = [...request.messages].reverse().find((m) => m.role === 'tool');
      const parsed = parseToolResult(toolMessage?.content ?? '');
      return {
        content: parsed.summary ? `已完成：${parsed.summary}` : this.finalAnswer(toolMessage?.content ?? ''),
        toolCalls: [],
        finishReason: 'stop',
      };
    }

    const lastUser = [...request.messages].reverse().find((m) => m.role === 'user');
    const text = lastUser?.content ?? '';
    const tool = this.pickTool(text, request.tools);

    if (tool) {
      return {
        content: '',
        toolCalls: [this.toolCall(tool.name, this.sampleArgs(tool.name, text))],
        finishReason: 'tool_calls',
      };
    }

    return {
      content: this.finalAnswer(text),
      toolCalls: [],
      finishReason: 'stop',
    };
  }

  private pickTool(text: string, tools: HermesToolDefinition[]): HermesToolDefinition | undefined {
    const lower = text.toLowerCase();
    const find = (...names: string[]) => tools.find((tool) => names.includes(tool.name));
    // Asking back is checked first: a request that openly says it lacks information should
    // not be answered by guessing at a document tool.
    if (/请向我确认|信息不足|需要澄清|clarify|ask me/.test(lower)) {
      return find('ask_user');
    }
    if (/word|docx|文档|报告|周报|日报|月报|汇报/.test(lower)) {
      return find('create_word_document') ?? find('parse_document');
    }
    if (/excel|xlsx|csv|表格|工作簿/.test(lower)) {
      return find('create_excel_document') ?? find('parse_document');
    }
    if (/parse|解析|extract|提取|read/.test(lower)) {
      return find('parse_document');
    }
    if (/forward|转发/.test(lower)) {
      return find('forward_file') ?? find('send_message');
    }
    if (/send|发送|通知|提醒/.test(lower)) {
      return find('send_message');
    }
    return undefined;
  }

  private toolCall(name: string, args: Record<string, unknown>): ModelToolCall {
    return {
      id: crypto.randomUUID(),
      type: 'function',
      function: {
        name,
        arguments: JSON.stringify(args),
      },
    };
  }

  private sampleArgs(name: string, text: string): Record<string, unknown> {
    switch (name) {
      case 'ask_user':
        return { question: text || '请补充必要的信息。' };
      case 'create_word_document':
        return {
          title: 'ChatAgent 工作说明',
          paragraphs: [text || '由 ChatAgent 生成的企业工作文档。'],
          table: {
            header: ['项目', '状态'],
            rows: [
              ['任务', '已完成'],
              ['执行者', 'ChatAgent'],
            ],
          },
        };
      case 'create_excel_document':
        return {
          fileName: 'chatagent-report.xlsx',
          sheets: [
            {
              name: 'Sheet1',
              header: ['项目', '值'],
              rows: [
                ['任务', text || 'ChatAgent 任务'],
                ['状态', '已完成'],
              ],
            },
          ],
        };
      case 'parse_document':
        return { fileName: 'latest' };
      case 'send_message':
        return { to: 'self', text: text || 'ChatAgent 消息' };
      case 'forward_file':
        return { to: 'self', fileName: 'latest' };
      default:
        return {};
    }
  }

  private finalAnswer(input: string): string {
    // Strip @mentions so a group summon does not echo the mention prefix back.
    const text = input.replace(/@[\w一-龥·-]+\s*/g, '').trim();

    if (/完成|completed/i.test(text)) {
      return '任务已完成，相关产物与结果已生成，可在工作台查看。';
    }
    if (/你好|hello|hi|在吗/i.test(text)) {
      return '你好，我是 ChatAgent。你可以让我处理 Word/Excel 文档、转发文件或执行任务。';
    }
    if (text === '') {
      return '已收到，请告诉我需要完成的具体工作。';
    }
    if (text.length <= 40) {
      return `收到：「${text}」。需要产出文件时，请说明「生成 Word/Excel」。`;
    }
    return `已收到你的请求（${text.slice(0, 40)}…）。如果需要产出文件，请说明「生成 Word/Excel」。`;
  }
}

function parseToolResult(content: string): { summary?: string } {
  try {
    const parsed = JSON.parse(content) as { summary?: unknown };
    return { summary: typeof parsed.summary === 'string' ? parsed.summary : undefined };
  } catch {
    return {};
  }
}
