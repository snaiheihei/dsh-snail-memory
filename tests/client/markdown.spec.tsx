// @vitest-environment jsdom
import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { renderMarkdown } from '../../client/src/markdown.js'

describe('memory body markdown', () => {
  it('renders headings, lists, code and inline emphasis', () => {
    const view = render(<div>{renderMarkdown('# Title\n\nIntro **bold** and `code`.\n\n- one\n- two\n\n```\nconst x = 1\n```')}</div>)
    expect(view.container.querySelector('h3')?.textContent).toBe('Title')
    expect(view.container.querySelector('strong')?.textContent).toBe('bold')
    expect(view.container.querySelector('code')?.textContent).toBe('code')
    expect(view.container.querySelectorAll('li')).toHaveLength(2)
    expect(view.container.querySelector('pre')?.textContent).toBe('const x = 1')
  })

  it('keeps a plain body in one paragraph', () => {
    const view = render(<div>{renderMarkdown('All packages use the workspace protocol.')}</div>)
    expect(view.container.querySelectorAll('p')).toHaveLength(1)
    expect(view.container.querySelector('p')?.textContent).toBe('All packages use the workspace protocol.')
  })

  it('renders markup as text instead of injecting it', () => {
    const view = render(<div>{renderMarkdown('<img src=x onerror="alert(1)"> outside')}</div>)
    expect(view.container.querySelector('img')).toBeNull()
    expect(view.container.textContent).toContain('<img src=x')
  })

  it('links only http and mailto targets', () => {
    const view = render(<div>{renderMarkdown('[docs](https://example.com/a) [bad](javascript:alert(1))')}</div>)
    expect(view.container.querySelector('a')?.getAttribute('href')).toBe('https://example.com/a')
    expect(view.container.textContent).toContain('[bad](javascript:alert(1))')
  })
})
