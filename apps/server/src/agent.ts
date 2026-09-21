import type { ApprovalAction, OutboxRecord } from '@chatagent/contracts';
import type { ModelProvider, Tool, ToolContext } from '@chatagent/hermes';
import { MockProvider, OpenAICompatibleProvider, makeTool } from '@chatagent/hermes';
import { createDocumentTools } from '@chatagent/document';
import type { ArtifactScope } from '@chatagent/document';
import type { ImGateway, SendResult } from '@chatagent/im-gateway';
import type { ServerConfig } from './config';
import { hasModelConfig } from './config';
import type { MemberDirectory } from './auth';
import {
  computeActionDigest,
  computeArtifactVersion,
  evaluateApproval,
  stepKeyFor,
  type ApprovalScope,
  type ApprovalStore,
  type OutboxStore,
} from './approvals';
import type { AccountStore, ArtifactStore, UploadedFileStore } from './stores';

export function buildProvider(config: ServerConfig): ModelProvider {
  if (hasModelConfig(config)) {
    return new OpenAICompatibleProvider({
      baseUrl: config.model.baseUrl!,
      apiKey: config.model.apiKey!,
      model: config.model.modelName!,
      temperature: 0.2,
      maxTokens: 2048,
    });
  }
  return new MockProvider();
}

export function buildDocumentTools(
  uploads: UploadedFileStore,
  artifacts: ArtifactStore,
): Tool[] {
  return createDocumentTools({
    resolveFile: async (ref, context) => {
      const organizationId = context.organizationId;
      if (!organizationId) return undefined;
      const file = await uploads.resolveInOrg(ref, organizationId, {
        ownerId: context.ownerId,
        isAdmin: context.isOrgAdmin,
      });
      return file ? { id: file.id, name: file.name, buffer: file.buffer } : undefined;
    },
    saveArtifact: async (buffer, name, mimeType, scope: ArtifactScope) => {
      const artifact = await artifacts.save(buffer, name, mimeType, {
        organizationId: scope.organizationId,
        ownerId: scope.ownerId,
        taskId: scope.taskId,
        runId: scope.runId,
      });
      // Never hand the server filesystem path back to the model or the client.
      return {
        id: artifact.id,
        name: artifact.name,
        mimeType: artifact.mimeType,
        url: artifact.url,
      };
    },
  });
}

export interface MessageToolDependencies {
  accounts: AccountStore;
  gateways: ImGateway[];
  uploads: UploadedFileStore;
  artifacts: ArtifactStore;
  approvals: ApprovalStore;
  outbox: OutboxStore;
  directory: MemberDirectory;
  approvalTtlSeconds: number;
}

