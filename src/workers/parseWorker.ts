// Parses a .nc file off the main thread so the UI stays responsive on large programs.
import { parseGcode } from '../engine/gcodeParser'
import { summarizeJob } from '../engine/jobSummary'
import { moveListBuffers } from '../engine/moveList'
import type { ParseRequest, ParseResponse } from './parseMessages'

self.onmessage = async (event: MessageEvent<ParseRequest>) => {
  let response: ParseResponse
  let transfer: ArrayBuffer[] = []
  try {
    const t0 = performance.now()
    const text = await event.data.file.text()
    const job = parseGcode(text)
    if (job.refusal) {
      self.postMessage({ ok: false, message: job.refusal.message } satisfies ParseResponse)
      return
    }
    const summary = summarizeJob(job)
    response = { ok: true, job, summary, parseMs: performance.now() - t0 }
    transfer = moveListBuffers(job.moves)
  } catch (err) {
    response = { ok: false, message: err instanceof Error ? err.message : String(err) }
  }
  self.postMessage(response, { transfer })
}
