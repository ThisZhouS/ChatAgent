<script setup lang="ts">
import { onMounted, ref } from 'vue';
import type { AgentAccount } from '@chatagent/contracts';
import { api } from '../api';

const CHANNELS = ['memory', 'qq', 'wechat-work', 'dingtalk', 'feishu', 'web', 'cli'];

const accounts = ref<AgentAccount[]>([]);
const error = ref('');
const name = ref('assistant');
const displayName = ref('企业 AI 助理');
const channel = ref('memory');
const persona = ref('你是一名企业内网 AI 助理，负责完成文档、文件与消息任务。');
const allowlist = ref('');

async function load() {
  try {
    accounts.value = await api.accounts.list();
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  }
}

async function create() {
  try {
    await api.accounts.create({
      name: name.value,
      displayName: displayName.value,
      channel: channel.value,
      persona: persona.value,
      allowlist: allowlist.value.split(',').map((item) => item.trim()).filter(Boolean),
    });
    name.value = 'assistant';
    displayName.value = '企业 AI 助理';
    allowlist.value = '';
    await load();
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  }
}

const editing = ref<AgentAccount | null>(null);
const editName = ref('');
const editPersona = ref('');
const editAllowlist = ref('');

function openEdit(account: AgentAccount) {
  editing.value = account;
  editName.value = account.displayName;
  editPersona.value = account.persona;
  editAllowlist.value = account.allowlist.join(', ');
}

async function saveEdit() {
  if (!editing.value) return;
  error.value = '';
  try {
    await api.accounts.update(editing.value.id, {
      displayName: editName.value.trim(),
      persona: editPersona.value,
      allowlist: editAllowlist.value
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean),
    });
    editing.value = null;
    await load();
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  }
}

async function toggle(account: AgentAccount) {
  try {
    await api.accounts.update(account.id, {
      status: account.status === 'online' ? 'offline' : 'online',
    });
    await load();
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  }
}

const tagType = (status: string) => (status === 'online' ? 'success' : status === 'busy' ? 'warning' : 'info');
</script>

<template>
  <div>
    <div class="page-header">
      <div>
        <h2>AI 账号</h2>
        <p class="subtitle">管理独立账号身份、系统人设与发送者白名单。</p>
      </div>
    </div>

    <el-alert v-if="error" :title="error" type="error" show-icon class="card" />

    <el-row :gutter="16">
      <el-col :span="10">
        <el-card shadow="never">
          <template #header>新建账号</template>
          <el-form label-position="top">
            <el-row :gutter="12">
              <el-col :span="12">
                <el-form-item label="账号名">
                  <el-input v-model="name" />
                </el-form-item>
              </el-col>
              <el-col :span="12">
                <el-form-item label="显示名">
                  <el-input v-model="displayName" />
                </el-form-item>
              </el-col>
            </el-row>
            <el-form-item label="平台">
              <el-select v-model="channel" style="width: 100%">
                <el-option v-for="item in CHANNELS" :key="item" :label="item" :value="item" />
              </el-select>
            </el-form-item>
            <el-form-item label="系统人设">
              <el-input v-model="persona" type="textarea" :rows="3" />
            </el-form-item>
            <el-form-item label="白名单（发送者 id 或名称，逗号分隔；留空表示全部允许）">
              <el-input v-model="allowlist" placeholder="zhangsan, 李四" />
            </el-form-item>
            <el-button type="primary" @click="create">创建账号</el-button>
          </el-form>
        </el-card>
      </el-col>

      <el-col :span="14">
        <el-card shadow="never">
          <template #header>账号列表</template>
          <el-table :data="accounts" style="width: 100%">
            <el-table-column prop="displayName" label="显示名" min-width="140" />
            <el-table-column prop="name" label="账号名" min-width="120" />
            <el-table-column prop="channel" label="平台" width="110" />
            <el-table-column prop="ownerId" label="负责人" width="120" />
            <el-table-column label="状态" width="110">
              <template #default="{ row }">
                <el-tag :type="tagType(row.status)">{{ row.status }}</el-tag>
              </template>
            </el-table-column>
            <el-table-column label="白名单" min-width="180">
              <template #default="{ row }">
                {{ row.allowlist.length ? row.allowlist.join(', ') : '全部允许' }}
              </template>
            </el-table-column>
            <el-table-column label="操作" width="170">
              <template #default="{ row }">
                <el-button size="small" @click="toggle(row)">
                  {{ row.status === 'online' ? '下线' : '上线' }}
                </el-button>
                <el-button size="small" @click="openEdit(row)">编辑</el-button>
              </template>
            </el-table-column>
          </el-table>
        </el-card>
      </el-col>
    </el-row>
    <el-dialog :model-value="editing !== null" title="编辑 AI 账号" width="480px" @close="editing = null">
      <el-form label-position="top">
        <el-form-item label="显示名">
          <el-input v-model="editName" />
        </el-form-item>
        <el-form-item label="系统人设">
          <el-input v-model="editPersona" type="textarea" :rows="5" />
        </el-form-item>
        <el-form-item label="可用成员白名单（成员 ID，逗号分隔；留空 = 全组织可用）">
          <el-input v-model="editAllowlist" placeholder="u_alice, u_bob" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="editing = null">取消</el-button>
        <el-button type="primary" @click="saveEdit">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>
