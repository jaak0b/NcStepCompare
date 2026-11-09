<script setup lang="ts" generic="T extends string">
import { nextTick } from 'vue'

const props = defineProps<{ tabs: { id: T; label: string }[]; modelValue: T }>()
const emit = defineEmits<{ 'update:modelValue': [id: T] }>()

/** Element ids shared with the tab panels, which carry the matching aria-labelledby and id. */
const tabId = (id: string) => `workflow-tab-${id}`
const panelId = (id: string) => `workflow-panel-${id}`

/** Arrow keys, Home and End move between tabs (roving tabindex). */
async function onKey(event: KeyboardEvent, index: number) {
  const n = props.tabs.length
  const next =
    event.key === 'ArrowRight' ? (index + 1) % n
    : event.key === 'ArrowLeft' ? (index - 1 + n) % n
    : event.key === 'Home' ? 0
    : event.key === 'End' ? n - 1
    : -1
  if (next < 0) return
  event.preventDefault()
  emit('update:modelValue', props.tabs[next].id)
  await nextTick()
  document.getElementById(tabId(props.tabs[next].id))?.focus()
}
</script>

<template>
  <nav class="tabs" role="tablist">
    <button
      v-for="(t, i) in tabs"
      :id="tabId(t.id)"
      :key="t.id"
      type="button"
      role="tab"
      :aria-selected="t.id === modelValue"
      :aria-controls="panelId(t.id)"
      :tabindex="t.id === modelValue ? 0 : -1"
      :class="{ active: t.id === modelValue }"
      @click="emit('update:modelValue', t.id)"
      @keydown="onKey($event, i)"
    >
      {{ t.label }}
    </button>
  </nav>
</template>

<style scoped>
.tabs {
  display: flex;
  gap: 2px;
  border-bottom: 1px solid #d6d9dd;
}
button {
  flex: 1;
  padding: 6px 4px;
  border: 1px solid transparent;
  border-bottom: none;
  border-radius: 4px 4px 0 0;
  background: none;
  font: inherit;
  color: #5b6470;
  cursor: pointer;
}
button.active {
  border-color: #d6d9dd;
  background: #fff;
  color: #1f2328;
  font-weight: 600;
  margin-bottom: -1px;
}
</style>
