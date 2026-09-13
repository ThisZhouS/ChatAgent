<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import type { ApprovalRecord, MemberView, OutboxRecord } from '@chatagent/contracts';
import { api } from '../api';

const props = defineProps<{ me: MemberView | null }>();

const approvals = ref<ApprovalRecord[]>([]);
const outbox = ref<OutboxRecord[]>([]);
const error = ref('');
const loading = ref(false);
let timer: ReturnType<typeof setInterval> | undefined;

const canDecide = computed(() => {
  const roles = props.me?.roles ?? [];
  return roles.includes('owner') || roles.includes('admin');
});

const pending = computed(() => approvals.value.filter((item) => item.status === 'pending'));
const decided = computed(() => approvals.value.filter((item) => item.status !== 'pending'));

async function load() {
  loading.value = true;
  try {
    const [approvalList, outboxList] = await Promise.all([api.approvals.list(), api.outbox.list()]);
    approvals.value = approvalList;
    outbox.value = outboxList;
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    loading.value = false;
  }
}

async function decide(approval: ApprovalRecord, decision: 'approved' | 'rejected') {
  error.value = '';
  try {
    await api.approvals.decide(approval.id, decision);
    if (decision === 'approved' && approval.taskId) await api.tasks.resume(approval.taskId);
    await load();
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  }
}

function statusType(status: string): 'success' | 'warning' | 'danger' | 'info' {
  if (status === 'approved' || status === 'consumed') return 'success';
  if (status === 'pending') return 'warning';
  if (status === 'rejected' || status === 'expired') return 'danger';
  return 'info';
}

function deliveryType(state: string): 'success' | 'warning' | 'danger' | 'info' {
  if (state === 'delivered' || state === 'accepted') return 'success';
  if (state === 'simulated' || state === 'unknown') return 'warning';
  if (state === 'failed') return 'danger';
  return 'info';
}

function actionSummary(approval: ApprovalRecord): string {
  const { tool, target, text, artifactName } = approval.action;
  const payload = text ?? artifactName ?? '';
  return `${tool} → ${target}${payload ? `：${payload.slice(0, 60)}` : ''}`;
}

onMounted(async () => {
  await load();
  timer = setInterval(() => void load(), 5000);
});

onUnmounted(() => {
  if (timer) clearInterval(timer);
});
</script>

<template>
  <div>
    <div class="page-header">
      <div>
        <h2>审批与交付</h2>
        <p class="subtitle">外发动作必须先审批；这里是审批队列与投递回执。</p>
      </div>
      <el-button :loading="loading" @click="load">刷新</el-button>
    </div>

    <el-alert v-if="error" :title="error" type="error" show-icon class="card" closable @close="error = ''" />

    <el-card shadow="never" class="card">
      <template #header>
        <div class="row-title">
          <span>待审批</span>
          <el-tag size="small" type="warning">{{ pending.length }}</el-tag>
        </div>
      </template>
      <el-empty v-if="pending.length === 0" description="没有待审批的外发动作" :image-size="70" />
      <el-table v-else :data="pending" style="width: 100%">
        <el-table-column label="动作" min-width="260">
          <template #default="{ row }">{{ actionSummary(row) }}</template>
        </el-table-column>
        <el-table-column prop="requesterId" label="发起人" width="120" />
        <el-table-column label="过期时间" width="180">
          <template #default="{ row }">{{ new Date(row.expiresAt).toLocaleString() }}</template>
        </el-table-column>
        <el-table-column label="操作" width="190">
          <template #default="{ row }">
            <el-button size="small" type="primary" :disabled="!canDecide" @click="decide(row, 'approved')">
              批准并继续
            </el-button>
            <el-button size="small" :disabled="!canDecide" @click="decide(row, 'rejected')">驳回</el-button>
          </template>
        </el-table-column>
      </el-table>
      <p v-if="!canDecide && pending.length > 0" class="hint">
        只有组织所有者/管理员可以审批；发起人不能自审。
      </p>
    </el-card>

    <el-card shadow="never" class="card">
      <template #header>历史审批</template>
      <el-empty v-if="decided.length === 0" description="暂无历史记录" :image-size="60" />
      <el-table v-else :data="decided.slice(0, 20)" style="width: 100%">
        <el-table-column label="动作" min-width="240">
          <template #default="{ row }">{{ actionSummary(row) }}</template>
        </el-table-column>
        <el-table-column label="状态" width="110">
          <template #default="{ row }">
            <el-tag size="small" :type="statusType(row.status)">{{ row.status }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="approverId" label="审批人" width="120" />
        <el-table-column label="时间" width="180">
          <template #default="{ row }">
            {{ new Date(row.decidedAt ?? row.createdAt).toLocaleString() }}
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <el-card shadow="never">
      <template #header>
        <div class="row-title">
          <span>投递回执（outbox）</span>
          <el-tag size="small" type="info">{{ outbox.length }}</el-tag>
        </div>
      </template>
      <el-empty v-if="outbox.length === 0" description="还没有外发记录" :image-size="60" />
      <el-table v-else :data="outbox.slice(0, 30)" style="width: 100%">
        <el-table-column prop="tool" label="工具" width="140" />
        <el-table-column prop="target" label="目标" width="140" />
        <el-table-column label="状态" width="120">
          <template #default="{ row }">
            <el-tag size="small" :type="deliveryType(row.state)">{{ row.state }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="attempts" label="尝试" width="80" />
        <el-table-column label="时间" width="180">
          <template #default="{ row }">{{ new Date(row.createdAt).toLocaleString() }}</template>
        </el-table-column>
        <el-table-column label="错误" min-width="180">
          <template #default="{ row }">
            <span class="muted">{{ row.error ?? '—' }}</span>
          </template>
        </el-table-column>
      </el-table>
      <p class="hint">
        `simulated` 表示未配置真实投递通道（不计为送达）；`unknown` 表示结果未知，不会自动重发。
      </p>
    </el-card>
  </div>
</template>

<style scoped>
.row-title {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.hint {
  color: var(--ca-muted);
  font-size: 12px;
  margin: 10px 0 0;
}

.muted {
  color: var(--ca-muted);
}
</style>
