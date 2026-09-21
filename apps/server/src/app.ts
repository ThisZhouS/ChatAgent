import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import type { ServerResponse } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyInstance, type FastifyReply } from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import type { ChatMessage, NativeEvent, Principal, TaskEvent } from '@chatagent/contracts';
import {
  createAccountSchema,
  createGroupSchema,
  createTaskSchema,
  generateExcelSchema,
  generateWordSchema,
  inboundMessageSchema,
  createMemberSchema,
  localTaskSyncSchema,
  loginSchema,
  nativeMessageSchema,
  openConversationSchema,
  updateAccountSchema,
  updateMemberSchema,
} from '@chatagent/contracts';
import { MemoryImGateway, WebhookImGateway } from '@chatagent/im-gateway';
import {
  normalizeDingTalk,
  normalizeFeishu,
  normalizeQQ,
  normalizeWechatWork,
} from '@chatagent/im-gateway';
import { HermesAgentRuntime } from '@chatagent/hermes';
import { buildDocumentTools, buildMessageTools, buildProvider } from './agent';
import { redactEventPayloads } from './service';
import { ApprovalStore, OutboxStore } from './approvals';
import { AuditLog } from './audit';
import {
  ANONYMOUS_PRINCIPAL,
  isAuthenticated,
  MemberDirectory,
  readBearerToken,
  readCookieToken,
  resolvePrincipal,
  SESSION_COOKIE,
  type RequestHeaders,
} from './auth';
import { DEFAULT_RATE_LIMITS, RateLimiter } from './rate-limit';
import { NativeEventHub, StreamLimiter } from './events';
import { hashToken as hashTokenForSession } from './auth';
import { NativeImGateway } from './native-gateway';
import type { ServerConfig } from './config';
import { loadConfig } from './config';
import { ChatAgentService, ServiceError } from './service';
import { AgentIntakeGate } from './agent-intake';
import {
  AccountStore,
  AgentIntakeStore,
  ArtifactStore,
  ConversationStore,
  LocalTaskReceiptStore,
  MessageStore,
  ReadStateStore,
  SessionStore,
  UploadedFileStore,
  WebhookDedupeStore,
} from './stores';

declare module 'fastify' {
  interface FastifyRequest {
    principal: Principal;
    rawBody?: Buffer;
  }
}

/** Applied to streamed responses, which bypass the onSend hook. */
const STREAM_SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'same-origin',
  'Permissions-Policy': 'geolocation=(), microphone=(), camera=()',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Content-Security-Policy':
    "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; font-src 'self' data:; object-src 'none'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
} as const;

