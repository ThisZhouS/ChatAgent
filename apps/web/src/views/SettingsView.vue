<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import type { MemberView } from '@chatagent/contracts';
import { api, type AgentStatus } from '../api';

const props = defineProps<{ me: MemberView | null }>();

const status = ref<AgentStatus | null>(null);
const error = ref('');
const audit = ref<
  Array<{ at?: string; action?: string; outcome?: string; actorId?: string; target?: string; detail?: string }>
>([]);
const auditError = ref('');
// 审计筛选：动作关键字 + 结果级别（客户端过滤已加载的最近 100 条）。
const auditActionFilter = ref('');
const auditOutcomeFilter = ref<'' | 'ok' | 'denied' | 'failed'>('');

const isAdmin = computed(() => {
  const roles = props.me?.roles ?? [];
  return roles.includes('owner') || roles.includes('admin');
});

const auditFiltered = computed(() =>
  audit.value.filter((entry) => {
    const action = auditActionFilter.value.trim().toLowerCase();
    if (action && !(entry.action ?? '').toLowerCase().includes(action)) return false;
    if (auditOutcomeFilter.value && entry.outcome !== auditOutcomeFilter.value) return false;
    return true;
  }),
);

const rotatedToken = ref('');
const sessions = ref<
  Array<{ id: string; createdAt: string; expiresAt: string; lastSeenAt: string; current: boolean }>
>([]);

// --- Local agent host (desktop only; hidden in a plain browser) ---------------
type HostStatus = {
  deviceId?: string;
  agentId?: string;
  running?: boolean;
  runningTasks?: number;
  paused?: boolean;
  executor?: string;
  executorReason?: string;
  /** Main-process upload state for local task receipts (offline queue). */
  receiptSync?: {
    pending?: number;
    synced?: number;
    lastSuccessAt?: string;
    lastError?: string;
    /**
     * Why the last upload failed. A batch the server refused (4xx) is not fixed by
     * waiting for the network, so the UI must not promise an automatic retry.
     */
    lastFailure?: { kind?: 'server_rejected' | 'server_error' | 'network'; status?: number; detail?: string; at?: string };
  };
  /** What the task store found while loading (repaired/quarantined/duplicate rows). */
  storeIntegrity?: {
    repaired?: number;
    quarantined?: number;
    duplicates?: number;
    /** Terminal records past the retention cap; the next write drops them. */
    prunable?: number;
    /** Records retention already dropped in this session (still visible, not silent). */
    pruned?: number;
    corruptFile?: string;
  };
  /**
   * Continuous authorization refresh (Gate 7A.2): what the last check against the
   * organization service said. `unverified` means new external actions are held.
   */
  authorization?: {
    state?: 'ok' | 'unverified' | 'idle';
    lastCheckAt?: string;
    lastError?: string;
    checks?: number;
    failures?: number;
    revoked?: number;
    unverifiable?: number;
    heldTasks?: number;
    heldSince?: string;
  };
  error?: string;
};
type HostTask = {
  taskId?: string;
  state?: string;
  kind?: string;
  goal?: string;
  artifacts?: Array<{ name?: string; sha256?: string }>;
  error?: string;
  summary?: string;
  createdAt?: string;
  exitCode?: number | null;
  /** Verified delegation snapshot (audit only): carries the work's real owner. */
  delegation?: { ownerId?: string };
};

const hasHost = computed(() => Boolean(window.chatagent?.host));

/**
 * The task store is a file that outlives upgrades: rows it could not trust are
 * kept as failed records, so the operator has to be able to see that this
 * happened instead of wondering why a task never ran.
 */
const hostIntegrityWarning = computed(() => {
  const integrity = hostStatus.value?.storeIntegrity;
  if (!integrity) return '';
  const parts: string[] = [];
  if (integrity.quarantined) parts.push(`${integrity.quarantined} 条记录无法解析，已隔离为失败（不会执行）`);
  if (integrity.repaired) parts.push(`${integrity.repaired} 条记录已按当前格式修复`);
  if (integrity.duplicates) parts.push(`${integrity.duplicates} 条重复 id 已按版本取舍`);
  if (integrity.corruptFile) parts.push(`任务库文件无法读取，已另存为 ${integrity.corruptFile}`);
  return parts.join('；');
});

