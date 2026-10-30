export const MEMORY_STYLES = `
.snail-memory-controls { position: relative; display: flex; align-items: center; min-width: 0; }
.snail-memory-controls *, .snail-memory-controls *::before, .snail-memory-controls *::after { box-sizing: border-box; }
.snail-memory-controls button, .snail-memory-page button { min-height: 30px; font: inherit; }
.snail-memory-controls button { color: inherit; cursor: pointer; }
.snail-memory-trigger, .snail-memory-refresh { display: inline-flex; align-items: center; justify-content: center; gap: 5px; padding: 3px 8px; white-space: nowrap; border: 0; border-radius: 6px; background: transparent; }
.snail-memory-trigger:hover, .snail-memory-refresh:hover { background: var(--dsh-hover, #f2f4f7); }
.snail-memory-popover { position: absolute; z-index: 20; bottom: calc(100% + 8px); inset-inline-start: 0; display: grid; width: min(360px, calc(100vw - 24px)); padding: 6px; color: var(--dsh-text, #182230); border: 1px solid var(--dsh-border, #d8dce2); border-radius: 10px; background: var(--dsh-background, #fff); box-shadow: 0 8px 24px rgb(16 24 40 / 14%); }
.snail-memory-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: 5px 12px; min-width: 0; min-height: 44px; padding: 7px 8px; font-size: 12px; }
.snail-memory-row + .snail-memory-row { border-top: 1px solid var(--dsh-border, #e4e7ec); }
.snail-memory-row-label { font-weight: 500; }
.snail-memory-row select { width: 100%; min-width: 0; max-width: 100%; min-height: 30px; padding: 3px 26px 3px 8px; font: inherit; color: inherit; border: 1px solid var(--dsh-border, #d8dce2); border-radius: 6px; background: var(--dsh-background, transparent); }
.snail-memory-enable { min-width: 74px; min-height: 28px !important; padding: 3px 12px; border: 1px solid var(--dsh-border, #d8dce2); border-radius: 999px; background: var(--dsh-background, transparent); }
.snail-memory-enable:hover { background: var(--dsh-hover, #f2f4f7); }
.snail-memory-enable[aria-pressed='true'] { color: var(--dsh-primary-text, #fff); border-color: var(--dsh-primary, #365f9d); background: var(--dsh-primary, #365f9d); }
.snail-memory-controls button:focus-visible, .snail-memory-controls select:focus-visible { outline: 2px solid var(--dsh-focus, #365f9d); outline-offset: 2px; }
.snail-memory-controls button:disabled, .snail-memory-controls select:disabled { opacity: .5; cursor: not-allowed; }
.snail-memory-row > .snail-memory-feedback { grid-column: 1 / -1; }
.snail-memory-refresh { justify-self: start; }
.snail-memory-feedback { max-width: 100%; color: var(--dsh-text-secondary, #667085); font-size: 11px; line-height: 1.45; overflow-wrap: anywhere; }
.snail-memory-page { box-sizing: border-box; width: 100%; max-width: 1080px; min-width: 0; margin: 0 auto; padding: 24px; overflow-x: hidden; }
.snail-memory-page *, .snail-memory-page *::before, .snail-memory-page *::after { box-sizing: border-box; }
.snail-memory-page header, .snail-memory-stats, .snail-memory-tabs, .snail-memory-actions { min-width: 0; }
.snail-memory-stats { display: flex; flex-wrap: wrap; gap: 8px 20px; margin: 16px 0; }
.snail-memory-tabs { display: flex; flex-wrap: wrap; gap: 4px; padding-bottom: 8px; border-bottom: 1px solid var(--dsh-border, #d8dce2); }
.snail-memory-tabs [role='tab'] { padding: 6px 12px; border: 0; border-radius: 6px; color: var(--dsh-text-secondary, #667085); background: transparent; cursor: pointer; }
.snail-memory-tabs [role='tab']:hover { color: var(--dsh-text, #182230); background: var(--dsh-hover, #f2f4f7); }
.snail-memory-tabs [role='tab'][aria-selected='true'] { color: var(--dsh-text, #182230); font-weight: 600; background: var(--dsh-active, #eef1f5); }
.snail-memory-page [role='tabpanel'] { padding-top: 20px; }
.snail-memory-workspace-picker { display: flex; align-items: center; flex-wrap: wrap; gap: 10px; margin-bottom: 20px; }
.snail-memory-workspace-picker label, .snail-memory-setting label { font-weight: 600; }
.snail-memory-workspace-picker select { min-width: min(320px, 100%); max-width: 100%; min-height: 34px; padding: 5px 30px 5px 10px; font: inherit; color: inherit; border: 1px solid var(--dsh-border, #d8dce2); border-radius: 6px; background: var(--dsh-background, transparent); }
.snail-memory-settings { display: grid; gap: 22px; max-width: 560px; }
.snail-memory-retention { display: grid; gap: 16px; min-width: 0; margin: 0; padding: 16px; border: 1px solid var(--dsh-border, #d8dce2); border-radius: 8px; }
.snail-memory-retention legend { padding: 0 6px; font-weight: 600; }
.snail-memory-retention > p { margin: 0; color: var(--dsh-text-secondary, #667085); font-size: 13px; }
.snail-memory-setting { display: grid; gap: 8px; }
.snail-memory-setting input { width: min(240px, 100%); min-height: 36px; padding: 6px 10px; font: inherit; color: inherit; border: 1px solid var(--dsh-border, #d8dce2); border-radius: 6px; background: var(--dsh-background, transparent); }
.snail-memory-setting p { margin: 0; color: var(--dsh-text-secondary, #667085); font-size: 13px; }
.snail-memory-settings > button { justify-self: start; padding: 6px 14px; }
.snail-memory-list { display: grid; gap: 10px; padding: 0; list-style: none; }
.snail-memory-entry { min-width: 0; padding: 14px; border: 1px solid var(--dsh-border, #d8dce2); border-radius: 8px; }
.snail-memory-entry p, .snail-memory-entry small, .snail-memory-detail { overflow-wrap: anywhere; word-break: break-word; }
.snail-memory-entry-meta { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.snail-memory-entry-meta small { min-width: 0; }
.snail-memory-entry-meta button { flex: none; margin-inline-start: auto; }
.snail-memory-detail-backdrop { position: fixed; z-index: 1000; inset: 0; display: grid; place-items: center; padding: 24px; background: rgb(16 24 40 / 45%); }
.snail-memory-detail { width: min(680px, 100%); max-width: 680px; max-height: calc(100vh - 48px); padding: 20px; overflow-y: auto; border: 1px solid var(--dsh-border, #d8dce2); border-radius: 12px; background: var(--dsh-background, #fff); box-shadow: 0 20px 48px rgb(16 24 40 / 20%); }
.snail-memory-detail h2 { margin-top: 0; }
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