export function buildMessageTools(deps: MessageToolDependencies): Tool[] {
  const { accounts, gateways, uploads, artifacts, approvals, outbox, directory } = deps;

  /**
   * Asking the human instead of guessing.
   *
   * The product rule is "if the intent cannot be determined, ask in the conversation". This
   * tool has no side effect: it reports the question, the host posts it as the assistant's
   * message and the task waits for the reply (see service.runTask / sendNativeMessage).
   */
  const ask = makeTool(
    {
      name: 'ask_user',
      description:
        'Ask the requester one clarifying question when the request cannot be carried out without more information. Use it instead of guessing; the task waits for the answer in the conversation.',
      parameters: {
        type: 'object',
        properties: {
          question: {
            type: 'string',
            description: 'One concrete question the requester can answer in one message.',
          },
        },
        required: ['question'],
      },
    },
    async (args) => {
      const question = readNonEmptyString(args.question);
      if (!question) return failure('ask_user 需要非空的 question。');
      return {
        ok: false,
        // `ok: false` stops the model from treating the question as a completed step; the
        // output is the marker the host looks for.
        output: { clarificationRequired: { question: question.slice(0, 500) } },
        summary: `需要补充信息：${question.slice(0, 200)}`,
      };
    },
  );

  const send = makeTool(
    {
      name: 'send_message',
      description:
        'Send a text message to a member of the organization (use "self" for the requester) through the built-in native channel. Requires an approved action.',
      parameters: {
        type: 'object',
        properties: {
          to: { type: 'string', description: 'Recipient id inside the current conversation.' },
          text: { type: 'string' },
          chatType: { type: 'string', enum: ['direct', 'group'] },
        },
        required: ['to', 'text'],
      },
    },
    async (args, context) => {
      const prepared = await prepare(deps, context, args, 'message');
      if (!prepared.ok) return prepared.result;

      const text = readNonEmptyString(args.text);
      if (!text) return failure('send_message 需要非空的 text。');

      const action: ApprovalAction = {
        tool: 'send_message',
        target: prepared.target,
        chatType: prepared.chatType,
        kind: 'message',
        text,
      };

      return deliver(deps, {
        context,
        action,
        send: () =>
          prepared.gateway.sendMessage({
            accountId: prepared.accountId,
            to: prepared.target,
            chatType: prepared.chatType,
            text,
            requesterId: context.ownerId,
            conversationId: context.conversationId,
          }),
      });
    },
  );

  const forward = makeTool(
    {
      name: 'forward_file',
      description:
        'Forward an uploaded file or generated artifact that belongs to the current task to an organization member (use "self" for the requester). Requires an approved action.',
      parameters: {
        type: 'object',
        properties: {
          to: { type: 'string' },
          fileName: { type: 'string', description: 'Uploaded file name, or generated artifact id.' },
          fileId: { type: 'string' },
          chatType: { type: 'string', enum: ['direct', 'group'] },
        },
        required: ['to'],
      },
    },
    async (args, context) => {
      const prepared = await prepare(deps, context, args, 'file');
      if (!prepared.ok) return prepared.result;

      const ref = readNonEmptyString(args.fileName) ?? readNonEmptyString(args.fileId);
      if (!ref) return failure('forward_file 需要 fileName 或 fileId。');

      const artifact = await artifacts.getMeta(ref);
      if (artifact) {
        if (!isArtifactInScope(artifact, context)) {
          return failure('该产物不属于当前任务或组织，已拒绝转发。');
        }
        const action: ApprovalAction = {
          tool: 'forward_file',
          target: prepared.target,
          chatType: prepared.chatType,
          kind: 'file',
          artifactId: artifact.id,
          artifactVersion: computeArtifactVersion(artifact),
          artifactName: artifact.name,
        };
        return deliver(deps, {
          context,
          action,
          send: () =>
            prepared.gateway.sendFile({
              accountId: prepared.accountId,
              to: prepared.target,
              chatType: prepared.chatType,
              name: artifact.name,
              mimeType: artifact.mimeType,
              url: artifact.url,
              artifactId: artifact.id,
              requesterId: context.ownerId,
              conversationId: context.conversationId,
            }),
        });
      }

      const uploaded = context.organizationId
        ? await uploads.resolveInOrg(ref, context.organizationId, {
            ownerId: context.ownerId,
            isAdmin: context.isOrgAdmin,
          })
        : undefined;
      if (!uploaded) {
        return failure(`No accessible file found for reference: ${ref}`);
      }
      if (uploaded.organizationId !== context.organizationId) {
        return failure('该上传文件不属于当前组织，已拒绝转发。');
      }
      const action: ApprovalAction = {
        tool: 'forward_file',
        target: prepared.target,
        chatType: prepared.chatType,
        kind: 'file',
        artifactId: uploaded.id,
        artifactVersion: computeArtifactVersion(uploaded),
        artifactName: uploaded.name,
      };
      return deliver(deps, {
        context,
        action,
        send: () =>
          prepared.gateway.sendFile({
            accountId: prepared.accountId,
            to: prepared.target,
            chatType: prepared.chatType,
            name: uploaded.name,
            mimeType: uploaded.mimeType,
            url: `/api/files/${uploaded.id}`,
            artifactId: uploaded.id,
            requesterId: context.ownerId,
            conversationId: context.conversationId,
          }),
      });
    },
  );

  return [send, forward, ask];
}

type Prepared =
  | {
      ok: true;
      gateway: ImGateway;
      accountId: string;
      target: string;
      chatType: 'direct' | 'group';
    }
  | { ok: false; result: ToolOutcome };

