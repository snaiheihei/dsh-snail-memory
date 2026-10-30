import { describe, expect, it } from 'vitest'
import type { GenerateOptions, LlmCallConfig, LlmRuntime, PreparedLlmCall } from '@deepseek-ai/dsh-llm'
import { DshAuxiliaryModel, nextDistillationBatch, resolveSessionWorkspace, selectModelRoute } from '../../src/runtime.js'

describe('dsh runtime adapters', () => {
  it('resolves workspace membership by stable session id and preserves Ungrouped', () => {
    const workspaces = [
      { id: 'workspace-1', sessionIds: ['session-1'] },
      { id: 'workspace-2', sessionIds: ['session-2'] },
    ]

    expect(resolveSessionWorkspace(workspaces, 'session-2')).toBe('workspace-2')
    expect(resolveSessionWorkspace(workspaces, 'missing')).toBeUndefined()
  })

  it('uses an explicit auxiliary route first, then a live agent route', () => {
    const agents = [{ options: { provider: 'live-provider', model: 'live-model' } }]
    expect(selectModelRoute(agents, { provider: 'configured', model: 'fixed' })).toEqual({ provider: 'configured', model: 'fixed' })
    expect(selectModelRoute(agents)).toEqual({ provider: 'live-provider', model: 'live-model' })
    expect(selectModelRoute([{ options: {} }])).toBeUndefined()
  })

  it('renders durable conversation and tool evidence without reinjecting memory snapshots', () => {
    const transcript = nextDistillationBatch([
      { seq: 1, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'Build failed' }] } },
      { seq: 2, type: 'user/message', data: { source: { kind: 'snail-memory' }, content: [{ type: 'text', text: 'old memory' }] } },
      { seq: 3, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'Use the focused test' }] } } },
      { seq: 4, type: 'tool/result', data: { message: { content: [{ type: 'text', text: '6 tests passed' }] } } },
      { seq: 5, type: 'request/context', data: { content: [{ type: 'text', text: 'hidden context' }] } },
    ], { lastEventSeq: 0, offset: 0 }, 48_000).text

    expect(transcript).toContain('Build failed')
    expect(transcript).toContain('Use the focused test')
    expect(transcript).toContain('6 tests passed')
    expect(transcript).not.toContain('old memory')
    expect(transcript).not.toContain('hidden context')
  })

  it('excludes snail memory read and feedback results while preserving other tool evidence', () => {
    const transcript = nextDistillationBatch([
      { seq: 1, type: 'tool/call', data: { callId: 'call-memory', name: 'snail_memory_read', arguments: '{}' } },
      { seq: 2, type: 'tool/result', data: { message: { source: { kind: 'tool', callId: 'call-memory' }, content: [{ type: 'text', text: 'full memory detail' }] } } },
      { seq: 3, type: 'tool/call', data: { callId: 'call-feedback', name: 'snail_memory_feedback', arguments: '{}' } },
      { seq: 4, type: 'tool/result', data: { message: { source: { kind: 'tool', callId: 'call-feedback' }, content: [{ type: 'text', text: 'feedback rank receipt' }] } } },
      { seq: 5, type: 'tool/call', data: { callId: 'call-test', name: 'run_tests', arguments: '{}' } },
      { seq: 6, type: 'tool/result', data: { message: { source: { kind: 'tool', callId: 'call-test' }, content: [{ type: 'text', text: '6 tests passed' }] } } },
    ], { lastEventSeq: 0, offset: 0 }, 48_000).text

    expect(transcript).not.toContain('full memory detail')
    expect(transcript).not.toContain('feedback rank receipt')
    expect(transcript).toContain('6 tests passed')
  })

  it('batches complete turns at stable event boundaries', () => {
    const events = [
      { seq: 10, type: 'user/message', data: { turnId: 'turn-1', source: { kind: 'user' }, content: [{ type: 'text', text: 'first' }] } },
      { seq: 20, type: 'assistant/message', data: { turnId: 'turn-1', message: { content: [{ type: 'text', text: 'second' }] } } },
      { seq: 30, type: 'user/message', data: { turnId: 'turn-2', source: { kind: 'user' }, content: [{ type: 'text', text: 'third' }] } },
    ]
    const firstTurn = nextDistillationBatch(events.slice(0, 2), { lastEventSeq: 0, offset: 0 }, 48_000).text

    const first = nextDistillationBatch(events, { lastEventSeq: 0, offset: 0 }, firstTurn.length)
    const second = nextDistillationBatch(events, first.cursor, 24_000)

    expect(first.text).toBe(firstTurn)
    expect(first.cursor).toMatchObject({ lastEventSeq: 20, offset: 0 })
    expect(first.eventSeqs).toEqual([10, 20])
    expect(second.text).toContain('third')
    expect(second.cursor).toMatchObject({ lastEventSeq: 30, offset: 0 })
  })

  it('uses deterministic intra-event offsets for oversized turns and messages', () => {
    const events = [
      { seq: 7, type: 'user/message', data: { turnId: 'large-turn', source: { kind: 'user' }, content: [{ type: 'text', text: 'a'.repeat(35) }] } },
      { seq: 8, type: 'assistant/message', data: { turnId: 'large-turn', message: { content: [{ type: 'text', text: 'b'.repeat(35) }] } } },
    ]
    const expected = nextDistillationBatch(events, { lastEventSeq: 0, offset: 0 }, 48_000).text
    let cursor = { lastEventSeq: 0, offset: 0 }
    let reconstructed = ''

    for (let count = 0; count < 10 && (cursor.lastEventSeq < 8 || cursor.offset > 0); count += 1) {
      const batch = nextDistillationBatch(events, cursor, 40)
      reconstructed += batch.text
      cursor = batch.cursor
    }

    expect(reconstructed).toBe(expected)
    expect(cursor).toEqual({ lastEventSeq: 8, offset: 0 })
  })

  it('keeps the prepared config immutable across the one-shot auxiliary dispatch', async () => {
    const config: LlmCallConfig = { provider: 'provider', model: 'model', maxTokens: 128 }
    let preparedSignal: AbortSignal | undefined
    let dispatched: GenerateOptions | undefined
    const prepared = {
      config,
      async *stream(options: GenerateOptions) {
        dispatched = options
        yield { type: 'text-delta', index: 0, text: '{"candidates":[]}' }
      },
    } as unknown as PreparedLlmCall
    const runtime = {
      prepareCall(received: LlmCallConfig, signal?: AbortSignal) {
        expect(received).toEqual({ provider: 'provider', model: 'model', maxTokens: 128 })
        preparedSignal = signal
        return Promise.resolve(prepared)
      },
    } as unknown as LlmRuntime
    const model = new DshAuxiliaryModel(runtime)
    const controller = new AbortController()

    const call = await model.prepareCall({ provider: 'provider', model: 'model', maxTokens: 128, signal: controller.signal })
    const chunks: unknown[] = []
    for await (const chunk of call.stream({
      provider: 'provider', model: 'model', maxTokens: 128,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'untrusted input' }] }],
      signal: controller.signal,
    })) chunks.push(chunk)

    expect(preparedSignal).toBe(controller.signal)
    expect(dispatched).toEqual({
      ...config,
      system: expect.stringContaining('untrusted'),
      messages: [{ role: 'user', content: [{ type: 'text', text: 'untrusted input' }] }],
      signal: controller.signal,
    })
    expect(chunks).toEqual([{ type: 'text-delta', index: 0, text: '{"candidates":[]}' }])
  })
})
