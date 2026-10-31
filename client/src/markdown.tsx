import type { ReactNode } from 'react'

/**
 * A small Markdown subset for stored memory bodies: headings, bullet and numbered
 * lists, quotes, fenced code, paragraphs, and inline bold / code / links. It never
 * injects HTML, so a memory that contains markup is rendered as text.
 */
const INLINE = /(\*\*[^*\n]+\*\*|`[^`\n]+`|\[[^\]\n]+\]\((?:https?:|mailto:)[^)\s]+\))/g
const FENCE = /^```[A-Za-z0-9_+#.-]*\s*$/
const HEADING = /^(#{1,6})\s+(.+)$/
const QUOTE = /^>\s?/
const BULLET = /^[-*+]\s+/
const NUMBERED = /^\d+[.)]\s+/

function inline(text: string): ReactNode[] {
  const nodes: ReactNode[] = []
  let cursor = 0
  let key = 0
  for (const match of text.matchAll(INLINE)) {
    const at = match.index ?? 0
    if (at > cursor) nodes.push(text.slice(cursor, at))
    const token = match[0]
    const tokenKey = `i${key++}`
    if (token.startsWith('**')) nodes.push(<strong key={tokenKey}>{token.slice(2, -2)}</strong>)
    else if (token.startsWith('`')) nodes.push(<code key={tokenKey}>{token.slice(1, -1)}</code>)
    else {
      const link = /^\[([^\]]+)\]\((.+)\)$/.exec(token)
      nodes.push(link === null || link[2] === undefined
        ? token
        : <a key={tokenKey} href={link[2]} target="_blank" rel="noreferrer noopener">{link[1]}</a>)
    }
    cursor = at + token.length
  }
  if (cursor < text.length) nodes.push(text.slice(cursor))
  return nodes
}

export function renderMarkdown(source: string): ReactNode[] {
  const lines = source.replace(/\r\n?/g, '\n').split('\n')
  const blocks: ReactNode[] = []
  let cursor = 0
  let key = 0
  const nextKey = (): string => `b${key++}`
  while (cursor < lines.length) {
    const line = lines[cursor] ?? ''
    const trimmed = line.trim()
    if (trimmed === '') { cursor += 1; continue }

    if (FENCE.test(trimmed)) {
      const code: string[] = []
      cursor += 1
      while (cursor < lines.length && !FENCE.test((lines[cursor] ?? '').trim())) { code.push(lines[cursor] ?? ''); cursor += 1 }
      cursor += 1
      blocks.push(<pre key={nextKey()} className="snail-memory-code"><code>{code.join('\n')}</code></pre>)
      continue
    }

    const heading = HEADING.exec(trimmed)
    if (heading !== null) {
      blocks.push(<h3 key={nextKey()} className="snail-memory-md-head">{inline(heading[2] ?? '')}</h3>)
      cursor += 1
      continue
    }

    if (QUOTE.test(trimmed)) {
      const quote: string[] = []
      while (cursor < lines.length && QUOTE.test((lines[cursor] ?? '').trim())) {
        quote.push((lines[cursor] ?? '').trim().replace(QUOTE, ''))
        cursor += 1
      }
      blocks.push(<blockquote key={nextKey()}>{inline(quote.join(' '))}</blockquote>)
      continue
    }

    if (BULLET.test(trimmed)) {
      const items: string[] = []
      while (cursor < lines.length && BULLET.test((lines[cursor] ?? '').trim())) {
        items.push((lines[cursor] ?? '').trim().replace(BULLET, ''))
        cursor += 1
      }
      blocks.push(<ul key={nextKey()}>{items.map((item, position) => <li key={position}>{inline(item)}</li>)}</ul>)
      continue
    }

    if (NUMBERED.test(trimmed)) {
      const items: string[] = []
      while (cursor < lines.length && NUMBERED.test((lines[cursor] ?? '').trim())) {
        items.push((lines[cursor] ?? '').trim().replace(NUMBERED, ''))
        cursor += 1
      }
      blocks.push(<ol key={nextKey()}>{items.map((item, position) => <li key={position}>{inline(item)}</li>)}</ol>)
      continue
    }

    const paragraph: string[] = []
    while (cursor < lines.length) {
      const current = (lines[cursor] ?? '').trim()
      if (current === '' || FENCE.test(current) || HEADING.test(current) || QUOTE.test(current)
        || BULLET.test(current) || NUMBERED.test(current)) break
      paragraph.push(current)
      cursor += 1
    }
    blocks.push(<p key={nextKey()}>{inline(paragraph.join(' '))}</p>)
  }
  return blocks
}