interface ToolOutcome {
  ok: boolean;
  output: unknown;
  summary: string;
}

async function prepare(
  deps: MessageToolDependencies,
  context: ToolContext,
  args: Record<string, unknown>,
  kind: 'message' | 'file',
): Promise<Prepared> {
  const account = context.accountId ? await deps.accounts.get(context.accountId) : undefined;
  if (!account) return { ok: false, result: failure('Unknown AI account for this run.') };

  const gateway = resolveDeliveryGateway(deps.gateways, account.channel);
  if (!gateway) {
    return {
      ok: false,
      result: failure(`No delivery channel configured for account channel ${account.channel}.`),
    };
  }

  const target = readNonEmptyString(args.to);
  if (!target) {
    return { ok: false, result: failure(`${kind === 'file' ? 'forward_file' : 'send_message'} 需要非空的 to。`) };
  }
  if (!context.conversationId) {
    return { ok: false, result: failure('缺少会话上下文，已拒绝外发。') };
  }
  if (!context.organizationId || !context.ownerId) {
    return { ok: false, result: failure('缺少服务端可信的执行范围，已拒绝外发。') };
  }

  return {
    ok: true,
    gateway,
    accountId: account.id,
    target,
    chatType: args.chatType === 'group' ? 'group' : 'direct',
  };
}

interface DeliverInput {
  context: ToolContext;
  action: ApprovalAction;
  send: () => Promise<SendResult>;
}

/**
 * Single side-effect path: idempotency lookup -> approval gate -> gateway call
 * -> persistent outbox receipt. Neither the model nor the caller can skip a
 * step; a rejected gate performs zero gateway calls.
 */
