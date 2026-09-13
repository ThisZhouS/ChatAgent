<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { api, type AgentStatus } from '../api';

const emit = defineEmits<{ navigate: [view: string] }>();

const status = ref<AgentStatus | null>(null);
const error = ref('');

async function load() {
  try {
    status.value = await api.status();
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  }
}

onMounted(load);
</script>

<template>
  <div>
    <div class="page-header">
      <div>
        <h2>工作台</h2>
        <p class="subtitle">让 AI 以独立账号身份完成真实企业工作。</p>
      </div>
      <el-button type="primary" @click="emit('navigate', 'conversations')">开始对话</el-button>
    </div>

    <el-alert
      v-if="error"
      :title="error"
      type="error"
      show-icon
      class="card"
    />

    <el-row :gutter="16">
      <el-col :span="8">
        <el-card shadow="never">
          <div class="stat-label">模型运行时</div>
          <div class="stat">{{ status?.provider ?? '—' }}</div>
          <div class="stat-label">未配置密钥时使用离线 Mock，配置后自动切换。</div>
        </el-card>
      </el-col>
      <el-col :span="8">
        <el-card shadow="never">
          <div class="stat-label">AI 账号</div>
          <div class="stat">{{ status?.onlineAccounts ?? 0 }}/{{ status?.accounts ?? 0 }}</div>
          <div class="stat-label">在线 / 总数</div>
        </el-card>
      </el-col>
      <el-col :span="8">
        <el-card shadow="never">
          <div class="stat-label">任务</div>
          <div class="stat">{{ status?.tasks.running ?? 0 }} 运行 · {{ status?.tasks.completed ?? 0 }} 完成</div>
          <div class="stat-label">待处理 {{ status?.tasks.pending ?? 0 }} · 失败 {{ status?.tasks.failed ?? 0 }}</div>
        </el-card>
      </el-col>
    </el-row>

    <el-row :gutter="16" style="margin-top: 16px">
      <el-col :span="8">
        <el-card shadow="never">
          <div class="stat-label">待审批</div>
          <div class="stat">{{ status?.approvals?.pending ?? 0 }}</div>
          <div class="stat-label">共 {{ status?.approvals?.total ?? 0 }} 条审批记录</div>
        </el-card>
      </el-col>
      <el-col :span="8">
        <el-card shadow="never">
          <div class="stat-label">投递回执</div>
          <div class="stat">{{ status?.outbox?.total ?? 0 }}</div>
          <div class="stat-label">
            待对账（unknown/failed）：{{ status?.outbox?.undelivered ?? 0 }}
          </div>
        </el-card>
      </el-col>
      <el-col :span="8">
        <el-card shadow="never">
          <div class="stat-label">运行状态</div>
          <div class="stat">{{ status?.runtime?.streams ?? 0 }} 实时连接</div>
          <div class="stat-label">
            队列 {{ status?.runtime?.queueDepth ?? 0 }} · 会话 {{ status?.runtime?.conversations ?? 0 }} ·
            运行 {{ Math.floor((status?.uptimeSeconds ?? 0) / 60) }} 分钟
          </div>
        </el-card>
      </el-col>
    </el-row>

    <el-row :gutter="16">
      <el-col :span="12">
        <el-card shadow="never">
          <template #header>可用工具</template>
          <div v-if="status">
            <el-tag
              v-for="tool in status.tools"
              :key="tool"
              style="margin: 0 8px 8px 0"
            >{{ tool }}</el-tag>
          </div>
          <el-empty v-else description="加载中…" />
        </el-card>
      </el-col>
      <el-col :span="12">
        <el-card shadow="never">
          <template #header>快速开始</template>
          <el-space wrap>
            <el-button @click="emit('navigate', 'conversations')">发消息 / 丢文件</el-button>
            <el-button @click="emit('navigate', 'tasks')">创建独立任务</el-button>
            <el-button @click="emit('navigate', 'documents')">生成 Word / Excel</el-button>
            <el-button @click="emit('navigate', 'accounts')">管理账号与白名单</el-button>
          </el-space>
        </el-card>
      </el-col>
    </el-row>
  </div>
</template>