export async function buildApp(config: ServerConfig = loadConfig()): Promise<FastifyInstance> {
  const app = Fastify({ logger: { level: 'info' } });

  // Keep the raw body so webhook HMAC verification can run on exact bytes.
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'buffer' },
    (request, body, done) => {
      const raw = body as Buffer;
      request.rawBody = raw;
      if (raw.length === 0) {
        done(null, undefined);
        return;
      }
      try {
        done(null, JSON.parse(raw.toString('utf8')));
      } catch (error) {
        done(error as Error, undefined);
      }
    },
  );

  await app.register(cors, { origin: config.webOrigin, credentials: true });
  await app.register(multipart, { limits: { fileSize: 20 * 1024 * 1024, files: 1 } });

  // Stores and gateways
  const storeDefaults = {
    organizationId: config.auth.defaultOrganizationId,
    legacyOwnerId: config.auth.legacyOwnerId,
  };
  const onStoreError = (error: unknown) => {
    app.log.error({ err: error }, 'coalesced store flush failed; retrying on next write');
  };
  const accounts = new AccountStore(join(config.dataDir, 'accounts.json'), storeDefaults);
  const conversations = new ConversationStore(
    join(config.dataDir, 'conversations.json'),
    storeDefaults,
    150,
    onStoreError,
  );
  const messages = new MessageStore(join(config.dataDir, 'messages.json'), 150, onStoreError);
  const uploads = new UploadedFileStore(config.dataDir, storeDefaults);
  const artifacts = new ArtifactStore(config.dataDir, storeDefaults);
  const dedupe = new WebhookDedupeStore(join(config.dataDir, 'webhook-dedupe.json'));
  const approvals = new ApprovalStore(join(config.dataDir, 'approvals.json'));
  const outbox = new OutboxStore(join(config.dataDir, 'outbox.json'));
  const readState = new ReadStateStore(
    join(config.dataDir, 'read-state.json'),
    150,
    onStoreError,
  );
  const sessions = new SessionStore(
    join(config.dataDir, 'sessions.json'),
    config.native.sessionTtlSeconds,
  );
  const localTasks = new LocalTaskReceiptStore();
  const agentIntakeStore = new AgentIntakeStore(
    join(config.dataDir, 'agent-intake.json'),
    onStoreError,
  );
  const events = new NativeEventHub();
  const audit = new AuditLog(config.auditFilePath);
  const limiter = new RateLimiter(DEFAULT_RATE_LIMITS);
  const streamLimiter = new StreamLimiter(8);

  const directory = new MemberDirectory({
    filePath: join(config.dataDir, 'members.json'),
    organizationId: config.auth.defaultOrganizationId,
    ownerId: config.auth.legacyOwnerId,
    ownerName: config.auth.defaultPrincipalName,
  });

  const memoryGateway = new MemoryImGateway();
  const channelConfig = (channel: string) => config.webhook.channels[channel] ?? {};
  const webhookGateways = [
    new WebhookImGateway({
      channel: 'dingtalk',
      name: 'dingtalk',
      normalizer: normalizeDingTalk,
      verificationToken: channelConfig('dingtalk').token,
      signingSecret: channelConfig('dingtalk').signingSecret,
      allowUnverified: config.webhook.allowUnverified,
      maxSkewSeconds: config.webhook.maxSkewSeconds,
    }),
    new WebhookImGateway({
      channel: 'feishu',
      name: 'feishu',
      normalizer: normalizeFeishu,
      verificationToken: channelConfig('feishu').token,
      signingSecret: channelConfig('feishu').signingSecret,
      allowUnverified: config.webhook.allowUnverified,
      maxSkewSeconds: config.webhook.maxSkewSeconds,
    }),
    new WebhookImGateway({
      channel: 'wechat-work',
      name: 'wechat-work',
      normalizer: normalizeWechatWork,
      verificationToken: channelConfig('wechat-work').token,
      signingSecret: channelConfig('wechat-work').signingSecret,
      allowUnverified: config.webhook.allowUnverified,
      maxSkewSeconds: config.webhook.maxSkewSeconds,
    }),
    new WebhookImGateway({
      channel: 'qq',
      name: 'qq',
      normalizer: normalizeQQ,
      verificationToken: channelConfig('qq').token,
      signingSecret: channelConfig('qq').signingSecret,
      allowUnverified: config.webhook.allowUnverified,
      maxSkewSeconds: config.webhook.maxSkewSeconds,
    }),
  ];
  // Built-in native channel: AI-initiated messages land in the member inbox.
  const nativeGateway = new NativeImGateway({
    accounts,
    conversations,
    messages,
    directory,
    events,
  });

  // Standalone by default: third-party IM adapters are opt-in.
  const gateways = config.native.externalChannels
    ? [nativeGateway, memoryGateway, ...webhookGateways]
    : [nativeGateway, memoryGateway];

  const provider = buildProvider(config);
  const runtime = new HermesAgentRuntime({
    provider,
    config: { maxToolSteps: config.maxToolSteps },
  });
  runtime.registry.registerAll(buildDocumentTools(uploads, artifacts));
  runtime.registry.registerAll(
    buildMessageTools({
      accounts,
      gateways,
      uploads,
      artifacts,
      approvals,
      outbox,
      directory,
      approvalTtlSeconds: config.approval.ttlSeconds,
    }),
  );

  // The intake gate needs the service for history and task submission, and the service
  // needs the gate, so the callbacks read this reference at call time (never during
  // construction): a handoff is only ever submitted later, from the queue.
  let service!: ChatAgentService;
  service = new ChatAgentService(
    config,
    accounts,
    conversations,
    messages,
    uploads,
    artifacts,
    gateways,
    runtime,
    dedupe,
    approvals,
    outbox,
    directory,
    sessions,
    events,
    readState,
    new AgentIntakeGate({
      store: agentIntakeStore,
      mode: config.agentIntake.mode,
      // The recall window IS the deferral: one number, so they cannot drift apart.
      deferMs: Math.max(0, config.native.recallWindowSeconds) * 1000,
      contextMessages: config.agentIntake.contextMessages,
      lookupMessage: (messageId) => messages.findById(messageId),
      buildHistory: (conversationId, limit) => service.buildAgentHistory(conversationId, limit),
      submit: async ({ record, history }) => {
        const task = await service.taskEngine.submit({
          accountId: record.accountId,
          conversationId: record.conversationId,
          organizationId: record.organizationId,
          requesterId: record.requesterId,
          goal: record.goal,
          input: { history },
          maxAttempts: 1,
        });
        return { taskId: task.id };
      },
      onEvent: (event) => events.publish(event),
      logger: {
        warn: (message, detail) => app.log.warn({ detail }, message),
        error: (message, detail) => app.log.error({ detail }, message),
      },
    }),
    (event) => audit.record(event),
  );

  await directory.ensureOwner();

  // Start the intake queue: recover anything that came due while the server was down,
  // then keep polling. Deferred is the product default; `immediate` only restores the
  // old behaviour for deployments that disable recall.
  await service.recoverIntake();
  service.startIntake();
  if (config.agentIntake.mode === 'immediate' && config.native.recallWindowSeconds > 0) {
    app.log.warn(
      'CHATAGENT_AGENT_INTAKE_MODE=immediate with recall enabled: agents may read a ' +
        'message the sender can still withdraw.',
    );
  }

  // Seed a default account so the workbench works immediately.
  if ((await accounts.list()).length === 0) {
    await accounts.create(
      {
        name: 'chatagent',
        displayName: 'ChatAgent 助理',
        channel: 'native',
        persona:
          '你是一名企业内网 AI 助理。优先完成真实工作：解析文档、生成 Word/Excel、转发文件、整理信息。回复简洁、可执行。',
        allowlist: [],
      },
      {
        organizationId: config.auth.defaultOrganizationId,
        ownerId: config.auth.legacyOwnerId,
      },
    );
  }

  for (const gateway of gateways) await gateway.start();
  await service.taskEngine.start();

  app.log.info(
    { authMode: config.auth.mode, organization: config.auth.defaultOrganizationId },
    'ChatAgent auth profile resolved',
  );
  if (config.auth.mode === 'development') {
    app.log.warn(
      'auth mode is "development": unauthenticated loopback callers are treated as the organization owner. ' +
        'Set CHATAGENT_AUTH_MODE=production for any shared or proxied deployment.',
    );
  }

  app.addHook('onClose', async () => {
    service.stopIntake();
    await service.taskEngine.stop();
    for (const gateway of gateways) await gateway.stop();
    // Coalesced stores flush here so a graceful shutdown loses nothing.
    await Promise.all([messages.flush(), conversations.flush(), readState.flush()]);
    await audit.flush();
  });

  app.addHook('onRequest', async (request, reply) => {
    const headers = request.headers as RequestHeaders;
    const method = request.method.toUpperCase();
    const bearer = readBearerToken(headers);
    const cookieToken = readCookieToken(headers);

    // The session cookie exists so EventSource can authenticate. It is a
    // read-only credential: state-changing requests must present a bearer
    // token, which removes the CSRF surface entirely.
    const cookieOnly = !bearer && cookieToken !== undefined;
    if (cookieOnly && method !== 'GET' && method !== 'HEAD') {
      request.principal = { ...ANONYMOUS_PRINCIPAL };
      audit.record({
        action: 'auth.cookie_write_denied',
        outcome: 'denied',
        target: auditPath(request.url),
        ip: request.ip,
      });
    } else {
      request.principal = await resolvePrincipal({
        headers,
        directory,
        auth: config.auth,
        sessions,
        remoteAddress: request.ip,
      });
    }

    reply.header('x-chatagent-auth-mode', config.auth.mode);
    if (config.auth.mode === 'development') {
      reply.header('x-chatagent-principal', request.principal.id);
    }

    const isApiWrite = method !== 'GET' && method !== 'HEAD' && request.url.startsWith('/api/');
    const hasOwnBucket =
      request.url.startsWith('/api/auth/login') || request.url.startsWith('/api/webhooks/');
    if (isApiWrite && !hasOwnBucket) {
      const key = request.principal.kind === 'anonymous' ? request.ip : request.principal.id;
      const decision = limiter.check('write', key);
      if (!decision.ok) {
        audit.record({
          action: 'ratelimit.write',
          outcome: 'denied',
          actorId: key,
          target: auditPath(request.url),
          ip: request.ip,
        });
        reply.header('retry-after', String(decision.retryAfterSeconds));
        return reply.code(429).send({ error: 'too many requests' });
      }
    }
  });

  app.addHook('onSend', async (_request, reply, payload) => {
    reply.header('x-content-type-options', 'nosniff');
    reply.header('x-frame-options', 'DENY');
    reply.header('referrer-policy', 'same-origin');
    reply.header('permissions-policy', 'geolocation=(), microphone=(), camera=()');
    reply.header('cross-origin-opener-policy', 'same-origin');
    if (!reply.hasHeader('content-security-policy')) {
      reply.header(
        'content-security-policy',
        "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; font-src 'self' data:; object-src 'none'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
      );
    }
    return payload;
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ServiceError) {
      if (error.status === 413) {
        // Archive/limit rejections are security-relevant: record them even
        // though they are "just" a client error.
        audit.record({
          action: 'upload.rejected',
          outcome: 'denied',
          actorId: request.principal?.id,
          target: auditPath(request.url),
          detail: error.reason ?? error.message,
          ip: request.ip,
        });
      }
      if (error.status === 401 || error.status === 403 || error.status === 404) {
        audit.record({
          action: error.status === 404 ? 'access.not_found' : 'auth.denied',
          outcome: 'denied',
          actorId: request.principal?.id,
          target: auditPath(request.url),
          detail: error.reason ?? error.message,
          ip: request.ip,
        });
      }
      // `detail` carries the machine-readable reason (e.g. not_a_participant) so
      // clients can branch on it instead of parsing the message; it is the same
      // value that already lands in the audit log.
      return reply.code(error.status).send(
        error.reason === undefined
          ? { error: error.message }
          : { error: error.message, detail: error.reason },
      );
    }
    const errorCode = (error as { code?: unknown }).code;
    const statusCode = (error as { statusCode?: unknown }).statusCode;
    if (errorCode === 'FST_REQ_FILE_TOO_LARGE' || statusCode === 413) {
      // @fastify/multipart throws before the route can inspect file.truncated,
      // so the limit violation is recorded here instead.
      audit.record({
        action: 'upload.rejected',
        outcome: 'denied',
        actorId: request.principal?.id,
        target: auditPath(request.url),
        detail: 'file too large',
        ip: request.ip,
      });
      return reply.code(413).send({ error: 'file too large' });
    }
    request.log.error({ err: error }, 'unhandled request error');
    return reply.code(500).send({ error: 'internal error' });
  });

  // Health ------------------------------------------------------------------
  app.get('/health', async (_request, reply) => {
    const storage = [messages.health, conversations.health, readState.health];
    const failed = storage.find((state) => state.lastError !== undefined);
    const body = {
      ok: failed === undefined,
      uptime: process.uptime(),
      authMode: config.auth.mode,
      storage: {
        pending: storage.some((state) => state.dirty),
        lastError: failed?.lastError,
      },
    };
    // A store that cannot write is a real degradation: report it, not 200.
    return reply.code(failed ? 503 : 200).send(body);
  });

  app.get('/api/agent/status', async (request) => service.agentStatus(request.principal));

  // Accounts ----------------------------------------------------------------
  app.get('/api/accounts', async (request) => service.listAccounts(request.principal));

  app.post('/api/accounts', async (request, reply) => {
    const parsed = createAccountSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    return service.createAccount(request.principal, parsed.data);
  });

  app.patch('/api/accounts/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const parsed = updateAccountSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    return service.updateAccount(request.principal, id, parsed.data);
  });

  // Conversations -----------------------------------------------------------
  app.get('/api/conversations', async (request) => {
    const { accountId } = request.query as { accountId?: string };
    return service.listConversationSummaries(request.principal, accountId);
  });

  app.get('/api/conversations/:id', async (request) =>
    service.getConversation(request.principal, (request.params as { id: string }).id),
  );

  app.get('/api/conversations/:id/messages', async (request) => {
    const { id } = request.params as { id: string };
    const { limit, before } = request.query as { limit?: string; before?: string };
    const parsedLimit = limit ? Number.parseInt(limit, 10) : undefined;
    return service.listMessages(request.principal, id, {
      limit: parsedLimit !== undefined && Number.isFinite(parsedLimit) ? parsedLimit : undefined,
      before,
    });
  });

  app.post('/api/conversations/:id/read', async (request) =>
    service.markConversationRead(request.principal, (request.params as { id: string }).id),
  );

  // Messages ----------------------------------------------------------------
  app.post('/api/messages', async (request, reply) => {
    const parsed = inboundMessageSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    const data = parsed.data;
    const result = await service.injectMessage(request.principal, {
      accountId: data.accountId,
      channel: 'web',
      chatType: data.chatType,
      chatId: data.chatId,
      kind: data.kind,
      text: data.text,
      // Identity comes from request.principal, never from these fields.
      sender: { id: request.principal.id, name: request.principal.displayName },
      mentions: data.mentions,
      attachments: data.attachments,
      replyTo: data.replyTo,
    });
    audit.record({
      action: 'message.sent',
      outcome: result.authorized ? 'ok' : 'denied',
      actorId: request.principal?.id,
      target: result.conversationId,
      detail: result.taskId ? `task:${result.taskId}` : 'conversation',
      ip: request.ip,
    });
    return { ok: result.authorized, ...result };
  });

  // Webhooks (verified by token/signature, not by member principal) ---------
  app.post('/api/webhooks/:channel', async (request, reply) => {
    const { channel } = request.params as { channel: string };
    const decision = limiter.check('webhook', `${channel}:${request.ip}`);
    if (!decision.ok) {
      audit.record({
        action: 'webhook.rate_limited',
        outcome: 'denied',
        target: channel,
        ip: request.ip,
      });
      reply.header('retry-after', String(decision.retryAfterSeconds));
      return reply.code(429).send({ error: 'too many requests' });
    }

    const { token } = request.query as { token?: string };
    const rawBody = request.rawBody;
    return service.handleWebhook(channel, request.body, {
      token: firstHeader(request.headers['x-chatagent-webhook-token']) ?? token,
      signature: firstHeader(request.headers['x-chatagent-signature']),
      rawBody,
      dedupeKey: rawBody ? createHash('sha256').update(rawBody).digest('hex') : undefined,
    });
  });

  // Native client: session, contacts and chat -------------------------------
  app.post('/api/auth/login', async (request, reply) => {
    const parsed = loginSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });

    const perIp = limiter.check('loginIp', request.ip);
    const decision = perIp.ok
      ? limiter.check('login', `${request.ip}:${parsed.data.memberId}`)
      : perIp;
    if (!decision.ok) {
      audit.record({
        action: 'auth.login',
        outcome: 'denied',
        actorId: parsed.data.memberId,
        detail: 'rate_limited',
        ip: request.ip,
      });
      reply.header('retry-after', String(decision.retryAfterSeconds));
      return reply.code(429).send({ error: 'too many login attempts' });
    }

    let result: Awaited<ReturnType<typeof service.login>>;
    try {
      result = await service.login(parsed.data.memberId, parsed.data.token);
    } catch (error) {
      audit.record({
        action: 'auth.login',
        outcome: 'failed',
        actorId: parsed.data.memberId,
        ip: request.ip,
      });
      throw error;
    }
    audit.record({
      action: 'auth.login',
      outcome: 'ok',
      actorId: result.member.id,
      organizationId: result.member.organizationId,
      ip: request.ip,
    });
    // HttpOnly cookie so the native SSE stream (which cannot set headers) can
    // authenticate without putting the token in the URL.
    const secure = request.protocol === 'https' ? '; Secure' : '';
    const maxAge = Math.max(0, Math.floor((Date.parse(result.expiresAt) - Date.now()) / 1000));
    reply.header(
      'set-cookie',
      `${SESSION_COOKIE}=${result.token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure}`,
    );
    return result;
  });

  app.post('/api/auth/logout', async (request, reply) => {
    const token =
      readBearerToken(request.headers as RequestHeaders) ??
      readCookieToken(request.headers as RequestHeaders);
    const result = await service.logout(token);
    audit.record({
      action: 'auth.logout',
      outcome: result.ok ? 'ok' : 'failed',
      actorId: request.principal?.id,
      ip: request.ip,
    });
    reply.header('set-cookie', `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`);
    return result;
  });

  /** Revokes every session of the caller (lost device, suspected theft). */
  app.post('/api/auth/sessions/revoke', async (request) => {
    const revoked = await service.revokeSessions(request.principal);
    audit.record({
      action: 'auth.sessions_revoked',
      outcome: 'ok',
      actorId: request.principal?.id,
      detail: String(revoked),
      ip: request.ip,
    });
    return { revoked };
  });

  app.get('/api/auth/me', async (request) => service.me(request.principal));

  app.get('/api/contacts', async (request) => service.listContacts(request.principal));

  // Member administration (org admin only; tokens are returned once) --------
  app.get('/api/members', async (request) => service.listMembers(request.principal));

  app.post('/api/members', async (request, reply) => {
    const parsed = createMemberSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const result = await service.createMember(request.principal, parsed.data);
    audit.record({
      action: 'member.created',
      outcome: 'ok',
      actorId: request.principal?.id,
      target: result.member.id,
      ip: request.ip,
    });
    return reply.code(201).send(result);
  });

  app.patch('/api/members/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const parsed = updateMemberSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const member = await service.updateMember(request.principal, id, parsed.data);
    audit.record({
      action: 'member.updated',
      outcome: 'ok',
      actorId: request.principal?.id,
      target: id,
      ip: request.ip,
    });
    return member;
  });

  app.post('/api/members/:id/token', async (request) => {
    const { id } = request.params as { id: string };
    const result = await service.rotateMemberToken(request.principal, id);
    audit.record({
      action: 'member.token_rotated',
      outcome: 'ok',
      actorId: request.principal?.id,
      target: id,
      ip: request.ip,
    });
    return result;
  });

  app.post('/api/conversations', async (request, reply) => {
    const parsed = openConversationSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    return service.openConversation(request.principal, parsed.data.targetId, parsed.data.targetKind);
  });

  /**
   * Sessions of the caller. The current one is flagged so the client can avoid
   * revoking the device in the user's hand.
   */
  app.get('/api/auth/sessions', async (request) => {
    const sessionId = typeof request.principal?.sessionId === 'string' ? request.principal.sessionId : undefined;
    return service.listSessions(request.principal, sessionId);
  });

  /** Signs out every other device. Requires a session token (not the API token). */
  app.delete('/api/auth/sessions', async (request, reply) => {
    if (request.principal?.kind === 'anonymous') {
      return reply.code(401).send({ error: 'authentication required' });
    }
    const sessionId =
      typeof request.principal?.sessionId === 'string' ? request.principal.sessionId : undefined;
    if (!sessionId) {
      // Without a session id there is no "current device" to keep, so the
      // caller must not be able to sign out everything by accident.
      return reply.code(400).send({ error: 'a session credential is required' });
    }
    const result = await service.revokeOtherSessions(request.principal, sessionId);
    audit.record({
      action: 'auth.sessions_revoked',
      outcome: 'ok',
      actorId: request.principal?.id,
      detail: `${result.revoked} other session(s)`,
      ip: request.ip,
    });
    return result;
  });

  app.delete('/api/auth/sessions/:id', async (request) => {
    const { id } = request.params as { id: string };
    const result = await service.revokeOwnSession(request.principal, id);
    audit.record({
      action: 'auth.session_revoked',
      outcome: 'ok',
      actorId: request.principal?.id,
      target: id,
      ip: request.ip,
    });
    return result;
  });

  app.post('/api/auth/token/rotate', async (request, reply) => {
    // The development fallback (loopback in development auth mode) must not be
    // able to mint a persistent credential, otherwise enabling
    // CHATAGENT_ALLOW_DEV_AUTH would turn this route into a token factory.
    if (request.principal?.viaDevFallback === true) {
      audit.record({
        action: 'auth.token_rotated',
        outcome: 'denied',
        actorId: request.principal.id,
        detail: 'dev_fallback',
        ip: request.ip,
      });
      return reply.code(401).send({ error: 'a presented credential is required to rotate a token' });
    }
    const result = await service.rotateOwnToken(request.principal);
    audit.record({
      action: 'auth.token_rotated',
      outcome: 'ok',
      actorId: request.principal?.id,
      ip: request.ip,
    });
    return result;
  });

  app.post('/api/conversations/:id/members', async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as { memberId?: unknown };
    if (typeof body.memberId !== 'string' || body.memberId.trim() === '') {
      return reply.code(400).send({ error: 'memberId is required' });
    }
    const memberId = body.memberId.trim();
    try {
      const result = await service.addGroupMember(request.principal, id, memberId);
      // Adding a member grants access to the whole history, so it must be
      // traceable even when it is legitimate.
      audit.record({
        action: 'conversation.member_added',
        outcome: 'ok',
        actorId: request.principal?.id,
        target: id,
        detail: memberId,
        ip: request.ip,
      });
      return result;
    } catch (error) {
      audit.record({
        action: 'conversation.member_added',
        outcome: 'denied',
        actorId: request.principal?.id,
        target: id,
        detail: memberId,
        ip: request.ip,
      });
      throw error;
    }
  });

  /** Renames a group conversation (participants only). */
  app.patch('/api/conversations/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as { title?: unknown };
    if (typeof body.title !== 'string' || body.title.trim() === '') {
      return reply.code(400).send({ error: 'title is required' });
    }
    const conversation = await service.renameGroup(request.principal, id, body.title);
    audit.record({
      action: 'conversation.renamed',
      outcome: 'ok',
      actorId: request.principal?.id,
      target: id,
      detail: conversation.title,
      ip: request.ip,
    });
    return conversation;
  });

  /** Removes somebody else from a group (explicit, audited). */
  app.delete('/api/conversations/:id/members/:memberId', async (request) => {
    const { id, memberId } = request.params as { id: string; memberId: string };
    const result = await service.removeGroupMember(request.principal, id, memberId);
    audit.record({
      action: 'conversation.member_removed',
      outcome: 'ok',
      actorId: request.principal?.id,
      target: id,
      detail: memberId,
      ip: request.ip,
    });
    return result;
  });

  app.post('/api/conversations/:id/leave', async (request) => {
    const { id } = request.params as { id: string };
    const result = await service.leaveConversation(request.principal, id);
    audit.record({
      action: 'conversation.left',
      outcome: 'ok',
      actorId: request.principal?.id,
      target: id,
      ip: request.ip,
    });
    return result;
  });

  app.post('/api/groups', async (request, reply) => {
    const parsed = createGroupSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    try {
      const conversation = await service.createGroup(request.principal, parsed.data);
      audit.record({
        action: 'conversation.group_created',
        outcome: 'ok',
        actorId: request.principal?.id,
        target: conversation.id,
        detail: parsed.data.title,
        ip: request.ip,
      });
      return conversation;
    } catch (error) {
      // A refused re-creation is a membership decision and must be traceable.
      audit.record({
        action: 'conversation.group_created',
        outcome: 'denied',
        actorId: request.principal?.id,
        detail: parsed.data.title,
        ip: request.ip,
      });
      throw error;
    }
  });

  app.post('/api/conversations/:id/messages', async (request, reply) => {
    const { id } = request.params as { id: string };
    const parsed = nativeMessageSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    if (parsed.data.text.trim() === '' && parsed.data.attachments.length === 0) {
      return reply.code(400).send({ error: 'text or attachments are required' });
    }
    const delivered = await service.sendNativeMessage(request.principal, id, {
      text: parsed.data.text,
      attachments: parsed.data.attachments as ChatMessage['attachments'],
      mentions: parsed.data.mentions,
      replyTo: parsed.data.replyTo,
    });
    audit.record({
      action: 'message.sent',
      outcome: 'ok',
      actorId: request.principal?.id,
      target: id,
      detail: delivered.taskId ? `task:${delivered.taskId}` : 'conversation',
      ip: request.ip,
    });
    return delivered;
  });

  /** Forwards a message into another conversation the caller belongs to. */
  app.post('/api/messages/:id/forward', async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as { conversationId?: unknown };
    if (typeof body.conversationId !== 'string' || body.conversationId.trim() === '') {
      return reply.code(400).send({ error: 'conversationId is required' });
    }
    try {
      const result = await service.forwardMessage(request.principal, id, body.conversationId.trim());
      audit.record({
        action: 'message.forwarded',
        outcome: 'ok',
        actorId: request.principal?.id,
        target: result.message.conversationId,
        detail: id,
        ip: request.ip,
      });
      return result;
    } catch (error) {
      audit.record({
        action: 'message.forwarded',
        outcome: 'denied',
        actorId: request.principal?.id,
        target: body.conversationId.trim(),
        detail: id,
        ip: request.ip,
      });
      throw error;
    }
  });

  /** Presence: members of the caller's organization with a live event stream. */
  app.get('/api/presence', async (request) => service.presence(request.principal));

  /** Exports the conversation as a Word transcript (participants only). */
  app.post('/api/conversations/:id/export', async (request) => {
    const { id } = request.params as { id: string };
    const file = await service.exportConversation(request.principal, id);
    audit.record({
      action: 'conversation.exported',
      outcome: 'ok',
      actorId: request.principal?.id,
      target: id,
      detail: file.name,
      ip: request.ip,
    });
    return file;
  });

  /** Read cursors of the other participants (1:1 "read" indicator). */
  app.get('/api/conversations/:id/read-receipts', async (request) => {
    const { id } = request.params as { id: string };
    return service.readReceipts(request.principal, id);
  });

  /**
   * Recalls one of the caller's own messages. Only the sender, only inside the
   * configured window; the recalled body disappears from history, search,
   * previews and the model context.
   */
  app.post('/api/messages/:id/recall', async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      const result = await service.recallMessage(request.principal, id);
      audit.record({
        action: 'message.recalled',
        outcome: 'ok',
        actorId: request.principal?.id,
        target: result.message.conversationId,
        detail: id,
        ip: request.ip,
      });
      return result;
    } catch (error) {
      audit.record({
        action: 'message.recalled',
        outcome: 'denied',
        actorId: request.principal?.id,
        detail: id,
        ip: request.ip,
      });
      throw error;
    }
  });

  // Native event stream (messages, task states) -----------------------------
  app.get('/api/events/stream', async (request, reply) => {
    if (request.principal.kind === 'anonymous') {
      throw new ServiceError(401, 'authentication required');
    }
    const credential =
      readBearerToken(request.headers as RequestHeaders) ??
      readCookieToken(request.headers as RequestHeaders);
    // Member API tokens are not sessions: only revalidate what the session
    // store actually issued, otherwise valid CLI streams get killed.
    // Any credential is revalidated: sessions in the session store, member
    // API tokens in the directory, so a rotated token also drops live streams.
    const credentialHash = credential ? hashTokenForSession(credential) : undefined;
    return streamNativeEvents(
      reply,
      service,
      events,
      request.principal,
      credentialHash,
      { sessions, directory },
      streamLimiter,
    );
  });

  // Tasks -------------------------------------------------------------------
  app.get('/api/tasks', async (request) => service.listTasks(request.principal));

  // Local task receipts (on-device agent host mirror). Receipts are scoped to
  // the authenticated member: they are copies of that member's own device work,
  // and no server→device command path exists here on purpose.
  app.post('/api/local-tasks', async (request, reply) => {
    if (!isAuthenticated(request.principal)) {
      return reply.code(401).send({ error: 'authentication required' });
    }
    const parsed = localTaskSyncSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    const memberId = request.principal.id;
    // Ownership binding: a receipt may only claim work that belongs to the
    // authenticated member. Without this a shared machine could mirror one
    // account's on-device work into another account's workbench.
    const foreign = parsed.data.receipts.find(
      (receipt) => receipt.ownerId !== undefined && receipt.ownerId !== memberId,
    );
    if (foreign) {
      audit.record({
        action: 'local_tasks.sync',
        outcome: 'denied',
        actorId: memberId,
        target: `device:${String(foreign.deviceId).slice(0, 64)}`,
        detail: 'receipt owner does not match the authenticated member',
        ip: request.ip,
      });
      return reply.code(403).send({ error: 'receipt_owner_mismatch' });
    }
    const { accepted, stale } = await localTasks.upsert(parsed.data.receipts, memberId);
    audit.record({
      action: 'local_tasks.sync',
      outcome: 'ok',
      actorId: memberId,
      target: `member:${memberId}`,
      detail: stale > 0 ? `${accepted} receipts (${stale} stale ignored)` : `${accepted} receipts`,
      ip: request.ip,
    });
    return { accepted, stale };
  });

  app.get('/api/local-tasks', async (request, reply) => {
    if (!isAuthenticated(request.principal)) {
      return reply.code(401).send({ error: 'authentication required' });
    }
    return localTasks.list(request.principal.id);
  });

  app.post('/api/tasks', async (request, reply) => {
    const parsed = createTaskSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    const task = await service.submitTask(request.principal, parsed.data);
    return reply.code(201).send(task);
  });

  app.get('/api/tasks/:id', async (request) =>
    service.getTask(request.principal, (request.params as { id: string }).id),
  );

  app.get('/api/tasks/:id/events', async (request) =>
    service.getTaskEvents(request.principal, (request.params as { id: string }).id),
  );

  app.get('/api/tasks/:id/stream', async (request, reply) => {
    const { id } = request.params as { id: string };
    // Authorize before any SSE bytes are written.
    await service.getTask(request.principal, id);
    const credential =
      readBearerToken(request.headers as RequestHeaders) ??
      readCookieToken(request.headers as RequestHeaders);
    const credentialHash = credential ? hashTokenForSession(credential) : undefined;
    return streamTaskEvents(
      reply,
      service,
      id,
      request.principal,
      credentialHash,
      { sessions, directory },
      streamLimiter,
    );
  });

  app.post('/api/tasks/:id/cancel', async (request) =>
    service.cancelTask(request.principal, (request.params as { id: string }).id),
  );

  app.post('/api/tasks/:id/resume', async (request) =>
    service.resumeTask(request.principal, (request.params as { id: string }).id),
  );

  // Search ------------------------------------------------------------------
  app.get('/api/search', async (request, reply) => {
    const { q, limit } = request.query as { q?: string; limit?: string };
    if (typeof q !== 'string' || q.trim().length < 2) {
      return reply.code(400).send({ error: 'query must be at least 2 characters' });
    }
    const parsedLimit = limit ? Number.parseInt(limit, 10) : 30;
    return service.searchMessages(
      request.principal,
      q,
      Number.isFinite(parsedLimit) ? parsedLimit : 30,
    );
  });

  /**
   * Continuous authorization refresh for the on-device host (Gate 7A.2). The host
   * asks about the grants it holds; the answer is ids + status only, never the
   * approval payload. Unknown ids answer `unknown`, which the host treats as
   * "cannot vouch" (hold new work) rather than "revoked" (drop the grant).
   */
  app.post('/api/agent-authorizations/verify', async (request, reply) => {
    if (!isAuthenticated(request.principal)) {
      return reply.code(401).send({ error: 'authentication required' });
    }
    const body = (request.body ?? {}) as { deviceId?: unknown; grants?: unknown };
    if (!Array.isArray(body.grants) || body.grants.length > 200) {
      return reply.code(400).send({ error: 'grants must be an array of at most 200 entries' });
    }
    const grants: { id: string; kind: string }[] = [];
    for (const entry of body.grants) {
      const candidate = entry as { id?: unknown; kind?: unknown };
      if (
        typeof candidate?.id !== 'string' ||
        candidate.id.trim() === '' ||
        candidate.id.length > 128 ||
        (candidate.kind !== 'approval' && candidate.kind !== 'delegation')
      ) {
        return reply.code(400).send({ error: 'each grant needs an id and a known kind' });
      }
      grants.push({ id: candidate.id, kind: candidate.kind });
    }
    const answer = await service.verifyAgentAuthorizations(request.principal, grants);
    audit.record({
      action: 'agent_authorizations.verify',
      outcome: 'ok',
      actorId: request.principal.id,
      target: typeof body.deviceId === 'string' ? `device:${body.deviceId.slice(0, 64)}` : 'device:unknown',
      detail: `asked=${grants.length} active=${answer.results.filter((item) => item.status === 'active').length}`,
      ip: request.ip,
    });
    return answer;
  });

  // Approvals ---------------------------------------------------------------
  app.get('/api/approvals', async (request) => service.listApprovals(request.principal));

  app.post('/api/approvals/:id/decision', async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as { decision?: unknown; reason?: unknown };
    if (body.decision !== 'approved' && body.decision !== 'rejected') {
      return reply.code(400).send({ error: "decision must be 'approved' or 'rejected'" });
    }
    const reason = typeof body.reason === 'string' ? body.reason : undefined;
    return service.decideApproval(request.principal, id, body.decision, reason);
  });

  // Outbox ------------------------------------------------------------------
  app.get('/api/outbox', async (request) => service.listOutbox(request.principal));

  app.post('/api/outbox/:id/resolve', async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as { resolution?: unknown; note?: unknown };
    if (body.resolution !== 'delivered' && body.resolution !== 'failed') {
      return reply.code(400).send({ error: "resolution must be 'delivered' or 'failed'" });
    }
    const note = typeof body.note === 'string' ? body.note.slice(0, 200) : undefined;
    const record = await service.resolveOutbox(request.principal, id, body.resolution, note);
    audit.record({
      action: 'outbox.resolved',
      outcome: 'ok',
      actorId: request.principal?.id,
      target: id,
      detail: body.resolution,
      ip: request.ip,
    });
    return record;
  });

  // Audit -------------------------------------------------------------------
  app.get('/api/audit', async (request) => {
    const { limit } = request.query as { limit?: string };
    const parsed = limit ? Number.parseInt(limit, 10) : 100;
    return service.listAudit(
      request.principal,
      Number.isFinite(parsed) ? parsed : 100,
    );
  });

  // Documents ---------------------------------------------------------------
  app.post('/api/documents/parse', async (request, reply) => {
    const uploadLimit = limiter.check('upload', request.principal.id || 'anonymous');
    if (!uploadLimit.ok) {
      reply.header('retry-after', String(uploadLimit.retryAfterSeconds));
      return reply.code(429).send({ error: 'too many uploads' });
    }

    const file = await request.file();
    if (!file) return reply.code(400).send({ error: 'file is required' });
    if (!isAllowedUpload(file.filename)) {
      audit.record({
        action: 'upload.rejected',
        outcome: 'denied',
        actorId: request.principal?.id,
        detail: file.filename,
        ip: request.ip,
      });
      return reply.code(415).send({ error: 'unsupported file type' });
    }
    // @fastify/multipart may deliver a truncated stream without throwing, so
    // the size limit has to be verified explicitly; otherwise the caller would
    // silently work on a truncated document.
    if (file.file.truncated) {
      audit.record({
        action: 'upload.rejected',
        outcome: 'denied',
        actorId: request.principal?.id,
        detail: `truncated:${file.filename}`,
        ip: request.ip,
      });
      return reply.code(413).send({ error: 'file too large' });
    }
    const buffer = await file.toBuffer();
    return service.parseUploaded(request.principal, buffer, file.filename, file.mimetype);
  });

  app.post('/api/documents/generate/word', async (request, reply) => {
    const parsed = generateWordSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    return service.generateWord(request.principal, parsed.data);
  });

  app.post('/api/documents/generate/excel', async (request, reply) => {
    const parsed = generateExcelSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    return service.generateExcel(request.principal, parsed.data);
  });

  app.get('/api/files/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const file = await service.getFile(request.principal, id);
    return reply
      .type(file.mimeType)
      .header('Content-Disposition', `attachment; filename="${encodeURIComponent(file.name)}"`)
      .send(file.buffer);
  });

  app.get('/api/files', async (request) => service.listFiles(request.principal));

  // Gateway outbound --------------------------------------------------------
  app.get('/api/gateway/outbound', async (request) => service.listOutbound(request.principal));

  // Static web build (production) ------------------------------------------
  const serverDir = dirname(fileURLToPath(import.meta.url));
  const webDist = join(serverDir, '..', '..', 'web', 'dist');
  if (existsSync(webDist)) {
    await app.register(fastifyStatic, { root: webDist, prefix: '/' });
  }

  return app;
}

