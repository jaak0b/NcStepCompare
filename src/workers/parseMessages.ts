import type { ParsedJob } from '../engine/gcodeParser'
import type { JobSummary } from '../engine/jobSummary'

export interface ParseRequest {
  file: File
}

export type ParseResponse =
  | { ok: true; job: ParsedJob; summary: JobSummary; parseMs: number }
  | { ok: false; message: string }

export type LoadedJob = Extract<ParseResponse, { ok: true }> & { fileName: string }

/** Reads and parses a .nc file in a Web Worker. Rejects with the worker's error message. */
export function parseFileInWorker(file: File): Promise<LoadedJob> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./parseWorker.ts', import.meta.url), { type: 'module' })
    worker.onmessage = (event: MessageEvent<ParseResponse>) => {
      worker.terminate()
      const r = event.data
      if (r.ok) resolve({ ...r, fileName: file.name })
      else reject(new Error(r.message))
    }
    worker.onmessageerror = () => {
      worker.terminate()
      reject(new Error('The parse result could not be received from the parser worker.'))
    }
    worker.onerror = (event) => {
      worker.terminate()
      reject(new Error(event.message || 'The parser worker stopped unexpectedly.'))
    }
    worker.postMessage({ file } satisfies ParseRequest)
  })
}
