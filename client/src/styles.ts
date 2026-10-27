export const MEMORY_STYLES = `
.snail-memory-controls { display: flex; align-items: center; gap: 4px; min-width: 0; }
.snail-memory-layer { display: flex; align-items: center; gap: 3px; min-width: 0; }
.snail-memory-controls button, .snail-memory-page button { min-height: 30px; font: inherit; }
.snail-memory-controls button { padding: 3px 7px; white-space: nowrap; }
.snail-memory-status { font-size: 11px; white-space: nowrap; }
.snail-memory-feedback { max-width: 240px; font-size: 11px; overflow-wrap: anywhere; }
.snail-memory-page { box-sizing: border-box; width: 100%; max-width: 1080px; min-width: 0; margin: 0 auto; padding: 24px; overflow-x: hidden; }
.snail-memory-page *, .snail-memory-page *::before, .snail-memory-page *::after { box-sizing: border-box; }
.snail-memory-page header, .snail-memory-stats, .snail-memory-tabs, .snail-memory-actions { min-width: 0; }
.snail-memory-stats { display: flex; flex-wrap: wrap; gap: 8px 20px; margin: 16px 0; }
.snail-memory-tabs { display: flex; flex-wrap: wrap; gap: 6px; border-bottom: 1px solid var(--dsh-border, #d8dce2); }
.snail-memory-tabs [role='tab'][aria-selected='true'] { font-weight: 650; border-bottom: 2px solid currentColor; }
.snail-memory-list { display: grid; gap: 10px; padding: 0; list-style: none; }
.snail-memory-entry { min-width: 0; padding: 14px; border: 1px solid var(--dsh-border, #d8dce2); border-radius: 8px; }
.snail-memory-entry p, .snail-memory-entry small, .snail-memory-detail { overflow-wrap: anywhere; word-break: break-word; }
.snail-memory-detail { max-width: 680px; padding: 18px; }
.snail-memory-detail pre { max-width: 100%; white-space: pre-wrap; overflow-wrap: anywhere; }
.snail-memory-actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 14px; }
.snail-memory-error { color: var(--dsh-danger, #b42318); }
.snail-memory-page h1, .snail-memory-page h2, .snail-memory-page h3 { overflow-wrap: anywhere; }
@media (max-width: 480px) {
  .snail-memory-page { padding: 14px 12px; }
  .snail-memory-tabs { display: grid; grid-template-columns: minmax(0, 1fr); }
  .snail-memory-tabs [role='tab'] { width: 100%; white-space: normal; text-align: left; }
  .snail-memory-stats { display: grid; grid-template-columns: minmax(0, 1fr); }
  .snail-memory-controls { flex-wrap: wrap; }
  .snail-memory-feedback { max-width: 100%; }
}
`

export function installMemoryStyles(target: Document): () => void {
  const existing = target.head.querySelector<HTMLStyleElement>('style[data-snail-memory-styles]')
  if (existing !== null) return () => {}
  const style = target.createElement('style')
  style.dataset.snailMemoryStyles = ''
  style.textContent = MEMORY_STYLES
  target.head.append(style)
  return () => { style.remove() }
}
