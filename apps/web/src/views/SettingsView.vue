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

const isAdmin = computed(() => {
  const roles = props.me?.roles ?? [];
  return roles.includes('owner') || roles.includes('admin');
});

const rotatedToken = ref('');
const sessions = ref<
  Array<{ id: string; createdAt: string; expiresAt: string; lastSeenAt: string; current: boolean }>
>([]);

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
            <el-table v-else :data="audit" max-height="320" style="width: 100%">
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
  </div>
</template>

<style scoped>
.row-title {
  display: flex;
  align-items: center;
  justify-content: space-between;
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
