import { parseColor, safeSerialize, serializeNode } from './serialization'

type JsonSchema = {
  type: 'object'
  properties: Record<string, unknown>
  required?: string[]
}

// Each tool schema constrains its handler input; `any` keeps the registry type simple.
type ToolHandler = (input: any) => unknown | Promise<unknown>

interface ToolDefinition {
  name: string
  description: string
  input_schema: JsonSchema
  handler: ToolHandler
}

const MAX_CODE_LENGTH = 10_000
const CODE_TIMEOUT_MS = 15_000

const TOOLS: ToolDefinition[] = [
  // ---- Read ----
  {
    name: 'get_current_page_selection',
    description: 'Returns the nodes currently selected on the active Figma page.',
    input_schema: { type: 'object', properties: {}, required: [] },
    handler: async () => ({
      nodes: figma.currentPage.selection.map(serializeNode),
    }),
  },
  {
    name: 'get_current_page_children',
    description: 'Returns the top-level child nodes of the active Figma page.',
    input_schema: { type: 'object', properties: {}, required: [] },
    handler: async () => ({
      nodes: figma.currentPage.children.map(serializeNode),
    }),
  },
  {
    name: 'show_notification',
    description: 'Shows a toast notification in the Figma UI.',
    input_schema: {
      type: 'object',
      properties: {
        message: { type: 'string', description: 'Text to display' },
      },
      required: ['message'],
    },
    handler: async (input: { message: string }) => {
      figma.notify(input.message)
      return { notified: true }
    },
  },

  // ---- Restricted writes ----
  {
    name: 'create_rectangle',
    description: 'Creates a rectangle on the current page.',
    input_schema: {
      type: 'object',
      properties: {
        x: { type: 'number', description: 'X position (default 0)' },
        y: { type: 'number', description: 'Y position (default 0)' },
        width: { type: 'number', description: 'Default 100' },
        height: { type: 'number', description: 'Default 100' },
        name: { type: 'string' },
        color: { type: 'string', description: 'Fill color as #RRGGBB' },
      },
      required: [],
    },
    handler: async (input: {
      x?: number
      y?: number
      width?: number
      height?: number
      name?: string
      color?: string
    }) => {
      const rectangle = figma.createRectangle()
      rectangle.x = input.x ?? 0
      rectangle.y = input.y ?? 0
      rectangle.resize(input.width ?? 100, input.height ?? 100)
      if (input.name) rectangle.name = input.name
      if (input.color) rectangle.fills = [{ type: 'SOLID', color: parseColor(input.color) }]
      return serializeNode(rectangle)
    },
  },
  {
    name: 'create_text',
    description: 'Creates a text node with font Inter Regular.',
    input_schema: {
      type: 'object',
      properties: {
        text: { type: 'string' },
        x: { type: 'number', description: 'X position (default 0)' },
        y: { type: 'number', description: 'Y position (default 0)' },
        size: { type: 'number', description: 'Font size (default 14)' },
        name: { type: 'string' },
        color: { type: 'string', description: 'Text color as #RRGGBB' },
      },
      required: ['text'],
    },
    handler: async (input: {
      text: string
      x?: number
      y?: number
      size?: number
      name?: string
      color?: string
    }) => {
      await figma.loadFontAsync({ family: 'Inter', style: 'Regular' })
      const node = figma.createText()
      node.fontName = { family: 'Inter', style: 'Regular' }
      node.characters = input.text
      node.x = input.x ?? 0
      node.y = input.y ?? 0
      node.fontSize = input.size ?? 14
      if (input.name) node.name = input.name
      if (input.color) node.fills = [{ type: 'SOLID', color: parseColor(input.color) }]
      return serializeNode(node)
    },
  },
  {
    name: 'set_fill',
    description: 'Sets a solid fill color on a node.',
    input_schema: {
      type: 'object',
      properties: {
        nodeId: { type: 'string' },
        color: { type: 'string', description: 'Color as #RRGGBB' },
      },
      required: ['nodeId', 'color'],
    },
    handler: async (input: { nodeId: string; color: string }) => {
      const node = figma.getNodeById(input.nodeId)
      if (!node) throw new Error(`Node not found: ${input.nodeId}`)
      if (!('fills' in node)) throw new Error(`Node type ${node.type} does not support fills`)
      ;(node as GeometryMixin).fills = [{ type: 'SOLID', color: parseColor(input.color) }]
      return serializeNode(node as SceneNode)
    },
  },
  {
    name: 'rename_node',
    description: 'Renames a node.',
    input_schema: {
      type: 'object',
      properties: {
        nodeId: { type: 'string' },
        name: { type: 'string' },
      },
      required: ['nodeId', 'name'],
    },
    handler: async (input: { nodeId: string; name: string }) => {
      const node = figma.getNodeById(input.nodeId)
      if (!node) throw new Error(`Node not found: ${input.nodeId}`)
      node.name = input.name
      return serializeNode(node as SceneNode)
    },
  },

  // ---- General code execution (the UI requests user approval first) ----
  {
    name: 'execute_plugin_code',
    description:
      'Executes JavaScript in the Figma plugin sandbox with the `figma` API. ' +
      'Use for composed operations (e.g. Auto Layout). Code must be self-contained; ' +
      'explicitly return a value to see it (returned nodes are serialized to {id, name, type}).',
    input_schema: {
      type: 'object',
      properties: {
        code: { type: 'string', description: `JavaScript source, max ${MAX_CODE_LENGTH} chars` },
      },
      required: ['code'],
    },
    handler: async (input: { code: string }) => {
      const code = input?.code
      if (typeof code !== 'string' || code.length === 0) throw new Error('code is required')
      if (code.length > MAX_CODE_LENGTH) {
        throw new Error(`Code too long: ${code.length} chars (max ${MAX_CODE_LENGTH})`)
      }

      const wrapped = `
        return (async () => {
          ${code}
        })()
      `
      const run = new Function('figma', wrapped)

      // A timeout stops waiting, but cannot terminate synchronous code in an infinite loop.
      const timeout = new Promise<never>((_, reject) => {
        setTimeout(
          () => reject(new Error(`Code execution timed out after ${CODE_TIMEOUT_MS}ms`)),
          CODE_TIMEOUT_MS
        )
      })

      const result = await Promise.race([run(figma), timeout])
      return safeSerialize(result) ?? { ok: true }
    },
  },
]

export const toolDefinitions = () =>
  TOOLS.map(({ name, description, input_schema }) => ({ name, description, input_schema }))

export async function executeTool(name: string, input: Record<string, unknown>) {
  // Built-in meta-tool: the UI gets definitions from the sandbox as the single source of truth.
  if (name === 'list_tools') return { tools: toolDefinitions() }

  const tool = TOOLS.find((candidate) => candidate.name === name)
  if (!tool) throw new Error(`Unknown tool: ${name}`)
  return tool.handler(input)
}
