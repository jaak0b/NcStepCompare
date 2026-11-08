<script setup lang="ts">
import { computed, ref, shallowRef } from 'vue'
import JobSummary from './components/JobSummary.vue'
import ToolpathViewer from './components/ToolpathViewer.vue'
import { stockBoxInWorkCoordinates } from './engine/stock'
import { parseFileInWorker, type LoadedJob } from './workers/parseMessages'

// shallowRef: the move list holds large typed arrays that must not become reactive proxies.
const loaded = shallowRef<LoadedJob | null>(null)
const loading = ref(false)
const error = ref<string | null>(null)
const hiddenToolpaths = ref(new Set<number>())
const rapidsVisible = ref(true)

const stockBox = computed(() => {
  const h = loaded.value?.job.header
  if (!h?.stock || !h.workOrigin) return null
  return stockBoxInWorkCoordinates(h.stock, h.workOrigin)
})

async function onFileChosen(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return
  loading.value = true
  error.value = null
  try {
    const result = await parseFileInWorker(file)
    hiddenToolpaths.value = new Set()
    loaded.value = result
  } catch (err) {
    error.value = `Could not read ${file.name}: ${err instanceof Error ? err.message : String(err)}`
  } finally {
    loading.value = false
    input.value = ''
  }
}

function toggleToolpath(number: number) {
  const next = new Set(hiddenToolpaths.value)
  if (next.has(number)) next.delete(number)
  else next.add(number)
  hiddenToolpaths.value = next
}

function setAllToolpaths(visible: boolean) {
  hiddenToolpaths.value = visible
    ? new Set()
    : new Set(loaded.value?.summary.toolpaths.map((t) => t.number) ?? [])
}
</script>

<template>
  <div class="layout">
    <aside class="side">
      <header>
        <h1>NcStepCompare</h1>
        <label class="file">
          Open G-code file (.nc)
          <input type="file" accept=".nc,.gcode,.ngc,.tap,.txt" :disabled="loading" @change="onFileChosen" />
        </label>
        <p v-if="loading" class="status">Reading and parsing the file.</p>
        <p v-if="error" class="error">{{ error }}</p>
      </header>
      <JobSummary
        v-if="loaded"
        v-model:rapids-visible="rapidsVisible"
        :loaded="loaded"
        :stock-box="stockBox"
        :hidden-toolpaths="hiddenToolpaths"
        @toggle-toolpath="toggleToolpath"
        @set-all-toolpaths="setAllToolpaths"
      />
      <p v-else-if="!loading" class="status">Open a .nc file to view its toolpaths.</p>
    </aside>
    <main class="view">
      <ToolpathViewer
        :loaded="loaded"
        :stock-box="stockBox"
        :hidden-toolpaths="hiddenToolpaths"
        :rapids-visible="rapidsVisible"
      />
    </main>
  </div>
</template>

<style scoped>
.layout {
  display: grid;
  grid-template-columns: minmax(360px, 520px) 1fr;
  height: 100vh;
}
.side {
  overflow: auto;
  padding: 12px;
  border-right: 1px solid #d6d9dd;
  background: #fff;
}
h1 {
  font-size: 18px;
  margin: 0 0 8px;
}
.file {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-bottom: 8px;
  font-weight: 600;
}
.status {
  color: #5b6470;
}
.error {
  color: #b42318;
}
.view {
  position: relative;
  min-width: 0;
}
@media (max-width: 800px) {
  .layout {
    grid-template-columns: 1fr;
    grid-template-rows: auto 60vh;
    height: auto;
  }
}
</style>