async function streamTaskEvents(
  reply: FastifyReply,
  service: ChatAgentService,
  taskId: string,
  principal: Principal,
  credentialHash: string | undefined,
  auth: StreamAuthDeps,
  limiter: StreamLimiter,
) {
  const principalId = principal.id;
  if (!limiter.acquire(principalId)) {
    reply.code(503).send({ error: 'too many concurrent event streams' });
    return reply;
  }

  reply.raw.writeHead(200, {
    ...STREAM_SECURITY_HEADERS,
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  reply.raw.write(': connected\n\n');

  // Replay goes through the service so recalled bodies are redacted (the raw
  // engine events still contain the original goal).
  const past = await service.getTaskEvents(principal, taskId);
  for (const event of past) writeSSE(reply.raw, event);

  // A recall can happen while the stream is open, so the fragment set is
  // refreshed (at most every few seconds) and applied to every live frame.
  let fragments = await service.recalledFragmentsForTask(taskId);
  let fragmentsAt = Date.now();
  const refreshFragments = async (): Promise<void> => {
    if (Date.now() - fragmentsAt < 3000) return;
    fragmentsAt = Date.now();
    fragments = await service.recalledFragmentsForTask(taskId);
  };
  const unsubscribe = service.taskEngine.onEvent((event) => {
    if (event.taskId !== taskId) return;
    if (fragments.length === 0) {
      writeSSE(reply.raw, event);
      void refreshFragments();
      return;
    }
    const [scrubbed] = redactEventPayloads([event], fragments);
    writeSSE(reply.raw, scrubbed ?? event);
  });
  const heartbeat = setInterval(() => {
    if (!writeAndCheck(reply.raw, ': ping\n\n')) close();
  }, 20000);
  const revalidate = credentialHash
    ? setInterval(() => {
        credentialStillValid(credentialHash, auth)
          .then((valid) => {
            if (!valid) close();
          })
          .catch(() => undefined);
      }, 15000)
    : undefined;

  let closed = false;
  function close() {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    if (revalidate) clearInterval(revalidate);
    unsubscribe();
    limiter.release(principalId);
    reply.raw.end();
  }

  reply.raw.on('close', close);
  reply.raw.on('error', close);
  return reply;
}


/**
 * Native SSE stream. Every event is re-authorized per subscriber, so a member
 * never receives messages or task updates they cannot read.
 */
function streamNativeEvents(
  reply: FastifyReply,
  service: ChatAgentService,
  hub: NativeEventHub,
  principal: Principal,
  credentialHash: string | undefined,
  auth: StreamAuthDeps,
  limiter: StreamLimiter,
) {
  if (!limiter.acquire(principal.id)) {
    reply.code(503).send({ error: 'too many concurrent event streams' });
    return reply;
  }
  const subscription = hub.subscribe((event) => {
    void deliverIfAuthorized(reply.raw, service, principal, event);
  }, principal.id);
  if (!subscription.ok) {
    limiter.release(principal.id);
    reply.code(503).send({ error: 'too many concurrent event streams' });
    return reply;
  }
  const unsubscribe = subscription.unsubscribe;

  reply.raw.writeHead(200, {
    ...STREAM_SECURITY_HEADERS,
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  reply.raw.write(': connected\n\n');

  // Heartbeat keeps proxies from dropping idle streams and detects dead peers.
  const heartbeat = setInterval(() => {
    if (!writeAndCheck(reply.raw, ': ping\n\n')) closeStream();
  }, 20000);

  // A revoked session must not keep receiving events on an open connection.
  const revalidate = credentialHash
    ? setInterval(() => {
        credentialStillValid(credentialHash, auth)
          .then((valid) => {
            if (!valid) closeStream();
          })
          .catch(() => undefined);
      }, 15000)
    : undefined;

  let closed = false;
  function closeStream() {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    if (revalidate) clearInterval(revalidate);
    unsubscribe();
    limiter.release(principal.id);
    reply.raw.end();
  }

  reply.raw.on('close', closeStream);
  reply.raw.on('error', closeStream);
  return reply;
}

interface StreamAuthDeps {
  sessions: SessionStore;
  directory: MemberDirectory;
}

/**
 * A stream stays open only while its credential is still valid: sessions are
 * checked in the session store, member API tokens in the directory.
 */
async function credentialStillValid(
  credentialHash: string,
  auth: StreamAuthDeps,
): Promise<boolean> {
  const [session, member] = await Promise.all([
    auth.sessions.findByTokenHash(credentialHash),
    auth.directory.findByTokenHash(credentialHash),
  ]);
  return session !== undefined || member !== undefined;
}

/** `write` returning false means the socket buffer is full: stop, do not grow. */
function writeAndCheck(raw: ServerResponse, chunk: string): boolean {
  try {
    return raw.write(chunk);
  } catch {
    return false;
  }
}

async function deliverIfAuthorized(
  raw: ServerResponse,
  service: ChatAgentService,
  principal: Principal,
  event: NativeEvent,
): Promise<void> {
  try {
    if (
      event.type === 'message' ||
      event.type === 'message_recalled' ||
      event.type === 'agent_intake' ||
      event.type === 'conversation_updated'
    ) {
      await service.getConversation(principal, event.conversationId);
    } else if (event.type === 'task') {
      await service.getTask(principal, event.taskId);
    } else if (!(await service.canSeeApproval(principal, event.approvalId))) {
      return;
    }
  } catch {
    // Not authorized for this event: drop it silently.
    return;
  }
  if (!writeAndCheck(raw, `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)) {
    raw.end();
  }
}

function writeSSE(raw: ServerResponse, event: TaskEvent): void {
  if (!writeAndCheck(raw, `data: ${JSON.stringify(event)}\n\n`)) raw.end();
}

const ALLOWED_UPLOAD_EXTENSIONS = [
  'docx',
  'doc',
  'xlsx',
  'xls',
  'csv',
  'txt',
  'md',
  'pdf',
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'zip',
];

/** Audit targets must never contain query strings (webhook tokens live there). */
function auditPath(url: string): string {
  const questionMark = url.indexOf('?');
  return questionMark === -1 ? url : url.slice(0, questionMark);
}

function isAllowedUpload(fileName: string): boolean {
  const dot = fileName.lastIndexOf('.');
  if (dot < 0) return false;
  return ALLOWED_UPLOAD_EXTENSIONS.includes(fileName.slice(dot + 1).toLowerCase());
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}
