import { build } from 'esbuild'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const CLIENT_EXTERNALS = [
  'react', 'react/*', 'react/jsx-runtime', 'react-dom', 'react-dom/*', '@deepseek-ai/*',
]

export async function buildClient(options = {}) {
  const write = options.write ?? true
  const outfile = options.outfile ?? resolve(ROOT, 'dist/client.js')
  const result = await build({
    absWorkingDir: ROOT,
    entryPoints: ['client/src/entry.tsx'],
    bundle: true,
    write: false,
    format: 'cjs',
    platform: 'browser',
    target: 'es2020',
    jsx: 'automatic',
    external: CLIENT_EXTERNALS,
    logLevel: 'silent',
  })
  if (result.outputFiles.length !== 1) throw new Error(`Expected one client artifact, received ${result.outputFiles.length}.`)
  const body = result.outputFiles[0].text
  const code = `window.__ModuleLoader__.load({ id: "dsh-snail-memory", factory: (require) => {
var module = { exports: {} }; var exports = module.exports;
${body}
var plugin = {};
for (var key in module.exports) plugin[key] = module.exports[key];
Object.defineProperty(plugin, Symbol.toStringTag, { value: "Module" });
return plugin;
} });
`
  if (write) {
    await mkdir(dirname(outfile), { recursive: true })
    await writeFile(outfile, code, 'utf8')
  }
  return code
}

if (process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  await buildClient()
}
