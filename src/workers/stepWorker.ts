// Reads one STEP file with occt-import-js (OpenCascade compiled to WebAssembly). The WASM file is
// bundled with the app and loaded from the local server, so the model never leaves the machine.
import occtimportjs from 'occt-import-js'
import wasmUrl from 'occt-import-js/dist/occt-import-js.wasm?url'
import { readStepPart } from '../engine/stepModel'
import type { StepRequest, StepResponse } from './stepMessages'

self.onmessage = async (event: MessageEvent<StepRequest>) => {
  const { file } = event.data
  try {
    const occt = await occtimportjs({ locateFile: () => wasmUrl })
    const bytes = new Uint8Array(await file.arrayBuffer())
    const part = readStepPart(occt, bytes, file.name)
    const response: StepResponse = { ok: true, part }
    self.postMessage(response, { transfer: [part.mesh.positions.buffer, part.mesh.indices.buffer] as ArrayBuffer[] })
  } catch (err) {
    const response: StepResponse = { ok: false, message: err instanceof Error ? err.message : String(err) }
    self.postMessage(response)
  }
}
