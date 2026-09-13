<script setup lang="ts">
import { ref } from 'vue';
import type { MemberView } from '@chatagent/contracts';
import { api, ApiError, setSessionToken } from '../api';

const emit = defineEmits<{ 'logged-in': [member: MemberView] }>();

const memberId = ref('');
const token = ref('');
const error = ref('');
const loading = ref(false);

async function submit() {
  if (!memberId.value.trim() || !token.value) {
    error.value = '请输入成员 ID 与访问令牌';
    return;
  }
  error.value = '';
  loading.value = true;
  try {
    const result = await api.auth.login(memberId.value.trim(), token.value);
    setSessionToken(result.token);
    emit('logged-in', result.member);
  } catch (err) {
    error.value =
      err instanceof ApiError && err.status === 401
        ? '成员 ID 或访问令牌不正确'
        : err instanceof Error
          ? err.message
          : String(err);
  } finally {
    loading.value = false;
  }
}
</script>

<template>
  <div class="login-page">
    <el-card class="login-card" shadow="never">
      <div class="brand">
        <div class="brand-mark">CA</div>
        <div>
          <h1>ChatAgent</h1>
          <p>内网 AI 工作助手 · 独立客户端</p>
        </div>
      </div>

      <el-alert v-if="error" :title="error" type="error" show-icon style="margin-bottom: 12px" />

      <el-form label-position="top" @submit.prevent="submit">
        <el-form-item label="成员 ID">
          <el-input
            v-model="memberId"
            data-testid="login-member"
            placeholder="例如 u_alice"
            @keyup.enter="submit"
          />
        </el-form-item>
        <el-form-item label="访问令牌">
          <el-input
            v-model="token"
            data-testid="login-token"
            type="password"
            show-password
            placeholder="成员令牌"
            @keyup.enter="submit"
          />
        </el-form-item>
        <el-button
          type="primary"
          data-testid="login-submit"
          style="width: 100%"
          :loading="loading"
          @click="submit"
        >
          登录
        </el-button>
      </el-form>

      <p class="hint">
        成员由管理员签发：<code>node scripts/add-member.mjs &lt;id&gt; &lt;名称&gt; &lt;令牌&gt;</code>，重启服务端后即可登录。
      </p>
    </el-card>
  </div>
</template>

<style scoped>
.login-page {
  display: grid;
  place-items: center;
  min-height: 100vh;
  background: var(--ca-bg);
}

.login-card {
  width: 380px;
  padding: 8px 4px;
}

.brand {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 18px;
}

.brand-mark {
  width: 40px;
  height: 40px;
  border-radius: 10px;
  display: grid;
  place-items: center;
  font-weight: 800;
  color: #fff;
  background: linear-gradient(135deg, #409eff, #36cfc9);
}

h1 {
  margin: 0;
  font-size: 18px;
}

.brand p {
  margin: 2px 0 0;
  font-size: 12px;
  color: var(--ca-muted);
}

.hint {
  margin: 14px 0 0;
  font-size: 12px;
  color: var(--ca-muted);
  line-height: 1.6;
}

code {
  background: #f0f2f5;
  padding: 1px 4px;
  border-radius: 4px;
}
</style>
