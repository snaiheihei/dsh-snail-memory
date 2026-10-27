import { describe, expect, it } from 'vitest'
import { invokeAuxiliaryModel, parseCandidateResponse } from '../../src/lifecycle/llm.js'

describe('auxiliary LLM calls and candidate parsing', () => {
  it('uses the injected prepared-call interface and parses valid candidates from JSON', async () => {
    const prompts: string[] = []
    const result = await invokeAuxiliaryModel({
      model: {
        async prepareCall(config) {
          expect(config).toMatchObject({ provider: 'test', model: 'aux', maxTokens: 32 })
          return {
            async *stream() {
              yield { type: 'text-delta' as const, index: 0, text: '{"candidates":[{"category":"project-convention","summary":"Run focused tests","detail":"Run focused tests first."}]}' }
            },
          }
        },
      },
      provider: 'test',
      modelName: 'aux',
      prompt: 'distill this',
      maxOutputChars: 128,
      onPrompt: prompt => prompts.push(prompt),
    })

    expect(prompts).toEqual(['distill this'])
    expect(result.candidates).toEqual([{ category: 'project-convention', summary: 'Run focused tests', detail: 'Run focused tests first.' }])
    expect(result.rejected).toBe(0)
  })

  it('accepts fenced JSON, ignores invalid candidates, and skips secret-bearing output', async () => {
    const result = await invokeAuxiliaryModel({
      model: {
        async prepareCall() {
          return {
            async *stream() {
              yield {
                type: 'text-delta' as const,
                index: 0,
                text: '```json\n[{"category":"preference","summary":"Use tabs","detail":"Use tabs."},{"category":"invalid","summary":"bad","detail":"bad"},{"category":"environment-fact","summary":"Token","detail":"token = abcdefghijkl"}]\n```',
              }
            },
          }
        },
      },
      provider: 'test',
      modelName: 'aux',
      prompt: 'distill',
    })

    expect(result.candidates).toEqual([{ category: 'preference', summary: 'Use tabs', detail: 'Use tabs.' }])
    expect(result.rejected).toBe(2)
  })

  it('rejects empty or non-JSON output without inventing candidates', async () => {
    await expect(invokeAuxiliaryModel({
      model: { async prepareCall() { return { async *stream() {} } } },
      provider: 'test',
      modelName: 'aux',
      prompt: 'review',
    })).rejects.toThrow(/empty|json/i)

    await expect(invokeAuxiliaryModel({
      model: { async prepareCall() { return { async *stream() { yield { type: 'text-delta' as const, index: 0, text: 'not json' } } } } },
      provider: 'test',
      modelName: 'aux',
      prompt: 'review',
    })).rejects.toThrow(/json/i)
  })

  it('times out a stalled model call', async () => {
    await expect(invokeAuxiliaryModel({
      model: { async prepareCall() { return { async *stream() {
        await new Promise(() => {})
        yield { type: 'text-delta' as const, index: 0, text: '' }
      } } } },
      provider: 'test',
      modelName: 'aux',
      prompt: 'review',
      timeoutMs: 1,
    })).rejects.toThrow(/timeout/i)
  })

  it('enforces output budgets and validates candidate detail length', () => {
    expect(() => parseCandidateResponse('not json', 100)).toThrow(/json/i)
    const parsed = parseCandidateResponse(JSON.stringify({ candidates: [
      { category: 'project-convention', summary: 'ok', detail: 'valid' },
      { category: 'project-convention', summary: 'too long', detail: 'x'.repeat(16_001) },
    ] }), 16_000)
    expect(parsed.candidates).toEqual([{ category: 'project-convention', summary: 'ok', detail: 'valid' }])
    expect(parsed.rejected).toBe(1)
  })
})
