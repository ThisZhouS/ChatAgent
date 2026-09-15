<script setup lang="ts">
import { onMounted, onUnmounted, ref, watch } from 'vue';
import type { AgentAccount, LocalTaskReceipt, TaskEvent, TaskRecord } from '@chatagent/contracts';
import { api } from '../api';

const tasks = ref<TaskRecord[]>([]);
const accounts = ref<AgentAccount[]>([]);
const selectedId = ref('');
const selected = ref<TaskRecord | null>(null);
const events = ref<TaskEvent[]>([]);
const accountId = ref('');
const goal = ref('请生成一份 Word 工作说明文档');
const error = ref('');
const localReceipts = ref<LocalTaskReceipt[]>([]);
let stream: EventSource | undefined;

/** 本机任务回执：来自桌面端 Agent 主机的镜像（设备为权威来源）。 */
async function loadLocalReceipts() {
  try {
    localReceipts.value = await api.localTasks.list();
  } catch {
    // 桌面端未同步过或服务端不可达时静默降级
    localReceipts.value = [];
  }
}

/** 回执随桌面端同步节奏变化；页面打开期间低频轮询保持新鲜。 */
let receiptsTimer: ReturnType<typeof setInterval> | undefined;

const localStateTag = (state: string) => {
  const map: Record<string, string> = {
    queued: 'warning',
    running: 'primary',
    succeeded: 'success',
    failed: 'danger',
    cancelled: 'danger',
    interrupted: 'danger',
  };
  return map[state] ?? 'info';
};

function localArtifactNames(receipt: LocalTaskReceipt): string {
  return (receipt.artifacts ?? []).map((a) => a.name).join(', ') || '—';
}

async function load() {
  try {
    const [taskList, accountList] = await Promise.all([api.tasks.list(), api.accounts.list()]);
    tasks.value = taskList;
    accounts.value = accountList;
    if (!accountId.value && accountList[0]) accountId.value = accountList[0].id;
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  }
}

function closeStream() {
  if (stream) {
    stream.close();
    stream = undefined;
  }
}

function openStream(taskId: string) {
  closeStream();
  stream = new EventSource(`/api/tasks/${taskId}/stream`);
  stream.onmessage = (message) => {
    const event = JSON.parse(message.data) as TaskEvent;
    events.value = [...events.value, event];
    if (event.type === 'completed' || event.type === 'failed' || event.type === 'cancelled') {
      void load();
    }
  };
  stream.onerror = () => closeStream();
}

async function selectTask(id: string) {
  selectedId.value = id;
  if (!id) {
    selected.value = null;
    events.value = [];
    closeStream();
    return;
  }
  try {
    selected.value = await api.tasks.get(id);
    events.value = await api.tasks.events(id);
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  }
  openStream(id);
}

async function create() {
  if (!accountId.value) return;
  error.value = '';
  try {
    const task = await api.tasks.create({ accountId: accountId.value, goal: goal.value, maxAttempts: 1 });
    await load();
    await selectTask(task.id);
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  }
}

async function retry() {
  const task = selected.value;
  if (!task) return;
  error.value = '';
  try {
    const next = await api.tasks.create({
      accountId: task.accountId,
      conversationId: task.conversationId,
      goal: task.goal,
      maxAttempts: 1,
    });
    await load();
    await selectTask(next.id);
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  }
}

async function cancel() {
  if (!selected.value) return;
  await api.tasks.cancel(selected.value.id);
  await load();
}

const tagType = (state: string) => {
  const map: Record<string, string> = {
    pending: 'info',
    running: 'primary',
    waiting_input: 'warning',
    waiting_approval: 'warning',
    incomplete: 'warning',
    completed: 'success',
    failed: 'danger',
    cancelled: 'danger',
  };
  return map[state] ?? 'info';
};

watch(selectedId, (id) => {
  if (!id) closeStream();
});

onMounted(() => {
  void load();
  void loadLocalReceipts();
  receiptsTimer = setInterval(() => void loadLocalReceipts(), 30_000);
});
onUnmounted(() => {
  closeStream();
  if (receiptsTimer) clearInterval(receiptsTimer);
});
</script>

