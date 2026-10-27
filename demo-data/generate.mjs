import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { MemoryStore } from '../dist/store/store.js'
import { MemoryContextService } from '../dist/context/service.js'

// 仅生成虚构演示数据，不读取或修改真实的 ~/.dsh/snail_memory。
const root = fileURLToPath(new URL('./snail_memory/', import.meta.url))
const now = () => new Date('2026-10-27T08:00:00.000Z')
const globalScope = { kind: 'global' }
const workspaceScope = { kind: 'workspace', workspaceId: 'workspace-demo' }

const longDetail = Array.from({ length: 60 }, (_, index) => [
  `### 虚构排查记录 ${String(index + 1).padStart(2, '0')}`,
  '这一段是专门用于展示大详情分片格式的测试文字，不代表任何真实项目、真实故障或真实操作结论。'.repeat(3),
  '实际使用时，详情可以记录复现步骤、诊断证据、处理过程和最后验证时间；索引与快照仍然只保留父条目的摘要。'.repeat(2),
].join('\n')).join('\n\n')

const store = await MemoryStore.open({ root, now, heartbeatMs: 60_000 })
try {
  await store.upsert({
    id: 'demo-global-preference',
    scope: globalScope,
    category: 'preference',
    summary: '【测试】技术说明先给结论，再解释关键原因',
    detail: '这是一条虚构的全局偏好记忆。回答技术问题时，先给出可直接使用的结论，再补充必要的原因、限制条件和验证方法。',
    sourceRefs: [{ sessionId: 'session-demo-source-001', eventSeqs: [12, 13] }],
    lastVerifiedAt: '2026-10-26T09:30:00.000Z',
  })

  await store.upsert({
    id: 'demo-global-runbook',
    scope: globalScope,
    category: 'troubleshooting',
    summary: '【测试】大详情会拆成 part-001、part-002 等分片',
    detail: longDetail,
    sourceRefs: [{ sessionId: 'session-demo-source-002', eventSeqs: [21] }],
    lastVerifiedAt: '2026-10-20T14:00:00.000Z',
  })

  await store.upsert({
    id: 'demo-workspace-convention',
    scope: workspaceScope,
    category: 'project-convention',
    summary: '【测试】修改记忆逻辑后运行 store 与 context 测试',
    detail: '这是一条虚构的 workspace 项目约定。演示命令：npm run test -- tests/store tests/context。该命令仅用于展示数据格式。',
    sourceRefs: [{ sessionId: 'session-demo-source-003', eventSeqs: [8, 9, 10] }],
    lastVerifiedAt: '2026-10-27T07:45:00.000Z',
  })

  const sessionId = 'session-demo-001'
  const injected = []
  const agent = {
    session: { id: sessionId },
    inject(message) { injected.push(message) },
  }
  const context = new MemoryContextService(store, { now, maxSnapshotTokens: 1_200 })

  // 生成 global 与 workspace 两份 desired 快照。
  await context.enable(agent, 'global')
  await context.enable(agent, 'workspace', 'workspace-demo')

  // 模拟 dsh 的 post-commit user/message 事件，让示例同时具有 committed 记录。
  for (const message of injected) {
    await context.handleSessionEvent(sessionId, { type: 'user/message', data: message })
  }

  await store.updateMeta(meta => {
    meta.dirty = false
    meta.lastConsolidationAt = '2026-10-27T07:50:00.000Z'
    meta.lastRetentionAt = '2026-10-27T06:00:00.000Z'
    meta.nextRetentionAt = '2026-10-28T06:00:00.000Z'
  })
} finally {
  await store.close()
}

// 真实 Host 正常运行时持有锁，正常关闭时删除。这里仅为展示文件格式而补一份虚构锁。
await writeFile(join(root, 'lock.json'), JSON.stringify({
  writerId: '00000000-0000-4000-8000-000000000001',
  heartbeatAt: '2026-10-27T08:00:00.000Z',
}), 'utf8')

console.log(`Demo data written to: ${root}`)
console.log('All entries, sessions, source references, and lock data are fictional.')
