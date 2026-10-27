import { readFile } from 'node:fs/promises'
import * as React from 'react'
import * as jsxRuntime from 'react/jsx-runtime'
import { describe, expect, it } from 'vitest'
// @ts-expect-error -- The executable JavaScript build script intentionally has no declaration artifact.
import { buildClient, CLIENT_EXTERNALS } from '../../scripts/build-client.mjs'

describe('client handoff build', () => {
  it('declares the client packages that own its slots and locale', async () => {
    const manifest = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8')) as {
      dsh: { client: { inject?: string[] } }
    }

    expect(manifest.dsh.client.inject).toEqual(expect.arrayContaining([
      '@deepseek-ai/dsh-client-locale',
      '@deepseek-ai/dsh-client-ui-conversation',
      '@deepseek-ai/dsh-client-ui-layout',
      '@deepseek-ai/dsh-client-ui-sidebar',
    ]))
  })

  it('builds one ModuleLoader file with the plugin id and external React/dsh modules', async () => {
    const code = await buildClient({ write: false })

    expect(code).toContain('window.__ModuleLoader__.load')
    expect(code).toContain('dsh-snail-memory')
    expect(code).toContain('require("react/jsx-runtime")')
    expect(code).not.toMatch(/^\s*import\s+/m)
    expect(CLIENT_EXTERNALS).toContain('react')
    expect(CLIENT_EXTERNALS).toContain('react/jsx-runtime')
    expect(CLIENT_EXTERNALS).toContain('@deepseek-ai/*')

    let registration: { id: string; factory: (require: (id: string) => unknown) => unknown } | undefined
    const window = { __ModuleLoader__: { load(value: typeof registration) { registration = value } } }
    new Function('window', code)(window)
    expect(registration?.id).toBe('dsh-snail-memory')
    expect(registration?.factory).toBeTypeOf('function')
  })

  it('returns plain Cordis plugin properties after executing the factory', async () => {
    const code = await buildClient({ write: false })
    let registration: { id: string; factory: (require: (id: string) => unknown) => unknown } | undefined
    const window = { __ModuleLoader__: { load(value: typeof registration) { registration = value } } }
    new Function('window', code)(window)

    const exported = registration?.factory((id) => {
      if (id === 'react') return React
      if (id === 'react/jsx-runtime') return jsxRuntime
      throw new Error(`Unexpected bundled dependency: ${id}`)
    }) as Record<string, unknown>

    expect(exported.apply).toBeTypeOf('function')
    expect(exported.inject).toEqual(['slots', 'locale'])
    expect(Object.getOwnPropertyDescriptor(exported, 'apply')).toMatchObject({ enumerable: true, writable: true })
    expect(Object.getOwnPropertyDescriptor(exported, 'inject')).toMatchObject({ enumerable: true, writable: true })
  })
})