/** Retention is normal housekeeping: shown as information, not as a warning. */
const hostRetentionNote = computed(() => {
  const integrity = hostStatus.value?.storeIntegrity;
  const prunable = integrity?.prunable ?? 0;
  const pruned = integrity?.pruned ?? 0;
  const parts: string[] = [];
  if (prunable > 0) {
    parts.push(`${prunable} 条更早的终态记录会在下次写入时清理（进行中的任务不受影响）`);
  }
  if (pruned > 0) {
    parts.push(`本次运行已按保留策略清理 ${pruned} 条更早的终态记录`);
  }
  return parts.length > 0 ? `本机任务库已保留最近记录：${parts.join('；')}` : '';
});
/**
 * Upload failures are not all the same problem: "the server refused these
 * receipts" (session expired, ownership mismatch, payload rejected) needs a human,
 * while "we could not reach the server" resolves itself. Promising the wrong one
 * is how an employee waits forever for something that will never happen.
 */
const receiptSyncNote = computed(() => {
  const sync = hostStatus.value?.receiptSync;
  if (!sync) return '';
  const pending = sync.pending ?? 0;
  const failure = sync.lastFailure;
  if (pending === 0) {
    if (failure?.kind === 'server_rejected') {
      return `回执上传被服务端拒绝（${failure.detail ?? ''}），当前没有待上传记录`;
    }
    return '';
  }
  if (failure?.kind === 'server_rejected') {
    return (
      `有 ${pending} 条回执被服务端拒收（${failure.detail ?? '原因未知'}）：` +
      '已停止自动重试，请重新登录或确认设备归属后再试（记录仍在本机，不会丢失）'
    );
  }
  if (failure?.kind === 'server_error') {
    return `有 ${pending} 条回执未上传（服务端错误 ${failure.detail ?? ''}），稍后自动重试`;
  }
  if (failure?.kind === 'network') {
    return `有 ${pending} 条回执未上传（网络不可达），联网后自动重试`;
  }
  return `有 ${pending} 条回执未上传，稍后自动重试`;
});

/**
 * An unverified authorization is not a failure the employee caused: the host
 * simply refuses to start *new* external actions until the organization service
 * answers again. Work already running is untouched, so the wording must not
 * suggest that something was rolled back.
 */
const hostAuthorizationWarning = computed(() => {
  const authorization = hostStatus.value?.authorization;
  if (!authorization) return '';
  const parts: string[] = [];
  if (authorization.state === 'unverified') {
    parts.push(
      `授权暂时无法向组织服务复核（${authorization.lastError ?? '原因未知'}）：` +
        '新的外部操作已暂缓，已开始的执行不受影响，复核恢复后会自动继续',
    );
  }
  if (authorization.heldTasks) {
    parts.push(`${authorization.heldTasks} 条等待复核的任务仍在队列中（未失败、未被丢弃）`);
  }
  if (authorization.revoked) parts.push(`组织服务已撤销 ${authorization.revoked} 项授权`);
  if (authorization.unverifiable) parts.push(`${authorization.unverifiable} 项授权无法确认，相关新任务已暂缓`);
  return parts.join('；');
});

const hostStatus = ref<HostStatus | null>(null);
const hostTasks = ref<HostTask[]>([]);
/** Total records on the device; `hostTasks` is the newest page of them. */
const hostTaskTotal = ref(0);
const hostError = ref('');
const hostBusy = ref(false);
const hostGoal = ref('');
const hostKind = ref<'document' | 'side_effect'>('document');

async function loadHost() {
  const bridge = window.chatagent?.host;
  if (!bridge) return;
  try {
    const statusRes = await bridge.command({ type: 'status' });
    if (statusRes.ok) hostStatus.value = (statusRes.result ?? {}) as HostStatus;
    else hostError.value = `status: ${statusRes.error ?? 'unknown'}`;

    const listRes = await bridge.command({ type: 'list' });
    if (listRes.ok) {
      const page = (listRes.result ?? {}) as { tasks?: HostTask[]; total?: number };
      hostTasks.value = page.tasks ?? [];
      // The host caps the page (newest first) and reports the true total, so the
      // card can say what it is not showing instead of looking complete.
      hostTaskTotal.value = typeof page.total === 'number' ? page.total : hostTasks.value.length;
      void syncHostReceipts(hostTasks.value);
    } else {
      hostError.value = `list: ${listRes.error ?? 'unknown'}`;
    }
  } catch (err) {
    hostError.value = err instanceof Error ? err.message : String(err);
  }
}

