import type { HermesToolDefinition, Tool, ToolContext, ToolResult } from './types';

export class ToolRegistry {
  private readonly tools = new Map<string, Tool>();

  register(tool: Tool): this {
    if (this.tools.has(tool.definition.name)) {
      throw new Error(`Tool already registered: ${tool.definition.name}`);
    }
    this.tools.set(tool.definition.name, tool);
    return this;
  }

  registerAll(tools: Tool[]): this {
    for (const tool of tools) this.register(tool);
    return this;
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  listDefinitions(): HermesToolDefinition[] {
    return [...this.tools.values()].map((tool) => tool.definition);
  }

  async execute(
    name: string,
    args: Record<string, unknown>,
    context: ToolContext,
  ): Promise<ToolResult> {
    const tool = this.tools.get(name);
    if (!tool) {
      return {
        ok: false,
        output: null,
        summary: `Unknown tool: ${name}`,
      };
    }
    try {
      return await tool.execute(args, context);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        ok: false,
        output: null,
        summary: `Tool ${name} failed: ${message}`,
      };
    }
  }
}

export function makeTool(
  definition: HermesToolDefinition,
  execute: Tool['execute'],
): Tool {
  return { definition, execute };
}
