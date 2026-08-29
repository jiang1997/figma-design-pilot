import type { PluginToUIMessage, UIToPluginMessage } from '../shared/messages'
import type { ToolDef } from './types'

const REQUEST_TIMEOUT_MS = 30_000

interface PendingRequest {
  resolve: (result: unknown) => void
  reject: (error: Error) => void
}

const pendingRequests = new Map<string, PendingRequest>()

function randomId(): string {
  if (window.crypto && crypto.randomUUID) return crypto.randomUUID()
  return 'req-' + Math.random().toString(36).slice(2, 10)
}

type WithoutRequestId<T> = T extends unknown ? Omit<T, 'requestId'> : never
type UIRequest = WithoutRequestId<UIToPluginMessage>

function sendPluginMessage(message: UIRequest): Promise<unknown> {
  const requestId = randomId()

  return new Promise((resolve, reject) => {
    pendingRequests.set(requestId, { resolve, reject })
    parent.postMessage({ pluginMessage: { ...message, requestId } }, '*')

    setTimeout(() => {
      const pending = pendingRequests.get(requestId)
      if (!pending) return
      pending.reject(new Error('Plugin request timed out'))
      pendingRequests.delete(requestId)
    }, REQUEST_TIMEOUT_MS)
  })
}

window.addEventListener('message', (event: MessageEvent) => {
  const message = event.data?.pluginMessage as PluginToUIMessage | undefined
  if (!message || message.type !== 'tool-result') return

  const pending = pendingRequests.get(message.requestId)
  if (!pending) return
  pendingRequests.delete(message.requestId)

  if (message.error !== undefined) pending.reject(new Error(message.error))
  else pending.resolve(message.result)
})

export function executeInPlugin(
  toolName: string,
  toolInput: Record<string, unknown> = {}
): Promise<unknown> {
  return sendPluginMessage({ type: 'execute-tool', toolName, toolInput })
}

export async function storageGet(key: string): Promise<string> {
  return ((await sendPluginMessage({ type: 'storage-get', key })) ?? '') as string
}

export async function storageSet(key: string, value: string): Promise<void> {
  await sendPluginMessage({ type: 'storage-set', key, value })
}

export async function storageDelete(key: string): Promise<void> {
  await sendPluginMessage({ type: 'storage-delete', key })
}

let toolDefsCache: ToolDef[] | null = null

export async function getToolDefs(): Promise<ToolDef[]> {
  if (toolDefsCache) return toolDefsCache
  const result = (await executeInPlugin('list_tools', {})) as { tools: ToolDef[] }
  toolDefsCache = result.tools
  return toolDefsCache
}

export { randomId }
