<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import type { MemberView } from '@chatagent/contracts';
import { api, hasSessionToken, onUnauthorized, setSessionToken } from './api';
import AccountsView from './views/AccountsView.vue';
import ApprovalsView from './views/ApprovalsView.vue';
import ChatView from './views/ChatView.vue';
import DashboardView from './views/DashboardView.vue';
import DocumentsView from './views/DocumentsView.vue';
import LoginView from './views/LoginView.vue';
import MembersView from './views/MembersView.vue';
import SettingsView from './views/SettingsView.vue';
import TasksView from './views/TasksView.vue';

type ViewKey =
  | 'chat'
  | 'dashboard'
  | 'tasks'
  | 'approvals'
  | 'documents'
  | 'accounts'
  | 'members'
  | 'settings';

const views = {
  chat: ChatView,
  dashboard: DashboardView,
  tasks: TasksView,
  approvals: ApprovalsView,
  documents: DocumentsView,
  accounts: AccountsView,
  members: MembersView,
  settings: SettingsView,
} as const;

const view = ref<ViewKey>('chat');
const session = ref<MemberView | null>(null);
const booting = ref(true);
const dark = ref(readTheme() === 'dark');
const unread = ref(0);
let unsubscribe: (() => void) | undefined;

function readTheme(): 'dark' | 'light' {
  try {
    const stored = window.localStorage.getItem('chatagent.theme');
    if (stored === 'dark' || stored === 'light') return stored;
  } catch {
    // Storage may be unavailable; fall back to the system preference.
  }
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function applyTheme() {
  document.documentElement.classList.toggle('dark', dark.value);
  try {
    window.localStorage.setItem('chatagent.theme', dark.value ? 'dark' : 'light');
  } catch {
    // Ignore storage failures.
  }
}

function toggleTheme() {
  dark.value = !dark.value;
  applyTheme();
}

onMounted(async () => {
  applyTheme();
  unsubscribe = onUnauthorized(() => {
    session.value = null;
  });

  if (hasSessionToken()) {
    try {
      session.value = await api.auth.me();
    } catch {
      setSessionToken(null);
    }
  }
  booting.value = false;
});

onUnmounted(() => unsubscribe?.());

const currentView = computed(() => views[view.value]);
function onUnreadTotal(count: number) {
  unread.value = count;
}

const viewProps = computed(() =>
  view.value === 'chat' || view.value === 'members' || view.value === 'approvals' || view.value === 'settings'
    ? { me: session.value }
    : {},
);

function navigate(key: string) {
  if (key in views) view.value = key as ViewKey;
}

function onLoggedIn(member: MemberView) {
  session.value = member;
  view.value = 'chat';
}

async function logout() {
  try {
    await api.auth.logout();
  } catch {
    // The local session is cleared regardless of the server response.
  }
  setSessionToken(null);
  session.value = null;
}
</script>

<template>
  <div v-if="booting" class="booting">正在加载 ChatAgent…</div>

  <LoginView v-else-if="!session" @logged-in="onLoggedIn" />

  <el-container v-else class="app">
    <el-aside width="232px" class="sidebar">
      <div class="brand">
        <div class="brand-mark">CA</div>
        <div>
          <h1>ChatAgent</h1>
          <p>{{ session.displayName }}</p>
        </div>
      </div>
      <el-menu :default-active="view" class="menu" @select="navigate">
        <el-menu-item index="chat">
          <el-icon><ChatDotRound /></el-icon>
          <span>聊天</span>
          <el-badge v-if="unread > 0" :value="unread" class="menu-badge" />
        </el-menu-item>
        <el-menu-item index="dashboard">
          <el-icon><DataBoard /></el-icon>
          <span>工作台</span>
        </el-menu-item>
        <el-menu-item index="tasks">
          <el-icon><Finished /></el-icon>
          <span>任务</span>
        </el-menu-item>
        <el-menu-item index="approvals">
          <el-icon><Stamp /></el-icon>
          <span>审批</span>
        </el-menu-item>
        <el-menu-item index="documents">
          <el-icon><Document /></el-icon>
          <span>文件</span>
        </el-menu-item>
        <el-menu-item index="accounts">
          <el-icon><User /></el-icon>
          <span>账号</span>
        </el-menu-item>
        <el-menu-item index="members">
          <el-icon><UserFilled /></el-icon>
          <span>成员</span>
        </el-menu-item>
        <el-menu-item index="settings">
          <el-icon><Setting /></el-icon>
          <span>设置</span>
        </el-menu-item>
      </el-menu>
      <div class="sidebar-footer">
        <el-button size="small" style="width: 100%" @click="toggleTheme">
          {{ dark ? '浅色模式' : '深色模式' }}
        </el-button>
        <el-button size="small" style="width: 100%; margin: 8px 0 0" @click="logout">
          退出登录
        </el-button>
      </div>
    </el-aside>

    <el-main class="content">
      <component
        :is="currentView"
        v-bind="viewProps"
        @navigate="navigate"
        @unread-total="onUnreadTotal"
      />
    </el-main>
  </el-container>
</template>

<style scoped>
.booting {
  display: grid;
  place-items: center;
  min-height: 100vh;
  color: var(--ca-muted);
}

.sidebar-footer {
  margin-top: auto;
  padding: 12px;
}

.menu-badge {
  margin-left: 8px;
}
</style>
