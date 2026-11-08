<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { Box3D } from '../engine/stock'
import { ToolpathScene } from '../viewer/toolpathScene'
import type { LoadedJob } from '../workers/parseMessages'

const props = defineProps<{
  loaded: LoadedJob | null
  stockBox: Box3D | null
  hiddenToolpaths: Set<number>
  rapidsVisible: boolean
}>()

const host = ref<HTMLDivElement | null>(null)
let scene: ToolpathScene | null = null

onMounted(() => {
  scene = new ToolpathScene(host.value!)
  showJob()
})

onBeforeUnmount(() => {
  scene?.dispose()
  scene = null
})

function showJob() {
  if (!scene || !props.loaded) return
  scene.setJob(props.loaded.job.moves, props.stockBox, props.loaded.summary.bounds)
  scene.setHiddenToolpaths(props.hiddenToolpaths)
  scene.setRapidsVisible(props.rapidsVisible)
}

watch(() => props.loaded, showJob)
watch(
  () => [...props.hiddenToolpaths],
  () => scene?.setHiddenToolpaths(props.hiddenToolpaths),
)
watch(
  () => props.rapidsVisible,
  (v) => scene?.setRapidsVisible(v),
)
</script>

<template>
  <div class="viewer">
    <div ref="host" class="canvas-host"></div>
    <div class="legend">
      <span><i class="swatch cutting"></i>Cutting move</span>
      <span><i class="swatch rapid"></i>Rapid</span>
      <span><i class="swatch stock"></i>Stock</span>
    </div>
  </div>
</template>

<style scoped>
.viewer {
  position: relative;
  width: 100%;
  height: 100%;
  min-height: 300px;
}
.canvas-host {
  position: absolute;
  inset: 0;
}
.legend {
  position: absolute;
  left: 8px;
  bottom: 8px;
  display: flex;
  gap: 12px;
  background: rgba(255, 255, 255, 0.85);
  padding: 4px 8px;
  border-radius: 4px;
  font-size: 12px;
}
.swatch {
  display: inline-block;
  width: 14px;
  height: 3px;
  margin-right: 4px;
  vertical-align: middle;
}
.cutting {
  background: #1f6fd1;
}
.rapid {
  background: #e8590c;
}
.stock {
  background: #6b7280;
}
</style>
