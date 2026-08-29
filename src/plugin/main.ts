import type { PluginToUIMessage, UIToPluginMessage } from '../shared/messages'
import { safeSerialize, serializeError } from './serialization'
import { executeTool } from './tools'

figma.showUI(__html__, { width: 380, height: 560 })

function postResult(message: PluginToUIMessage): void {
  figma.ui.postMessage(message)
}

figma.ui.onmessage = async (rawMessage) => {
  const message = rawMessage as UIToPluginMessage

  // Storage uses clientStorage directly; it is neither a registered tool nor exposed to the LLM.
  if (message.type === 'storage-get') {
    const value = (await figma.clientStorage.getAsync(message.key)) ?? ''
    postResult({ type: 'tool-result', requestId: message.requestId, result: value })
    return
  }
  if (message.type === 'storage-set') {
    await figma.clientStorage.setAsync(message.key, message.value)
    postResult({ type: 'tool-result', requestId: message.requestId, result: true })
    return
  }
  if (message.type === 'storage-delete') {
    await figma.clientStorage.deleteAsync(message.key)
    postResult({ type: 'tool-result', requestId: message.requestId, result: true })
    return
  }

  if (message.type !== 'execute-tool') return

  const { requestId, toolName, toolInput } = message
  console.log('[tool]', toolName, JSON.stringify(toolInput ?? {}))
  try {
    const result = await executeTool(toolName, toolInput ?? {})
    postResult({ type: 'tool-result', requestId, result: safeSerialize(result) })
  } catch (error) {
    postResult({ type: 'tool-result', requestId, error: serializeError(error) })
  }
}
