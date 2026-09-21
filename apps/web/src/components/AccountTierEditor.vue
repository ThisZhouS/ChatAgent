<script setup lang="ts">
import { computed } from 'vue';
import type { AgentContactTier } from '@chatagent/contracts';

/**
 * Contact tiers decide what an assistant may do with a message from a person:
 * confirm (default) needs the owner's approval for side effects, chat may only talk and
 * read documents, ignore never reaches the assistant at all. The owner tier is derived
 * from account ownership and is deliberately not offered here.
 *
 * Deliberately not built on el-form-item: it injects a form context and renders nothing
 * without one, which would make the whole panel disappear wherever it is embedded.
 */
export interface TierRow {
  memberId: string;
  tier: AgentContactTier;
}

const props = defineProps<{
  defaultTier: AgentContactTier;
  tiers: TierRow[];
}>();

const emit = defineEmits<{
  (event: 'update:defaultTier', value: AgentContactTier): void;
  (event: 'update:tiers', value: TierRow[]): void;
}>();

const TIERS: Array<{ value: AgentContactTier; label: string; hint: string }> = [
  { value: 'confirm', label: '确认级', hint: '可以规划与回复；副作用需负责人确认' },
  { value: 'chat', label: '聊天级', hint: '仅会话与读文档；发送/写文件工具关闭' },
  { value: 'ignore', label: '忽略级', hint: '消息不交给助手（仍作为聊天消息投递）' },
];

const rows = computed(() => props.tiers);
const currentHint = computed(
  () => TIERS.find((item) => item.value === props.defaultTier)?.hint ?? '',
);

function addRow() {
  emit('update:tiers', [...rows.value, { memberId: '', tier: 'confirm' }]);
}

function removeRow(index: number) {
  emit(
    'update:tiers',
    rows.value.filter((_, position) => position !== index),
  );
}

function setMember(index: number, memberId: string) {
  emit(
    'update:tiers',
    rows.value.map((row, position) => (position === index ? { ...row, memberId } : row)),
  );
}

function setTier(index: number, tier: AgentContactTier) {
  emit(
    'update:tiers',
    rows.value.map((row, position) => (position === index ? { ...row, tier } : row)),
  );
}
</script>

<template>
  <div class="tier-editor">
    <label class="tier-label">未单独设定的联系人</label>
    <el-select
      :model-value="defaultTier"
      style="width: 100%"
      data-testid="default-tier"
      @update:model-value="emit('update:defaultTier', $event)"
    >
      <el-option
        v-for="item in TIERS"
        :key="item.value"
        :label="item.label + ' — ' + item.hint"
        :value="item.value"
      />
    </el-select>
    <p class="muted" data-testid="default-tier-hint">{{ currentHint }}</p>

    <label class="tier-label">按联系人设定（成员 ID → 等级）</label>
    <div class="tier-rows" data-testid="contact-tiers">
      <div v-for="(row, index) in rows" :key="index" class="tier-row">
        <el-input
          :model-value="row.memberId"
          placeholder="成员 ID"
          class="tier-member"
          data-testid="tier-member"
          @update:model-value="setMember(index, $event)"
        />
        <el-select
          :model-value="row.tier"
          class="tier-select"
          data-testid="tier-select"
          @update:model-value="setTier(index, $event)"
        >
          <el-option v-for="item in TIERS" :key="item.value" :label="item.label" :value="item.value" />
        </el-select>
        <el-button text type="danger" data-testid="tier-remove" @click="removeRow(index)">
          移除
        </el-button>
      </div>
      <el-button size="small" data-testid="tier-add" @click="addRow">添加联系人</el-button>
    </div>
    <p class="muted">
      留空的成员 ID 不会保存；删除某一行即恢复为上面的默认等级。负责人本人与组织管理员始终按主权限处理。
    </p>
  </div>
</template>

<style scoped>
.tier-label {
  display: block;
  margin: 12px 0 6px;
  font-size: 13px;
  color: var(--el-text-color-regular);
}
.tier-row {
  display: flex;
  gap: 8px;
  align-items: center;
  margin-bottom: 8px;
}
.tier-member {
  flex: 1;
}
.tier-select {
  width: 120px;
}
</style>
