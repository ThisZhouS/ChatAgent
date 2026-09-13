<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import type { MemberView } from '@chatagent/contracts';
import { api } from '../api';

const props = defineProps<{ me: MemberView | null }>();

const members = ref<MemberView[]>([]);
const error = ref('');
const loading = ref(false);
const issued = ref<{ memberId: string; token: string } | null>(null);

const newId = ref('');
const newName = ref('');
const newRole = ref<'member' | 'admin' | 'owner'>('member');

const isAdmin = computed(() => {
  const roles = props.me?.roles ?? [];
  return roles.includes('owner') || roles.includes('admin');
});

async function load() {
  loading.value = true;
  try {
    members.value = await api.members.list();
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    loading.value = false;
  }
}

async function createMember() {
  error.value = '';
  issued.value = null;
  if (!newId.value.trim() || !newName.value.trim()) {
    error.value = '请填写成员 ID 与显示名';
    return;
  }
  try {
    const result = await api.members.create({
      id: newId.value.trim(),
      displayName: newName.value.trim(),
      roles: [newRole.value],
    });
    issued.value = { memberId: result.member.id, token: result.token };
    newId.value = '';
    newName.value = '';
    await load();
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  }
}

async function rotate(member: MemberView) {
  error.value = '';
  try {
    const result = await api.members.rotateToken(member.id);
    issued.value = { memberId: result.member.id, token: result.token };
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  }
}

async function setRole(member: MemberView, role: 'member' | 'admin' | 'owner') {
  error.value = '';
  try {
    await api.members.update(member.id, { roles: [role] });
    await load();
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  }
}

async function copyToken() {
  if (!issued.value) return;
  try {
    await navigator.clipboard.writeText(issued.value.token);
  } catch {
    // Clipboard access can be blocked; the token stays visible for manual copy.
  }
}

function roleTagType(role: string): 'success' | 'warning' | 'info' {
  if (role === 'owner') return 'success';
  if (role === 'admin') return 'warning';
  return 'info';
}

onMounted(load);
</script>

<template>
  <div>
    <div class="page-header">
      <div>
        <h2>成员</h2>
        <p class="subtitle">签发登录令牌、调整角色；令牌只在创建/重置时显示一次。</p>
      </div>
      <el-button :loading="loading" @click="load">刷新</el-button>
    </div>

    <el-alert v-if="error" :title="error" type="error" show-icon class="card" closable @close="error = ''" />

    <el-alert
      v-if="issued"
      type="success"
      show-icon
      class="card"
      :closable="true"
      @close="issued = null"
    >
      <template #title>
        {{ issued.memberId }} 的访问令牌（仅显示一次，请立即保存）
      </template>
      <div class="token-row">
        <code class="token">{{ issued.token }}</code>
        <el-button size="small" @click="copyToken">复制</el-button>
      </div>
    </el-alert>

    <el-row :gutter="16">
      <el-col :span="9">
        <el-card shadow="never">
          <template #header>新增成员</template>
          <el-form label-position="top">
            <el-form-item label="成员 ID">
              <el-input v-model="newId" placeholder="例如 u_zhangsan" :disabled="!isAdmin" />
            </el-form-item>
            <el-form-item label="显示名">
              <el-input v-model="newName" placeholder="张三" :disabled="!isAdmin" />
            </el-form-item>
            <el-form-item label="角色">
              <el-select v-model="newRole" style="width: 100%" :disabled="!isAdmin">
                <el-option label="member（普通成员）" value="member" />
                <el-option label="admin（组织管理员）" value="admin" />
                <el-option label="owner（组织所有者）" value="owner" />
              </el-select>
            </el-form-item>
            <el-button type="primary" :disabled="!isAdmin" @click="createMember">创建并签发令牌</el-button>
            <p v-if="!isAdmin" class="hint">只有组织所有者/管理员可以管理成员。</p>
          </el-form>
        </el-card>
      </el-col>

      <el-col :span="15">
        <el-card shadow="never">
          <template #header>成员列表</template>
          <el-table :data="members" style="width: 100%">
            <el-table-column prop="displayName" label="显示名" min-width="140" />
            <el-table-column prop="id" label="成员 ID" min-width="140" />
            <el-table-column label="角色" min-width="140">
              <template #default="{ row }">
                <el-tag v-for="role in row.roles" :key="role" :type="roleTagType(role)" size="small" style="margin-right: 4px">
                  {{ role }}
                </el-tag>
              </template>
            </el-table-column>
            <el-table-column label="操作" width="240">
              <template #default="{ row }">
                <el-select
                  :model-value="row.roles[0] ?? 'member'"
                  size="small"
                  style="width: 110px"
                  :disabled="!isAdmin"
                  @change="(value: 'member' | 'admin' | 'owner') => setRole(row, value)"
                >
                  <el-option label="member" value="member" />
                  <el-option label="admin" value="admin" />
                  <el-option label="owner" value="owner" />
                </el-select>
                <el-button size="small" :disabled="!isAdmin" @click="rotate(row)">重置令牌</el-button>
              </template>
            </el-table-column>
          </el-table>
        </el-card>
      </el-col>
    </el-row>
  </div>
</template>

<style scoped>
.token-row {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 6px;
}

.token {
  flex: 1;
  word-break: break-all;
  background: var(--ca-panel);
  border: 1px solid var(--ca-border);
  border-radius: 6px;
  padding: 6px 8px;
}

.hint {
  color: var(--ca-muted);
  font-size: 12px;
  margin: 10px 0 0;
}
</style>
