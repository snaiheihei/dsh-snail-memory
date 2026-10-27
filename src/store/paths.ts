import { join } from 'node:path'

export class StorePaths {
  readonly state: string
  readonly audit: string
  readonly lock: string
  readonly details: string
  readonly global: string
  readonly workspaces: string

  constructor(readonly root: string) {
    this.state = join(root, 'state.v1.json')
    this.audit = join(root, 'audit.v1.jsonl')
    this.lock = join(root, 'lock.json')
    this.details = join(root, 'details')
    this.global = join(root, 'global')
    this.workspaces = join(root, 'workspaces')
  }

  detail(id: string): string {
    return join(this.details, `${id}.md`)
  }

  workspace(id: string): string {
    return join(this.workspaces, id)
  }
}