async function deliver(deps: MessageToolDependencies, input: DeliverInput): Promise<ToolOutcome> {
  const { context, action, send } = input;
  const scope: ApprovalScope = {
    organizationId: context.organizationId ?? '',
    requesterId: context.ownerId ?? '',
    taskId: context.taskId,
    runId: context.runId,
  };

  const digest = computeActionDigest(action);
  const stepKey = stepKeyFor(scope.taskId, scope.runId ?? context.runId, digest);

  // 1) Idempotency: a recorded side effect is never repeated.
  const existing = await deps.outbox.findByStepKey(stepKey);
  if (existing && existing.state !== 'failed') {
    return replay(existing);
  }

  // 2) Approval gate: re-validated at send time (expiry, membership, role).
  const approval = await deps.approvals.findApproved(scope, digest);
  const evaluation = await evaluateApproval(approval, scope, deps.directory, stepKey);
  if (!evaluation.ok) {
    const pending = await deps.approvals.ensurePending({
      ...scope,
      action,
      digest,
      ttlSeconds: deps.approvalTtlSeconds,
    });
    return {
      ok: false,
      output: {
        approvalRequired: {
          approvalId: pending.id,
          digest,
          stepKey,
          reason: evaluation.reason,
        },
      },
      summary: `需要人工审批后才能执行（${evaluation.reason}），尚未调用网关。`,
    };
  }

  // 3) Claim the approval atomically *before* the side effect. A second
  //    concurrent run with the same digest loses this race and sends nothing.
  const claimed = await deps.approvals.claim(evaluation.approval.id, stepKey);
  if (!claimed) {
    const pending = await deps.approvals.ensurePending({
      ...scope,
      action,
      digest,
      ttlSeconds: deps.approvalTtlSeconds,
    });
    return {
      ok: false,
      output: {
        approvalRequired: {
          approvalId: pending.id,
          digest,
          stepKey,
          reason: 'approval_already_consumed',
        },
      },
      summary: '该审批已被其它任务使用，尚未调用网关；请重新审批。',
    };
  }

  // 4) Write-ahead intent, then execute once, then persist the receipt.
  //    A crash between the call and the receipt leaves `unknown`, which is
  //    never auto-resent — better an operator reconciling than a double send.
  const now = new Date().toISOString();
  const intent: OutboxRecord = {
    id: existing?.id ?? crypto.randomUUID(),
    stepKey,
    organizationId: scope.organizationId,
    ownerId: scope.requesterId,
    taskId: scope.taskId,
    runId: scope.runId,
    tool: action.tool,
    target: action.target,
    chatType: action.chatType,
    kind: action.kind,
    digest,
    approvalId: evaluation.approval.id,
    state: 'unknown',
    attempts: (existing?.attempts ?? 0) + 1,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  await deps.outbox.save(intent);

  let result: SendResult;
  try {
    result = await send();
  } catch (error) {
    // The transport itself threw: the outcome is unknown, but the receipt and
    // the approval must not be left in limbo — record it and release the claim
    // so the same approval can be retried deliberately.
    const message = error instanceof Error ? error.message : 'gateway call threw';
    const failedRecord: OutboxRecord = {
      ...intent,
      state: 'failed',
      error: message,
      updatedAt: new Date().toISOString(),
    };
    await deps.outbox.save(failedRecord);
    await deps.approvals.release(evaluation.approval.id, stepKey);
    return success(failedRecord, { ok: false, state: 'failed', error: message });
  }

  const record: OutboxRecord = {
    ...intent,
    state: result.state,
    gatewayMessageId: result.gatewayMessageId,
    error: result.error,
    updatedAt: new Date().toISOString(),
  };
  await deps.outbox.save(record);

  if (result.state === 'failed') {
    // A definite failure (non-2xx / business error) may be retried with the
    // same approval; give the claim back so the retry is possible.
    await deps.approvals.release(evaluation.approval.id, stepKey);
  }

  return success(record, result);
}

function success(record: OutboxRecord, result: SendResult): ToolOutcome {
  const ok = result.state === 'accepted' || result.state === 'delivered';
  const summary =
    result.state === 'simulated'
      ? `未配置真实投递通道，仅记录 simulated 外发（${record.target}），不视为已送达。`
      : result.state === 'unknown'
        ? `投递结果未知（${record.target}），已停止自动重试，等待人工对账。`
        : ok
          ? `已提交网关（${result.state}）：${record.target}。`
          : `外发失败（${record.target}）：${result.error ?? 'unknown error'}`;

  return {
    ok,
    output: {
      delivery: {
        state: result.state,
        replayed: false,
        stepKey: record.stepKey,
        approvalId: record.approvalId,
        gatewayMessageId: result.gatewayMessageId,
        attempts: record.attempts,
      },
    },
    summary,
  };
}

function replay(record: OutboxRecord): ToolOutcome {
  const ok = record.state === 'accepted' || record.state === 'delivered';
  return {
    ok,
    output: {
      delivery: {
        state: record.state,
        replayed: true,
        stepKey: record.stepKey,
        approvalId: record.approvalId,
        gatewayMessageId: record.gatewayMessageId,
        attempts: record.attempts,
      },
    },
    summary: `该外发动作已存在记录（${record.state}），未重复调用网关。`,
  };
}

function failure(summary: string): ToolOutcome {
  return { ok: false, output: null, summary };
}

function isArtifactInScope(
  artifact: { organizationId: string; ownerId: string; taskId?: string },
  context: { organizationId?: string; ownerId?: string; taskId?: string },
): boolean {
  if (!context.organizationId || artifact.organizationId !== context.organizationId) return false;
  if (context.taskId && artifact.taskId === context.taskId) return true;
  return Boolean(context.ownerId) && artifact.ownerId === context.ownerId;
}

/**
 * Delivery channel selection:
 * 1. exact channel match, except the local echo gateway;
 * 2. the built-in native channel (standalone delivery to a member's inbox);
 * 3. the exact match as a last resort (tests and mock-only deployments).
 */
export function resolveDeliveryGateway(
  gateways: ImGateway[],
  channel: string,
): ImGateway | undefined {
  const exact = gateways.find((gateway) => gateway.channel === channel);
  if (exact && exact.channel !== 'memory') return exact;
  const native = gateways.find((gateway) => gateway.channel === 'native');
  if (native) return native;
  return exact;
}

function readNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}
