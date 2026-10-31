/**
 * Snail Memory surfaces: the main memory panel and the composer control next to
 * the prompt input.
 *
 * Colour comes from the Host design system (`--dsw-*` on `body`) so the UI
 * follows the app's light and dark theme and its brand; every value keeps a
 * neutral literal fallback so the surfaces still render outside the Host.
 * Geometry is the app-screen pair: 8px panels, 6px controls.
 */
export const MEMORY_STYLES = `
.snail-memory-page, .snail-memory-controls {
  --sm-ink: var(--dsw-alias-label-primary, #0f1115);
  --sm-muted: var(--dsw-alias-label-secondary, #565b63);
  --sm-faint: var(--dsw-alias-label-tertiary, #6f747c);
  --sm-surface: var(--dsw-alias-bg-layer-1, #fff);
  --sm-input: var(--dsw-specific-input-major, #fff);
  --sm-raised: var(--dsw-alias-bg-multi-select, #f4f5f7);
  --sm-border: var(--dsw-alias-border-l2, rgba(0, 0, 0, .1));
  --sm-rule: rgba(0, 0, 0, .06);
  --sm-rule: color-mix(in srgb, var(--sm-ink) 4%, transparent);
  --sm-control: var(--dsw-alias-border-l3, rgba(0, 0, 0, .16));
  --sm-hover: var(--dsw-alias-interactive-bg-hover, rgba(38, 49, 72, .06));
  --sm-active: var(--dsw-alias-interactive-bg-active, rgba(38, 49, 72, .1));
  --sm-hover-danger: var(--dsw-alias-interactive-bg-hover-danger, rgba(236, 19, 19, .06));
  --sm-primary: var(--dsw-alias-button-primary-fill, #1d1f20);
  --sm-primary-hover: var(--dsw-alias-button-primary-hover, #2b2d31);
  --sm-primary-ink: var(--dsw-alias-label-primary-foreground, #fff);
  --sm-danger: var(--dsw-alias-state-error-primary, #c4242a);
  --sm-focus: var(--dsw-alias-state-business-primary, #365f9d);
  --sm-panel-radius: 8px;
  --sm-control-radius: 6px;
  --sm-line: 1px solid var(--sm-rule);
}
.snail-memory-page, .snail-memory-page *, .snail-memory-page *::before, .snail-memory-page *::after,
.snail-memory-controls, .snail-memory-controls *, .snail-memory-controls *::before, .snail-memory-controls *::after { box-sizing: border-box; }

/* ---------- the panel ---------- */
.snail-memory-page {
  width: 100%;
  max-width: 1060px;
  min-width: 0;
  margin: 0 auto;
  padding: 30px 24px 48px;
  color: var(--sm-ink);
  font: inherit;
  overflow-x: hidden;
}
.snail-memory-page h1 {
  margin: 0;
  font-size: 24px;
  line-height: 1.25;
  font-weight: 600;
  letter-spacing: -0.01em;
  color: var(--sm-ink);
}
.snail-memory-head { display: grid; gap: 0; min-width: 0; }
.snail-memory-figures {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  margin: 22px 0 0;
  padding: 0;
  border-top: var(--sm-line);
  border-bottom: var(--sm-line);
}
.snail-memory-figure { display: grid; gap: 3px; min-width: 0; padding: 14px 20px; border-inline-start: var(--sm-line); }
.snail-memory-figure:first-child { padding-inline-start: 0; border-inline-start: 0; }
.snail-memory-figure dt { font-size: 12px; line-height: 1.4; color: var(--sm-muted); }
.snail-memory-figure dd {
  margin: 0;
  font-size: 22px;
  line-height: 1.15;
  font-weight: 500;
  letter-spacing: -0.01em;
  font-variant-numeric: tabular-nums;
}
.snail-memory-hint { margin: 12px 0 0; font-size: 12px; line-height: 1.5; color: var(--sm-muted); }

/* ---------- tabs ---------- */
.snail-memory-tabs { display: flex; gap: 24px; min-width: 0; margin-top: 24px; border-bottom: var(--sm-line); }
.snail-memory-tabs [role='tab'] {
  margin: 0 0 -1px;
  padding: 8px 0 10px;
  border: 0;
  border-bottom: 2px solid transparent;
  background: none;
  color: var(--sm-muted);
  font: inherit;
  font-size: 13px;
  line-height: 1.4;
  white-space: nowrap;
  cursor: pointer;
}
.snail-memory-tabs [role='tab']:hover { color: var(--sm-ink); }
.snail-memory-tabs [role='tab'][aria-selected='true'] { border-bottom-color: var(--sm-ink); color: var(--sm-ink); font-weight: 600; }
.snail-memory-page [role='tabpanel'] { padding-top: 22px; }

/* ---------- notice, toolbar, list ---------- */
.snail-memory-notice { display: flex; gap: 8px; margin: 16px 0 0; font-size: 12px; line-height: 1.5; color: var(--sm-ink); }
.snail-memory-notice::before { content: ''; flex: none; width: 5px; height: 5px; margin-top: 6px; border-radius: 50%; background: currentColor; }
.snail-memory-notice[role='alert'] { color: var(--sm-danger); }
.snail-memory-toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: 10px 16px; min-width: 0; margin-bottom: 6px; }
.snail-memory-scope { display: flex; align-items: center; gap: 10px; min-width: 0; }
.snail-memory-scope label { flex: none; font-size: 12px; color: var(--sm-muted); }
.snail-memory-toolbar-end { display: flex; align-items: center; gap: 14px; margin-inline-start: auto; }
.snail-memory-count { font-size: 12px; line-height: 1.4; color: var(--sm-muted); font-variant-numeric: tabular-nums; }
.snail-memory-controls select,
.snail-memory-scope select {
  min-width: 0;
  max-width: 100%;
  min-height: 32px;
  padding: 4px 8px;
  font: inherit;
  font-size: 13px;
  color: var(--sm-ink);
  border: 1px solid var(--sm-control);
  border-radius: var(--sm-control-radius);
  background: var(--sm-input);
}
.snail-memory-scope select { width: 240px; }
.snail-memory-confirm {
  display: grid;
  gap: 12px;
  justify-items: start;
  margin: 0 0 18px;
  padding: 15px 16px;
  border-radius: var(--sm-panel-radius);
  background: var(--sm-raised);
}
.snail-memory-confirm p { max-width: 66ch; margin: 0; font-size: 13px; line-height: 1.55; color: var(--sm-ink); }
.snail-memory-confirm-actions { display: flex; flex-wrap: wrap; gap: 8px; }
.snail-memory-feedback-line { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; margin: 0 0 16px; font-size: 12px; line-height: 1.5; color: var(--sm-muted); }
.snail-memory-feedback-line[role='alert'] { color: var(--sm-danger); }
.snail-memory-filters { display: flex; flex-wrap: wrap; gap: 6px; min-width: 0; margin: 0 0 14px; }
.snail-memory-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-height: 28px;
  padding: 0 10px;
  border: 1px solid transparent;
  border-radius: var(--sm-control-radius);
  background: none;
  color: var(--sm-muted);
  font-size: 12px;
  line-height: 1;
  white-space: nowrap;
}
.snail-memory-chip:hover { background: var(--sm-hover); color: var(--sm-ink); }
.snail-memory-chip[aria-pressed='true'] { background: var(--sm-active); color: var(--sm-ink); font-weight: 500; }
.snail-memory-chip-count { color: var(--sm-faint); font-variant-numeric: tabular-nums; }
.snail-memory-chip[aria-pressed='true'] .snail-memory-chip-count { color: var(--sm-muted); }

.snail-memory-list { display: grid; margin: 0; padding: 0; list-style: none; border-top: var(--sm-line); }
.snail-memory-entry {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: start;
  gap: 16px;
  min-width: 0;
  padding: 15px 0 14px;
  border-bottom: var(--sm-line);
}
.snail-memory-entry h2 {
  display: -webkit-box;
  overflow: hidden;
  margin: 0;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  font-size: 14px;
  line-height: 1.45;
  font-weight: 500;
  color: var(--sm-ink);
  overflow-wrap: anywhere;
}
.snail-memory-entry-meta { display: flex; flex-wrap: wrap; align-items: baseline; gap: 2px 10px; margin: 6px 0 0; font-size: 12px; line-height: 1.45; color: var(--sm-muted); }
.snail-memory-tag { font-weight: 500; color: var(--sm-ink); }
.snail-memory-tag::after { content: '·'; margin-inline-start: 10px; color: var(--sm-faint); font-weight: 400; }
.snail-memory-meta { font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
.snail-memory-skeleton { display: grid; gap: 9px; align-content: start; padding: 3px 0; }
.snail-memory-bar { display: block; width: 64%; height: 11px; border-radius: 3px; background: var(--sm-active); }
.snail-memory-bar--short { width: 36%; height: 8px; }

/* ---------- the empty scope ---------- */
.snail-memory-empty {
  display: grid;
  grid-template-columns: minmax(0, 340px) minmax(0, 1fr);
  gap: 32px;
  padding: 22px 24px;
  border: 1px solid var(--sm-border);
  border-radius: var(--sm-panel-radius);
}
.snail-memory-empty--plain { grid-template-columns: minmax(0, 1fr); }
.snail-memory-empty-main { display: grid; gap: 10px; align-content: start; justify-items: start; min-width: 0; }
.snail-memory-empty-title { margin: 0; font-size: 14px; line-height: 1.45; font-weight: 500; color: var(--sm-ink); }
.snail-memory-empty p + p { max-width: 46ch; margin: 0; font-size: 13px; line-height: 1.55; color: var(--sm-muted); }
.snail-memory-kinds { display: grid; margin: 0; padding: 0; border-top: var(--sm-line); }
.snail-memory-kind { display: grid; grid-template-columns: minmax(0, 92px) minmax(0, 1fr); gap: 12px; padding: 9px 0; border-bottom: var(--sm-line); }
.snail-memory-kind dt { font-size: 13px; line-height: 1.5; font-weight: 500; color: var(--sm-ink); }
.snail-memory-kind dd { margin: 0; font-size: 13px; line-height: 1.5; color: var(--sm-muted); }

/* ---------- controls ---------- */
.snail-memory-page button, .snail-memory-controls button { font: inherit; cursor: pointer; }
.snail-memory-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  min-height: 32px;
  padding: 0 12px;
  border: 1px solid var(--sm-control);
  border-radius: var(--sm-control-radius);
  background: transparent;
  color: var(--sm-ink);
  font-size: 13px;
  font-weight: 500;
  line-height: 1;
  white-space: nowrap;
}
.snail-memory-button:hover { background: var(--sm-hover); }
.snail-memory-button:disabled { border-color: var(--sm-rule); color: var(--sm-faint); background: transparent; cursor: not-allowed; }
.snail-memory-button[data-variant='primary'] { border-color: var(--sm-primary); background: var(--sm-primary); color: var(--sm-primary-ink); }
.snail-memory-button[data-variant='primary']:hover { background: var(--sm-primary-hover); }
.snail-memory-button[data-variant='danger'] { border-color: transparent; color: var(--sm-danger); }
.snail-memory-button[data-variant='danger']:hover { background: var(--sm-hover-danger); }
.snail-memory-button[data-variant='danger-fill'] { border-color: var(--sm-danger); background: var(--sm-danger); color: #fff; }
.snail-memory-page button:focus-visible, .snail-memory-controls button:focus-visible,
.snail-memory-page input:focus-visible, .snail-memory-page select:focus-visible, .snail-memory-controls select:focus-visible {
  outline: 2px solid var(--sm-focus);
  outline-offset: 2px;
}
.snail-memory-entry-action {
  align-self: start;
  min-height: 26px;
  padding: 0 8px;
  border: 1px solid transparent;
  border-radius: var(--sm-control-radius);
  background: none;
  color: var(--sm-ink);
  font-size: 12px;
  line-height: 1;
}
.snail-memory-entry-action:hover { border-color: var(--sm-control); }

/* ---------- settings ---------- */
.snail-memory-settings { display: grid; margin: 0; }
.snail-memory-section {
  display: grid;
  grid-template-columns: minmax(0, 260px) minmax(0, 1fr);
  gap: 32px;
  min-width: 0;
  padding: 28px 0;
}
.snail-memory-section:first-of-type { padding-top: 4px; }
.snail-memory-section-head { display: grid; gap: 6px; align-content: start; min-width: 0; }
.snail-memory-section-head h2 { margin: 0; font-size: 14px; line-height: 1.4; font-weight: 600; color: var(--sm-ink); }
.snail-memory-section-head p { margin: 0; font-size: 13px; line-height: 1.55; color: var(--sm-muted); }
.snail-memory-fields { display: grid; align-content: start; min-width: 0; padding: 6px 16px; border-radius: var(--sm-panel-radius); background: var(--sm-raised); }
.snail-memory-field { display: grid; grid-template-columns: minmax(0, 1fr) 120px; align-items: start; gap: 3px 20px; min-width: 0; padding: 14px 0; }
.snail-memory-field label { grid-area: 1 / 1; font-size: 13px; line-height: 1.4; font-weight: 500; color: var(--sm-ink); }
.snail-memory-field p { grid-area: 2 / 1; margin: 0; font-size: 13px; line-height: 1.5; color: var(--sm-muted); }
.snail-memory-field input {
  grid-area: 1 / 2;
  justify-self: end;
  width: 120px;
  min-height: 32px;
  padding: 4px 10px;
  font: inherit;
  font-size: 13px;
  font-variant-numeric: tabular-nums;
  text-align: right;
  color: var(--sm-ink);
  border: 1px solid var(--sm-control);
  border-radius: var(--sm-control-radius);
  background: var(--sm-input);
  appearance: textfield;
}
.snail-memory-field input::-webkit-outer-spin-button,
.snail-memory-field input::-webkit-inner-spin-button { margin: 0; appearance: none; }
.snail-memory-field input:disabled { color: var(--sm-faint); background: var(--sm-raised); }
.snail-memory-lines { display: grid; min-width: 0; border-radius: var(--sm-panel-radius); background: var(--sm-raised); }
.snail-memory-line { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: 14px; min-height: 44px; padding: 0 16px; }
.snail-memory-line:last-child { border-bottom: 0; }
.snail-memory-line label { font-size: 13px; line-height: 1.4; color: var(--sm-ink); }
.snail-memory-line input {
  width: 120px;
  min-height: 32px;
  padding: 4px 10px;
  font: inherit;
  font-size: 13px;
  font-variant-numeric: tabular-nums;
  text-align: right;
  color: var(--sm-ink);
  border: 1px solid var(--sm-control);
  border-radius: var(--sm-control-radius);
  background: var(--sm-input);
  appearance: textfield;
}
.snail-memory-line input::-webkit-outer-spin-button,
.snail-memory-line input::-webkit-inner-spin-button { margin: 0; appearance: none; }
.snail-memory-line input:disabled { color: var(--sm-faint); background: var(--sm-raised); }
.snail-memory-settings-foot { display: flex; flex-wrap: wrap; align-items: center; justify-content: flex-end; gap: 12px 16px; padding-top: 20px; border-top: var(--sm-line); }
.snail-memory-settings-foot p { margin: 0 auto 0 0; font-size: 13px; line-height: 1.5; color: var(--sm-muted); }
.snail-memory-settings-foot p[role='alert'] { color: var(--sm-danger); }

/* ---------- detail dialog ---------- */
.snail-memory-detail-backdrop { position: fixed; z-index: 1000; inset: 0; display: grid; place-items: center; padding: 24px; background: rgba(10, 12, 16, .34); }
.snail-memory-detail {
  display: flex;
  flex-direction: column;
  width: min(680px, 100%);
  max-height: calc(100vh - 48px);
  overflow: hidden;
  border-radius: 12px;
  background: var(--sm-surface);
  box-shadow: 0 6px 20px rgba(10, 12, 16, .1); /* taste-skill-ignore: the dialog floats above the page */
}
.snail-memory-detail-head { display: grid; gap: 14px; padding: 22px 24px 0; }
.snail-memory-detail h2 { margin: 0; font-size: 17px; line-height: 1.4; font-weight: 600; color: var(--sm-ink); overflow-wrap: anywhere; }
.snail-memory-detail-facts { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; margin: 0; padding: 13px 0; border-top: var(--sm-line); border-bottom: var(--sm-line); }
.snail-memory-detail-facts div { display: grid; gap: 2px; min-width: 0; }
.snail-memory-detail-facts dt { font-size: 12px; line-height: 1.4; color: var(--sm-muted); }
.snail-memory-detail-facts dd { margin: 0; font-size: 13px; line-height: 1.45; font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
.snail-memory-detail-body {
  flex: 1 1 auto;
  min-height: 0;
  margin: 0;
  padding: 18px 24px 22px;
  overflow-y: auto;
  word-break: break-word;
  overflow-wrap: anywhere;
  font: inherit;
  font-size: 14px;
  line-height: 1.7;
  color: var(--sm-ink);
}
.snail-memory-detail-body > * { margin: 0; }
.snail-memory-detail-body > * + * { margin-top: 12px; }
.snail-memory-detail-body h3 { font-size: 14px; line-height: 1.45; font-weight: 600; }
.snail-memory-detail-body ul, .snail-memory-detail-body ol { padding-inline-start: 20px; }
.snail-memory-detail-body li + li { margin-top: 4px; }
.snail-memory-detail-body blockquote { padding-inline-start: 12px; border-inline-start: 2px solid var(--sm-control); color: var(--sm-muted); }
.snail-memory-detail-body a { color: var(--sm-ink); text-decoration: underline; text-decoration-color: var(--sm-faint); text-underline-offset: 2px; }
.snail-memory-detail-body a:hover { text-decoration-color: var(--sm-ink); }
.snail-memory-detail-body code { font-family: var(--ds-font-family-code, ui-monospace, monospace); font-size: 12.5px; }
.snail-memory-detail-body pre { padding: 10px 12px; overflow-x: auto; border-radius: 6px; background: var(--sm-raised); }
.snail-memory-detail-body pre code { font-size: 12.5px; line-height: 1.55; }
.snail-memory-detail-note { margin: 0; padding: 0 24px 16px; font-size: 13px; line-height: 1.55; color: var(--sm-danger); }
.snail-memory-detail-note--status { color: var(--sm-muted); }
.snail-memory-detail-foot { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding: 15px 24px; border-top: var(--sm-line); }
.snail-memory-detail-foot .snail-memory-spacer { flex: 1 1 auto; }

/* ---------- editing a memory ---------- */
.snail-memory-edit { display: flex; flex: 1 1 auto; flex-direction: column; min-height: 0; }
.snail-memory-edit-fields { display: grid; gap: 14px; padding: 18px 24px; overflow-y: auto; min-height: 0; }
.snail-memory-edit-field { display: grid; gap: 6px; min-width: 0; }
.snail-memory-edit-field label { font-size: 13px; line-height: 1.4; font-weight: 500; color: var(--sm-ink); }
.snail-memory-edit-field p { margin: 0; font-size: 12px; line-height: 1.4; color: var(--sm-muted); font-variant-numeric: tabular-nums; }
.snail-memory-edit-field input,
.snail-memory-edit-field select,
.snail-memory-edit-field textarea {
  width: 100%;
  padding: 7px 10px;
  font: inherit;
  font-size: 13px;
  line-height: 1.5;
  color: var(--sm-ink);
  border: 1px solid var(--sm-control);
  border-radius: var(--sm-control-radius);
  background: var(--sm-input);
}
.snail-memory-edit-field select { max-width: 220px; }
.snail-memory-edit-field textarea { min-height: 150px; resize: vertical; }
.snail-memory-edit-field input:disabled,
.snail-memory-edit-field select:disabled,
.snail-memory-edit-field textarea:disabled { color: var(--sm-faint); background: var(--sm-raised); }

/* ---------- composer control ---------- */
.snail-memory-controls { position: relative; display: flex; align-items: center; min-width: 0; }
.snail-memory-trigger {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  min-height: 30px;
  padding: 0 8px;
  border: 1px solid transparent;
  border-radius: var(--sm-control-radius);
  background: none;
  color: var(--sm-muted);
  font-size: 13px;
  line-height: 1;
  white-space: nowrap;
}
.snail-memory-trigger:hover { background: var(--sm-hover); color: var(--sm-ink); }
.snail-memory-trigger[aria-expanded='true'] { background: var(--sm-active); color: var(--sm-ink); }
.snail-memory-popover {
  position: absolute;
  z-index: 20;
  bottom: calc(100% + 8px);
  inset-inline-start: 0;
  display: grid;
  width: min(340px, calc(100vw - 24px));
  padding: 8px;
  color: var(--sm-ink);
  border: 1px solid var(--sm-border);
  border-radius: 10px;
  background: var(--sm-surface);
  box-shadow: 0 6px 16px rgba(10, 12, 16, .1), 0 1px 2px rgba(10, 12, 16, .06); /* taste-skill-ignore: the popover floats above the prompt input */
}
.snail-memory-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: 4px 10px; min-width: 0; min-height: 44px; padding: 8px; font-size: 13px; }
.snail-memory-row + .snail-memory-row { border-top: var(--sm-line); }
.snail-memory-row-label { display: grid; gap: 2px; min-width: 0; font-weight: 500; }
.snail-memory-row-state { font-size: 12px; font-weight: 400; line-height: 1.4; color: var(--sm-muted); font-variant-numeric: tabular-nums; }
.snail-memory-row > .snail-memory-row-state--line { grid-column: 1 / -1; }
.snail-memory-row select { width: 100%; }
.snail-memory-enable {
  flex: none;
  min-width: 64px;
  min-height: 28px;
  padding: 0 12px;
  border: 1px solid var(--sm-control);
  border-radius: var(--sm-control-radius);
  background: transparent;
  color: var(--sm-ink);
  font-size: 12px;
  font-weight: 500;
  line-height: 1;
  white-space: nowrap;
}
.snail-memory-enable:hover { background: var(--sm-hover); }
.snail-memory-enable[aria-pressed='true'] { border-color: var(--sm-primary); background: var(--sm-primary); color: var(--sm-primary-ink); }
.snail-memory-enable[aria-pressed='true']:hover { background: var(--sm-primary-hover); }
.snail-memory-enable:disabled { border-color: var(--sm-rule); background: transparent; color: var(--sm-faint); cursor: not-allowed; }
.snail-memory-refresh { display: inline-flex; align-items: center; gap: 6px; min-height: 28px; padding: 0 10px; border: 1px solid transparent; border-radius: var(--sm-control-radius); background: none; color: var(--sm-ink); font-size: 12px; line-height: 1; }
.snail-memory-refresh:hover { background: var(--sm-hover); }
.snail-memory-refresh:disabled { color: var(--sm-faint); background: none; cursor: not-allowed; }
.snail-memory-refresh-row { grid-template-columns: auto minmax(0, 1fr); }
.snail-memory-feedback { grid-column: 1 / -1; max-width: 100%; font-size: 12px; line-height: 1.45; color: var(--sm-muted); overflow-wrap: anywhere; }
.snail-memory-row > .snail-memory-feedback { grid-column: 1 / -1; }
.snail-memory-error { color: var(--sm-danger); }

/* ---------- phone ---------- */
@media (max-width: 720px) {
  .snail-memory-page { padding: 24px 20px 40px; }
  .snail-memory-figures { grid-template-columns: minmax(0, 1fr); margin-top: 18px; }
  .snail-memory-figure { grid-template-columns: minmax(0, 1fr) auto; align-items: baseline; gap: 12px; padding: 10px 0; border-inline-start: 0; border-top: var(--sm-line); }
  .snail-memory-figure:first-child { border-top: 0; padding-top: 0; }
  .snail-memory-figure dd { font-size: 17px; }
  .snail-memory-section { grid-template-columns: minmax(0, 1fr); gap: 12px; padding: 20px 0; }
  .snail-memory-empty { grid-template-columns: minmax(0, 1fr); gap: 20px; padding: 18px 16px; }
  .snail-memory-scope { width: 100%; }
  .snail-memory-scope select { flex: 1 1 auto; width: auto; }
  .snail-memory-toolbar-end { width: 100%; justify-content: space-between; margin-inline-start: 0; }
  .snail-memory-detail-facts { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); }
}
@media (max-width: 480px) {
  .snail-memory-page { padding: 20px 16px 36px; }
  .snail-memory-page h1 { font-size: 21px; }
  .snail-memory-tabs { gap: 18px; overflow-x: auto; }
  .snail-memory-filters { flex-wrap: nowrap; overflow-x: auto; padding-bottom: 2px; }
  .snail-memory-edit-fields { padding: 14px 16px; }
  .snail-memory-edit-field select { max-width: 100%; }
  .snail-memory-tabs [role='tab'] { padding: 11px 0 12px; }
  .snail-memory-entry { grid-template-columns: minmax(0, 1fr) auto; gap: 10px; padding: 14px 0; }
  .snail-memory-entry h2 { font-size: 13.5px; }
  .snail-memory-entry-action { min-height: 36px; padding: 0 10px; border-color: var(--sm-control); }
  .snail-memory-button { min-height: 38px; }
  .snail-memory-enable { min-height: 32px; }
  .snail-memory-refresh { min-height: 32px; }
  .snail-memory-tag::after { content: none; }
  .snail-memory-entry-meta { gap: 1px 8px; }
  .snail-memory-detail-backdrop { padding: 12px; }
  .snail-memory-detail-head { padding: 18px 16px 0; }
  .snail-memory-detail-body { padding: 14px 16px 18px; }
  .snail-memory-detail-foot { padding: 13px 16px; }
  .snail-memory-detail-facts { grid-template-columns: minmax(0, 1fr); gap: 8px; }
  .snail-memory-controls { flex-wrap: wrap; }
  .snail-memory-popover { width: min(320px, calc(100vw - 24px)); }
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
