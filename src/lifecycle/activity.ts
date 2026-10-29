import { appendFile, mkdir, rename, rm, stat } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { DistillationCursorPosition } from '../runtime.js'

export const DEFAULT_ACTIVITY_MAX_BYTES = 1_048_576
export const DEFAULT_ACTIVITY_RETAINED_FILES = 3

export type LifecycleOperation = 'review' | 'idle' | 'stop' | 'consolidate' | 'global-consolidate' | 'retention'
export type LifecycleActivityEvent = 'intent-created' | 'run-started' | 'batch-completed'
  | 'run-succeeded' | 'run-skipped' | 'run-failed' | 'retry-scheduled'
export type LifecycleSkipReason = 'workspace-unassigned' | 'no-new-events' | 'workspace-clean'
export type LifecycleErrorCategory = 'model-route-missing' | 'model-request-failed' | 'model-output-invalid'
  | 'store-readonly' | 'operation-aborted' | 'operation-failed'

export interface LifecycleActivityRecord {
  readonly formatVersion: 1
  readonly time: string
  readonly event: LifecycleActivityEvent
  readonly operation: LifecycleOperation
  readonly intentId: string
  readonly sessionId?: string
  readonly workspaceId?: string
  readonly durationMs?: number
  readonly batches?: number
  readonly batch?: number
  readonly written?: number
  readonly rejected?: number
  readonly processed?: boolean
  readonly hasMore?: boolean
  readonly cursor?: DistillationCursorPosition
  readonly skipReason?: LifecycleSkipReason
  readonly error?: LifecycleErrorCategory
  readonly retryAt?: string
  readonly retryIntentId?: string
}

export interface LifecycleBatchResult {
  readonly written: number
  readonly rejected: number
  readonly cursor: DistillationCursorPosition
}

export interface LifecycleRunResult {
  readonly written: number
  readonly batches: number
  readonly processed: boolean
  readonly batchResults?: readonly LifecycleBatchResult[]
  readonly hasMore?: boolean
  readonly skipReason?: LifecycleSkipReason
}

export interface LifecycleActivitySink {
  record(record: LifecycleActivityRecord): void
  flush?(): Promise<void>
}

export interface LifecycleActivityFileOptions {
  readonly file: string
  readonly maxBytes?: number
  readonly retainedFiles?: number
  readonly onError?: () => void
}

function sanitizedRecord(record: LifecycleActivityRecord): LifecycleActivityRecord {
  return {
    formatVersion: 1,
    time: record.time,
    event: record.event,
    operation: record.operation,
    intentId: record.intentId,
    ...(record.sessionId === undefined ? {} : { sessionId: record.sessionId }),
    ...(record.workspaceId === undefined ? {} : { workspaceId: record.workspaceId }),
    ...(record.durationMs === undefined ? {} : { durationMs: record.durationMs }),
    ...(record.batches === undefined ? {} : { batches: record.batches }),
    ...(record.batch === undefined ? {} : { batch: record.batch }),
    ...(record.written === undefined ? {} : { written: record.written }),
    ...(record.rejected === undefined ? {} : { rejected: record.rejected }),
    ...(record.processed === undefined ? {} : { processed: record.processed }),
    ...(record.hasMore === undefined ? {} : { hasMore: record.hasMore }),
    ...(record.cursor === undefined ? {} : {
      cursor: { lastEventSeq: record.cursor.lastEventSeq, offset: record.cursor.offset },
    }),
    ...(record.skipReason === undefined ? {} : { skipReason: record.skipReason }),
    ...(record.error === undefined ? {} : { error: record.error }),
    ...(record.retryAt === undefined ? {} : { retryAt: record.retryAt }),
    ...(record.retryIntentId === undefined ? {} : { retryIntentId: record.retryIntentId }),
  }
}

/** Append-only operational history. It is never authoritative and never rejects lifecycle work. */
export class LifecycleActivityFileSink implements LifecycleActivitySink {
  private queue: Promise<void> = Promise.resolve()
  private closed = false
  private readonly maxBytes: number
  private readonly retainedFiles: number

  constructor(private readonly options: LifecycleActivityFileOptions) {
    this.maxBytes = options.maxBytes ?? DEFAULT_ACTIVITY_MAX_BYTES
    this.retainedFiles = options.retainedFiles ?? DEFAULT_ACTIVITY_RETAINED_FILES
    if (!Number.isSafeInteger(this.maxBytes) || this.maxBytes <= 0) throw new Error('Activity maxBytes must be positive')
    if (!Number.isSafeInteger(this.retainedFiles) || this.retainedFiles < 0) {
      throw new Error('Activity retainedFiles must be non-negative')
    }
  }

  record(record: LifecycleActivityRecord): void {
    if (this.closed) return
    const line = `${JSON.stringify(sanitizedRecord(record))}\n`
    this.queue = this.queue.then(() => this.append(line)).catch(() => {
      try {
        this.options.onError?.()
      } catch {
        // Logging diagnostics must not affect memory maintenance.
      }
    })
  }

  flush(): Promise<void> {
    return this.queue
  }

  async close(): Promise<void> {
    this.closed = true
    await this.flush()
  }

  private async append(line: string): Promise<void> {
    await mkdir(dirname(this.options.file), { recursive: true })
    const size = await this.fileSize(this.options.file)
    if (size > 0 && size + Buffer.byteLength(line, 'utf8') > this.maxBytes) await this.rotate()
    await appendFile(this.options.file, line, 'utf8')
  }

  private async rotate(): Promise<void> {
    if (this.retainedFiles === 0) {
      await rm(this.options.file, { force: true })
      return
    }
    await rm(`${this.options.file}.${this.retainedFiles}`, { force: true })
    for (let generation = this.retainedFiles - 1; generation >= 1; generation -= 1) {
      await this.renameIfPresent(`${this.options.file}.${generation}`, `${this.options.file}.${generation + 1}`)
    }
    await this.renameIfPresent(this.options.file, `${this.options.file}.1`)
  }

  private async fileSize(file: string): Promise<number> {
    try {
      return (await stat(file)).size
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0
      throw error
    }
  }

  private async renameIfPresent(from: string, to: string): Promise<void> {
    try {
      await rename(from, to)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
}