/**
 * Mirrors on-device task records to the server so the workbench (任务页) can
 * show local agent work. The device is authoritative; the server only keeps an
 * auth-scoped copy. Silent best-effort: an offline server must not break the
 * local settings card.
 */
async function syncHostReceipts(tasks: HostTask[]): Promise<void> {
  const receipts = tasks
    .filter((t) => t.taskId && t.state && t.goal)
    .map((t) => ({
      deviceId: hostStatus.value?.deviceId ?? 'unknown-device',
      agentId: hostStatus.value?.agentId ?? 'hermes',
      taskId: t.taskId as string,
      goal: (t.goal ?? '').slice(0, 2000),
      kind: t.kind ?? 'document',
      state: t.state as 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'interrupted',
      executor: hostStatus.value?.executor === 'hermes' ? ('hermes' as const) : ('fake' as const),
      error: t.error?.slice(0, 500),
      summary: t.summary?.slice(0, 500),
      artifacts: (t.artifacts ?? []).map((a) => ({ name: a.name ?? 'artifact', sha256: a.sha256 ?? '' })),
      createdAt: t.createdAt ?? new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      // Only the owner the device verified — never "whoever is logged in here".
      // A shared machine must not mirror another account's local work; the
      // server refuses a receipt whose owner is not the authenticated member.
      ownerId: t.delegation?.ownerId,
    }));
  if (receipts.length === 0) return;
  try {
    await api.localTasks.sync(receipts);
  } catch {
    // best-effort only
  }
}

async function runHostCommand(command: unknown) {
  const bridge = window.chatagent?.host;
  if (!bridge) return;
  hostBusy.value = true;
  hostError.value = '';
  try {
    const res = await bridge.command(command);
    if (!res.ok) hostError.value = `${res.error ?? 'command failed'}${res.detail ? ` — ${res.detail}` : ''}`;
    await loadHost();
  } catch (err) {
    hostError.value = err instanceof Error ? err.message : String(err);
  } finally {
    hostBusy.value = false;
  }
}

