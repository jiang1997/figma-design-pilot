import type { SerializedNode } from '../shared/messages'

export const serializeNode = (node: SceneNode): SerializedNode => ({
  id: node.id,
  name: node.name,
  type: node.type,
})

export function serializeError(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`
  if (typeof error === 'string') return error
  try {
    return JSON.stringify(error)
  } catch {
    return String(error)
  }
}

// '#RRGGBB' -> Figma RGB(0-1)
export function parseColor(hex: string): RGB {
  const match = /^#?([0-9a-f]{6})$/i.exec(hex.trim())
  if (!match) throw new Error(`Invalid color '${hex}', expected #RRGGBB`)
  const value = parseInt(match[1], 16)
  return {
    r: ((value >> 16) & 255) / 255,
    g: ((value >> 8) & 255) / 255,
    b: (value & 255) / 255,
  }
}

// Convert arbitrary values to plain data, serialize Figma nodes, avoid cycles, and limit depth.
export function safeSerialize(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value
  }
  if (typeof value === 'function') return `[function ${value.name || 'anonymous'}]`
  if (depth > 6) return '[max depth reached]'
  if (Array.isArray(value)) return value.map((item) => safeSerialize(item, depth + 1))

  if (typeof value === 'object') {
    // Detect Figma nodes by the id, type, and remove members on their class instances.
    const maybeNode = value as { id?: unknown; type?: unknown; remove?: unknown }
    if (
      typeof maybeNode.id === 'string' &&
      typeof maybeNode.type === 'string' &&
      typeof maybeNode.remove === 'function'
    ) {
      return serializeNode(value as SceneNode)
    }

    const output: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      output[key] = safeSerialize(item, depth + 1)
    }
    return output
  }

  return String(value)
}
