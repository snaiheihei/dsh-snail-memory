export const MEMORY_CHUNK_THRESHOLD = 8_000
export const MEMORY_CHUNK_SIZE = 4_000

const MIN_SEMANTIC_BOUNDARY = MEMORY_CHUNK_SIZE / 2

export interface MemoryDetailChunk {
  readonly id: string
  readonly index: number
  readonly text: string
}

function preferredBoundary(window: string): number {
  const paragraph = window.lastIndexOf('\n\n')
  if (paragraph >= MIN_SEMANTIC_BOUNDARY) return paragraph + 2
  const newline = window.lastIndexOf('\n')
  if (newline >= MIN_SEMANTIC_BOUNDARY) return newline + 1
  const whitespace = Math.max(window.lastIndexOf(' '), window.lastIndexOf('\t'))
  if (whitespace >= MIN_SEMANTIC_BOUNDARY) return whitespace + 1
  return window.length
}

export function chunkMemoryDetail(detail: string): MemoryDetailChunk[] {
  if (detail.length <= MEMORY_CHUNK_THRESHOLD) return []
  const chunks: MemoryDetailChunk[] = []
  let offset = 0
  while (offset < detail.length) {
    const remaining = detail.slice(offset)
    const size = remaining.length <= MEMORY_CHUNK_SIZE
      ? remaining.length
      : preferredBoundary(remaining.slice(0, MEMORY_CHUNK_SIZE))
    const index = chunks.length + 1
    chunks.push({
      id: `part-${String(index).padStart(3, '0')}`,
      index,
      text: remaining.slice(0, size),
    })
    offset += size
  }
  return chunks
}