function submitHostTask() {
  const goal = hostGoal.value.trim();
  if (!goal) {
    hostError.value = '请填写任务目标';
    return;
  }
  void runHostCommand({
    type: 'submit',
    taskId: `ui-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    goal,
    kind: hostKind.value,
    toolsets: ['document'],
  });
  hostGoal.value = '';
}

function hostStateTag(state?: string): 'success' | 'warning' | 'danger' | 'info' {
  if (state === 'succeeded') return 'success';
  if (state === 'running' || state === 'queued') return 'warning';
  if (state === 'failed' || state === 'cancelled' || state === 'interrupted') return 'danger';
  return 'info';
}

function artifactNames(artifacts?: Array<{ name?: string; sha256?: string }>): string {
  return (artifacts ?? []).map((a) => a.name ?? '').filter(Boolean).join(', ') || '—';
}

function quitApp() {
  void window.chatagent?.host?.quitApp();
}


async function loadSessions() {
  try {
    sessions.value = await api.auth.sessions();
  } catch (err) {
    auditError.value = err instanceof Error ? err.message : String(err);
  }
}

async function revokeOtherSessions() {
  try {
    await api.auth.revokeOtherSessions();
    await loadSessions();
  } catch (err) {
    auditError.value = err instanceof Error ? err.message : String(err);
  }
}

async function revokeSession(id: string) {
  try {
    await api.auth.revokeSession(id);
    await loadSessions();
  } catch (err) {
    auditError.value = err instanceof Error ? err.message : String(err);
  }
}

async function rotateMyToken() {
  try {
    const result = await api.auth.rotateToken();
    rotatedToken.value = result.token;
  } catch (err) {
    auditError.value = err instanceof Error ? err.message : String(err);
  }
}

async function loadAudit() {
  try {
    audit.value = await api.audit.list(100);
  } catch (err) {
    auditError.value = err instanceof Error ? err.message : String(err);
  }
}

function outcomeType(outcome?: string): 'success' | 'warning' | 'danger' | 'info' {
  if (outcome === 'ok') return 'success';
  if (outcome === 'denied') return 'warning';
  if (outcome === 'failed') return 'danger';
  return 'info';
}

onMounted(async () => {
  try {
    status.value = await api.status();
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  }
  if (isAdmin.value) await loadAudit();
  await loadSessions();
  await loadHost();
});
</script>

<template>
  <div>
    <div class="page-header">
      <div>
        <h2>设置</h2>
        <p class="subtitle">查看运行状态与模型接入方式。</p>
      </div>
    </div>

    <el-alert v-if="error" :title="error" type="error" show-icon class="card" />

    <el-row :gutter="16">
      <el-col :span="12">
        <el-card shadow="never">
          <template #header>运行状态</template>

          <el-descriptions :column="1" border>
            <el-descriptions-item label="模型运行时">{{ status?.provider ?? '—' }}</el-descriptions-item>
            <el-descriptions-item label="工具数">{{ status?.tools.length ?? '—' }}</el-descriptions-item>
            <el-descriptions-item label="工具列表">
              {{ (status?.tools ?? []).join(', ') || '—' }}
            </el-descriptions-item>
          </el-descriptions>
        </el-card>
      </el-col>

      <el-col :span="12">
        <el-card shadow="never">
          <template #header>
            <div class="row-title">
              <span>审计日志（最近 100 条）</span>
              <el-button v-if="isAdmin" size="small" @click="loadAudit">刷新</el-button>
            </div>
          </template>
          <p v-if="!isAdmin" class="muted">只有组织所有者/管理员可以查看审计日志。</p>
          <template v-else>
            <div v-if="auditError" class="error">{{ auditError }}</div>
            <el-empty v-else-if="audit.length === 0" description="暂无审计记录" :image-size="60" />
            <template v-else>
              <div class="audit-filters">
                <el-input
                  v-model="auditActionFilter"
                  size="small"
                  clearable
                  placeholder="按动作过滤，如 task / approval / local_tasks"
                />
                <el-select
                  v-model="auditOutcomeFilter"
                  size="small"
                  clearable
                  placeholder="结果"
                  style="width: 110px"
                >
                  <el-option label="成功" value="ok" />
                  <el-option label="拒绝" value="denied" />
                  <el-option label="失败" value="failed" />
                </el-select>
              </div>
              <el-empty
                v-if="auditFiltered.length === 0"
                description="没有匹配当前过滤条件的记录"
                :image-size="50"
              />
              <el-table v-else :data="auditFiltered" max-height="320" style="width: 100%">
                <el-table-column label="时间" width="170">
                  <template #default="{ row }">
                  {{ row.at ? new Date(row.at).toLocaleString() : '—' }}
                </template>
              </el-table-column>
              <el-table-column prop="action" label="动作" width="160" />
              <el-table-column label="结果" width="90">
                <template #default="{ row }">
                  <el-tag size="small" :type="outcomeType(row.outcome)">{{ row.outcome }}</el-tag>
                </template>
              </el-table-column>
              <el-table-column prop="actorId" label="主体" width="130" />
              <el-table-column prop="target" label="对象" min-width="150" />
              <el-table-column prop="detail" label="详情" min-width="140" />
              </el-table>
            </template>
          </template>
        </el-card>
      </el-col>

      <el-col :span="12">
        <el-card shadow="never">
          <template #header>我的访问令牌</template>
          <p class="muted">
            重置后旧令牌与所有会话立即失效，请用新令牌重新登录；令牌只显示一次。
          </p>
          <el-button @click="rotateMyToken">重置我的访问令牌</el-button>
          <div v-if="rotatedToken" class="token-row">
            <code class="token">{{ rotatedToken }}</code>
          </div>
        </el-card>

        <el-card shadow="never">
          <template #header>
            <div class="row-title">
              <span>我的登录会话</span>
              <span>
                <el-button size="small" @click="loadSessions">刷新</el-button>
                <el-button size="small" type="danger" plain @click="revokeOtherSessions">
                  撤销其他会话
                </el-button>
              </span>
            </div>
          </template>
          <p class="muted">令牌与哈希都不会显示；丢失设备时在这里撤销对应会话。</p>
          <el-empty v-if="sessions.length === 0" description="暂无活动会话" :image-size="60" />
          <el-table v-else :data="sessions" style="width: 100%">
            <el-table-column label="最近活动" min-width="150">
              <template #default="{ row }">{{ new Date(row.lastSeenAt).toLocaleString() }}</template>
            </el-table-column>
            <el-table-column label="过期" min-width="150">
              <template #default="{ row }">{{ new Date(row.expiresAt).toLocaleString() }}</template>
            </el-table-column>
            <el-table-column label="操作" width="110">
              <template #default="{ row }">
                <el-tag v-if="row.current" size="small" type="success">当前设备</el-tag>
                <el-button v-else size="small" text type="danger" @click="revokeSession(row.id)">
                  撤销
                </el-button>
              </template>
            </el-table-column>
          </el-table>
        </el-card>

        <el-card shadow="never">
          <template #header>接入真实模型</template>
          <p class="stat-label">
            复制根目录 <code>.env.example</code> 到 <code>apps/server/.env</code>，Docker 则写入 <code>docker-compose.yml</code> 的环境变量：
          </p>
          <pre style="white-space: pre-wrap; background: #f5f7fa; padding: 12px; border-radius: 8px">CHATAGENT_MODEL_BASE_URL=https://your-gateway/v1
CHATAGENT_MODEL_API_KEY=...
CHATAGENT_MODEL_NAME=your-model</pre>
          <p class="stat-label">支持任意 OpenAI 兼容网关（vLLM / Ollama / 内网模型服务）。未配置时使用离线 MockProvider。</p>
        </el-card>
      </el-col>
    </el-row>

    <el-card v-if="hasHost" shadow="never" class="host-card">
      <template #header>
        <div class="row-title">
          <span>
            本机 Agent 主机
            <el-tag size="small" :type="hostStatus?.running ? 'success' : 'danger'" class="ml-1">
              {{ hostStatus?.running ? '运行中' : '已停止' }}
            </el-tag>
            <el-tag v-if="hostStatus?.paused" size="small" type="warning" class="ml-1">已暂停</el-tag>
            <el-tag size="small" type="info" class="ml-1">{{ hostStatus?.executor ?? '—' }}</el-tag>
          </span>
          <span>
            <el-button size="small" :loading="hostBusy" @click="loadHost">刷新</el-button>
            <el-button size="small" :loading="hostBusy" @click="runHostCommand({ type: hostStatus?.paused ? 'resume' : 'pause' })">
              {{ hostStatus?.paused ? '继续' : '暂停后台' }}
            </el-button>
            <el-button size="small" type="warning" plain :loading="hostBusy" @click="runHostCommand({ type: 'stop' })">
              停止主机
            </el-button>
            <el-button size="small" type="danger" plain :loading="hostBusy" @click="quitApp">
              停止 Agent 并退出
            </el-button>
          </span>
        </div>
      </template>

      <p v-if="hostStatus?.executorReason" class="muted">
        <el-tag size="small" type="warning">注意</el-tag>
        {{ hostStatus.executorReason }}
      </p>
      <p v-if="receiptSyncNote" class="muted" data-testid="receipt-sync">
        <el-tag size="small" :type="hostStatus?.receiptSync?.lastFailure?.kind === 'server_rejected' ? 'warning' : 'info'">
          回执同步
        </el-tag>
        {{ receiptSyncNote }}
      </p>
      <p v-if="hostAuthorizationWarning" class="muted" data-testid="host-authorization">
        <el-tag size="small" type="warning">授权复核</el-tag>
        {{ hostAuthorizationWarning }}
      </p>
      <p v-if="hostRetentionNote" class="muted" data-testid="host-retention">
        <el-tag size="small" type="info">保留策略</el-tag>
        {{ hostRetentionNote }}
      </p>
      <p v-if="hostIntegrityWarning" class="muted" data-testid="host-integrity">
        <el-tag size="small" type="danger">任务库</el-tag>
        {{ hostIntegrityWarning }}
      </p>
      <el-alert v-if="hostError" :title="hostError" type="error" show-icon class="card" :closable="false" />

      <el-descriptions :column="3" border size="small">
        <el-descriptions-item label="设备">{{ hostStatus?.deviceId ?? '—' }}</el-descriptions-item>
        <el-descriptions-item label="Agent">{{ hostStatus?.agentId ?? '—' }}</el-descriptions-item>
        <el-descriptions-item label="运行中任务数">{{ hostStatus?.runningTasks ?? 0 }}</el-descriptions-item>
      </el-descriptions>

      <div class="host-submit">
        <el-input
          v-model="hostGoal"
          placeholder="输入任务目标（提交给本机 Agent）"
          :disabled="!hostStatus?.running"
          @keyup.enter="submitHostTask"
        />
        <el-select v-model="hostKind" style="width: 150px" :disabled="!hostStatus?.running">
          <el-option label="文档任务" value="document" />
          <el-option label="副作用任务" value="side_effect" />
        </el-select>
        <el-button type="primary" :disabled="!hostStatus?.running" :loading="hostBusy" @click="submitHostTask">
          提交任务
        </el-button>
      </div>

      <p v-if="hostTaskTotal > hostTasks.length" class="muted" data-testid="host-task-page">
        本机共 {{ hostTaskTotal }} 条任务记录，此处显示最近 {{ hostTasks.length }} 条
      </p>
      <el-table v-if="hostTasks.length > 0" :data="hostTasks" size="small" style="width: 100%; margin-top: 12px">
        <el-table-column prop="taskId" label="任务" width="150" />
        <el-table-column label="状态" width="110">
          <template #default="{ row }">
            <el-tag size="small" :type="hostStateTag(row.state)">{{ row.state }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="kind" label="类型" width="100" />
        <el-table-column prop="goal" label="目标" min-width="200" show-overflow-tooltip />
        <el-table-column label="说明" min-width="180" show-overflow-tooltip>
          <template #default="{ row }">
            <!-- Why nothing ran (authorization block) or why it failed; the host
                 records a reason instead of a silent failure. -->
            <span v-if="row.blockedReason || row.error" class="muted">
              {{ row.blockedReason || row.error }}
            </span>
            <span v-else class="muted">—</span>
          </template>
        </el-table-column>
        <el-table-column label="产物" width="160">
          <template #default="{ row }">
            <span v-if="row.artifacts?.length">
              {{ artifactNames(row.artifacts) }}
            </span>
            <span v-else class="muted">—</span>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="150">
          <template #default="{ row }">
            <el-button
              v-if="row.state === 'queued' || row.state === 'running'"
              size="small"
              text
              type="danger"
              @click="runHostCommand({ type: 'cancel', taskId: row.taskId })"
            >
              取消
            </el-button>
            <el-button
              v-else-if="row.kind !== 'side_effect' && (row.state === 'failed' || row.state === 'interrupted')"
              size="small"
              text
              type="primary"
              @click="runHostCommand({ type: 'retry', taskId: row.taskId })"
            >
              重试
            </el-button>
          </template>
        </el-table-column>
      </el-table>
      <el-empty v-else description="暂无本机任务" :image-size="50" />
    </el-card>
  </div>
</template>

<style scoped>
.row-title {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.audit-filters {
  display: flex;
  gap: 8px;
  margin-bottom: 10px;
}

.host-card {
  margin-top: 16px;
}

.host-submit {
  display: flex;
  gap: 8px;
  margin-top: 12px;
}

.ml-1 {
  margin-left: 6px;
}

.muted {
  color: var(--ca-muted);
}

.error {
  color: #f56c6c;
}

.token-row {
  margin-top: 10px;
}

.token {
  display: block;
  word-break: break-all;
  background: var(--ca-panel);
  border: 1px solid var(--ca-border);
  border-radius: 6px;
  padding: 6px 8px;
}
</style>
