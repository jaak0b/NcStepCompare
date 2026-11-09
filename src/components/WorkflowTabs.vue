<script setup lang="ts" generic="T extends string">
defineProps<{ tabs: { id: T; label: string }[]; modelValue: T }>()
const emit = defineEmits<{ 'update:modelValue': [id: T] }>()
</script>

<template>
  <nav class="tabs" role="tablist">
    <button
      v-for="t in tabs"
      :key="t.id"
      type="button"
      role="tab"
      :aria-selected="t.id === modelValue"
      :class="{ active: t.id === modelValue }"
      @click="emit('update:modelValue', t.id)"
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
