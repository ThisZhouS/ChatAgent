import type { AgentEvent } from '@chatagent/contracts';

export type JsonSchema = Record<string, unknown>;

export interface HermesToolDefinition {
  name: string;
  description: string;
  parameters: JsonSchema;
}

export interface ModelToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

export interface ModelMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  name?: string;
  toolCallId?: string;
  toolCalls?: ModelToolCall[];
}

export interface ModelRequest {
  messages: ModelMessage[];
  tools: HermesToolDefinition[];
  temperature?: number;
  maxTokens?: number;
}

export interface ModelResponse {
  content: string;
  toolCalls: ModelToolCall[];
  finishReason: 'stop' | 'tool_calls' | 'length';
}

export interface ModelProvider {
  readonly name: string;
  complete(request: ModelRequest, signal?: AbortSignal): Promise<ModelResponse>;
}

export interface ToolContext {
  runId: string;
  accountId?: string;
  conversationId?: string;
  taskId?: string;
  /**
   * Server-trusted execution scope. Never populated from model output or
   * free-form tool arguments.
   */
  organizationId?: string;
  ownerId?: string;
  /** True when the requester is an organization owner/admin. */
  isOrgAdmin?: boolean;
  signal?: AbortSignal;
  log(message: string, data?: Record<string, unknown>): void;
}

export interface ToolResult {
  ok: boolean;
  output: unknown;
  summary: string;
}

export interface Tool {
  definition: HermesToolDefinition;
  execute(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult>;
}

export interface ToolCallRecord {
  tool: string;
  args: Record<string, unknown>;
  ok: boolean;
  summary: string;
  output: unknown;
}

export interface Memory {
  append(message: ModelMessage): void;
  list(): ModelMessage[];
  clear(): void;
}

export interface HermesRuntimeConfig {
  maxToolSteps?: number;
  temperature?: number;
  maxTokens?: number;
  extraSystemPrompt?: string;
}

export interface RunRequest {
  goal: string;
  history?: ModelMessage[];
  account?: {
    displayName: string;
    persona: string;
  };
  accountId?: string;
  conversationId?: string;
  taskId?: string;
  /** Caller-supplied run id so artifacts can be bound before the run starts. */
  runId?: string;
  /** Server-trusted execution scope. */
  organizationId?: string;
  ownerId?: string;
  /** True when the requester is an organization owner/admin. */
  isOrgAdmin?: boolean;
  signal?: AbortSignal;
  onEvent?: (event: AgentEvent) => void;
}

export type RunFailureCode =
  | 'provider_error'
  | 'invalid_tool_arguments'
  | 'empty_response'
  | 'internal_error';

/**
 * Structured execution result. A model `stop` reason is not proof of business
 * success; callers must branch on `status`.
 */
export type RunOutcome =
  | { status: 'succeeded'; summary: string }
  | { status: 'failed'; code: RunFailureCode; message: string; retryable: boolean }
  | { status: 'cancelled'; reason: string }
  | { status: 'incomplete'; reason: 'step_limit' | 'output_limit'; message: string };

export interface RunResult {
  runId: string;
  outcome: RunOutcome;
  /** Assistant text when the run produced one; empty string otherwise. */
  text: string;
  toolCalls: ToolCallRecord[];
  events: AgentEvent[];
}
