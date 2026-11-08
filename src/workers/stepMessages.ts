import type { StepPart } from '../engine/stepModel'

export interface StepRequest {
  file: File
  /** Tessellation chord deviation, mm. */
  deflection: number
}

export type StepResponse = { ok: true; part: StepPart } | { ok: false; message: string }

/** Reads a STEP file in a Web Worker. Rejects with the worker's error message. */
export function readStepInWorker(file: File, deflection: number): Promise<StepPart> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./stepWorker.ts', import.meta.url), { type: 'module' })
    worker.onmessage = (event: MessageEvent<StepResponse>) => {
      worker.terminate()
      const r = event.data
      if (r.ok) resolve(r.part)
      else reject(new Error(r.message))
    }
    worker.onmessageerror = () => {
      worker.terminate()
      reject(new Error('The STEP model could not be received from the STEP worker.'))
    }
    worker.onerror = (event) => {
      worker.terminate()
      reject(new Error(event.message || 'The STEP worker stopped unexpectedly.'))
    }
    worker.postMessage({ file, deflection } satisfies StepRequest)
  })
}