<template>
  <div>
    <div class="page-header">
      <div>
        <h2>任务</h2>
        <p class="subtitle">创建、执行并追踪 Agent 任务。</p>
      </div>
    </div>

    <el-alert v-if="error" :title="error" type="error" show-icon class="card" />

    <el-row :gutter="16">
      <el-col :span="9">
        <el-card shadow="never">
          <template #header>新建任务</template>
          <el-form label-position="top">
            <el-form-item label="账号">
              <el-select v-model="accountId" style="width: 100%">
                <el-option
                  v-for="account in accounts"
                  :key="account.id"
                  :label="account.displayName"
                  :value="account.id"
                />
              </el-select>
            </el-form-item>
            <el-form-item label="目标">
              <el-input v-model="goal" type="textarea" :rows="3" />
            </el-form-item>
            <el-button type="primary" :disabled="!accountId" @click="create">创建并执行</el-button>
          </el-form>
        </el-card>

        <el-card shadow="never">
          <template #header>任务列表</template>
          <el-empty v-if="tasks.length === 0" description="暂无任务" />
          <div v-else class="message-list" style="height: 420px">
            <el-card
              v-for="task in tasks"
              :key="task.id"
              shadow="hover"
              class="clickable"
              :class="{ 'is-selected': selectedId === task.id }"
              @click="selectTask(task.id)"
            >
              <div style="display: flex; justify-content: space-between; gap: 8px">
                <el-tag :type="tagType(task.state)" size="small">{{ task.state }}</el-tag>
                <span class="stat-label">{{ task.attempts }}/{{ task.maxAttempts }}</span>
              </div>
              <div style="margin-top: 6px">{{ task.goal.slice(0, 60) }}</div>
            </el-card>
          </div>
        </el-card>
      </el-col>

      <el-col :span="15">
        <el-card shadow="never">
          <template #header>任务详情</template>
          <el-empty v-if="!selected" description="选择一个任务查看进度" />
          <template v-else>
            <div style="display: flex; justify-content: space-between; margin-bottom: 12px">
              <el-tag :type="tagType(selected.state)">{{ selected.state }}</el-tag>
              <div class="row" style="gap: 8px">
                <el-button
                  size="small"
                  :disabled="selected.state !== 'failed' && selected.state !== 'incomplete' && selected.state !== 'cancelled'"
                  @click="retry"
                >重试</el-button>
                <el-button
                  size="small"
                  type="danger"
                  :disabled="selected.state !== 'running' && selected.state !== 'pending'"
                  @click="cancel"
                >取消</el-button>
              </div>
            </div>

            <p><strong>目标：</strong>{{ selected.goal }}</p>
            <p v-if="selected.result"><strong>结果：</strong>{{ selected.result }}</p>
            <el-alert v-if="selected.error" :title="selected.error" type="error" show-icon />

            <div v-if="selected.artifacts.length" style="margin-bottom: 12px">
              <strong>产物：</strong>
              <div v-for="artifact in selected.artifacts" :key="artifact.id">
                <el-link :href="api.files.downloadUrl(artifact.id)" type="primary">{{ artifact.name }}</el-link>
              </div>
            </div>

            <strong>事件日志</strong>
            <div class="event-log" style="margin-top: 8px">
              <span v-if="events.length === 0" class="stat-label">暂无事件</span>
              <div v-for="(event, index) in events" :key="`${event.at}-${index}`" class="event-line">
                <span class="time">{{ new Date(event.at).toLocaleTimeString() }}</span>
                <el-tag :type="tagType(event.type)" size="small">{{ event.type }}</el-tag>
                {{ event.message }}
              </div>
            </div>
          </template>
        </el-card>
      </el-col>
    </el-row>

    <el-card shadow="never" style="margin-top: 16px">
      <template #header>
        <div class="row" style="display: flex; justify-content: space-between; align-items: center">
          <span>本机任务回执（桌面 Agent 主机镜像）</span>
          <el-button size="small" @click="loadLocalReceipts">刷新</el-button>
        </div>
      </template>
      <p class="stat-label">
        由桌面客户端的本机 Agent 主机同步而来；设备为本机权威来源，这里只读展示。
      </p>
      <el-empty v-if="localReceipts.length === 0" description="暂无本机任务回执（需在桌面端设置页打开本机 Agent 卡片后自动同步）" :image-size="60" />
      <el-table v-else :data="localReceipts" size="small" style="width: 100%">
        <el-table-column prop="taskId" label="任务" min-width="150" show-overflow-tooltip />
        <el-table-column label="状态" width="110">
          <template #default="{ row }">
            <el-tag size="small" :type="localStateTag(row.state)">{{ row.state }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="executor" label="执行器" width="90" />
        <el-table-column prop="goal" label="目标" min-width="200" show-overflow-tooltip />
        <el-table-column label="产物" width="170">
          <template #default="{ row }">
            {{ localArtifactNames(row) }}
          </template>
        </el-table-column>
        <el-table-column label="更新时间" width="160">
          <template #default="{ row }">{{ new Date(row.updatedAt).toLocaleString() }}</template>
        </el-table-column>
      </el-table>
    </el-card>
  </div>
</template>

<style scoped>
.is-selected {
  border-color: #409eff;
}
</style>
