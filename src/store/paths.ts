import { join } from 'node:path'

export class StorePaths {
  readonly state: string
  readonly legacyState: string
  readonly audit: string
  readonly lock: string
  readonly detailData: string
  readonly projectionPending: string
  readonly details: string
  readonly global: string
  readonly workspaces: string

  constructor(readonly root: string) {
    this.state = join(root, 'state.v2.json')
    this.legacyState = join(root, 'state.v1.json')
    this.audit = join(root, 'audit.v1.jsonl')
    this.lock = join(root, 'lock.json')
    this.detailData = join(root, 'detail-data')
    this.projectionPending = join(root, 'projection-pending.v1.json')
    this.details = join(root, 'details')
    this.global = join(root, 'global')
    this.workspaces = join(root, 'workspaces')
  }

  detailDataDirectory(id: string): string {
    return join(this.detailData, id)
  }

  detailRecord(id: string, revision: number): string {
    return join(this.detailDataDirectory(id), `${revision}.json`)
  }

  detail(id: string): string {
    return join(this.details, `${id}.md`)
  }

  detailDirectory(id: string): string {
    return join(this.details, id)
  }

  detailChunk(id: string, chunkId: string): string {
    return join(this.detailDirectory(id), `${chunkId}.md`)
  }

  workspace(id: string): string {
    return join(this.workspaces, id)
  }
}
