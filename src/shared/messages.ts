export interface SerializedNode {
  id: string
  name: string
  type: string
}

export type UIToPluginMessage =
  | {
      type: 'execute-tool'
      requestId: string
      toolName: string
      toolInput: Record<string, unknown>
    }
  // Values are strings: store small settings directly and full state as JSON.
  | { type: 'storage-get'; requestId: string; key: string }
  | { type: 'storage-set'; requestId: string; key: string; value: string }
  | { type: 'storage-delete'; requestId: string; key: string }

export type PluginToUIMessage = {
  type: 'tool-result'
  requestId: string
  result?: unknown
  error?: string
}
