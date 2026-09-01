import type { SerializedNode } from '../shared/messages'

const MAX_TEXT_LENGTH = 80

// Figma RGB(0-1) -> '#RRGGBB'
export function rgbToHex(color: RGB): string {
  const channel = (value: number) =>
    Math.round(Math.min(1, Math.max(0, value)) * 255)
      .toString(16)
      .padStart(2, '0')
  return `#${channel(color.r)}${channel(color.g)}${channel(color.b)}`
}

// First visible SOLID paint as hex; gradients/images/mixed paints are omitted.
function solidFillHex(node: SceneNode): string | undefined {
  if (!('fills' in node)) return undefined
  const fills = node.fills
  if (!Array.isArray(fills)) return undefined // figma.mixed
  const solid = fills.find(
    (paint) => paint.type === 'SOLID' && paint.visible !== false
  )
  return solid && solid.type === 'SOLID' ? rgbToHex(solid.color) : undefined
}

export const serializeNode = (node: SceneNode): SerializedNode => {
  const serialized: SerializedNode = {
    id: node.id,
    name: node.name,
    type: node.type,
    x: node.x,
    y: node.y,
  }

  if ('width' in node && 'height' in node) {
    serialized.width = node.width
    serialized.height = node.height
  }

  const fill = solidFillHex(node)
  if (fill) serialized.fill = fill

  if (node.type === 'TEXT') {
    const textNode = node as TextNode
    serialized.text =
      textNode.characters.length > MAX_TEXT_LENGTH
        ? `${textNode.characters.slice(0, MAX_TEXT_LENGTH)}…`
        : textNode.characters
    if (textNode.fontSize !== figma.mixed) serialized.fontSize = textNode.fontSize
  }

  if ('children' in node) serialized.childrenCount = node.children.length

  return serialized
}

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
