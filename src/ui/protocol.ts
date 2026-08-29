import type { ModelMessage, ToolResultPart } from 'ai'
import type { DisplayMessage } from './types'

export function formatToolInput(name: string, input: Record<string, unknown>): string {
  if (typeof input.code === 'string') return `${name}(code: ${input.code.length} chars)`
  return `${name}(${JSON.stringify(input)})`
}

function toolOutputText(output: ToolResultPart['output']): string {
  if (output.type === 'execution-denied') return output.reason ?? 'User declined execution'
  if (output.type === 'content') return '[Multimodal tool result]'
  return typeof output.value === 'string' ? output.value : JSON.stringify(output.value)
}

function textParts(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter(
      (part): part is { type: 'text'; text: string } =>
        part !== null &&
        typeof part === 'object' &&
        (part as { type?: unknown }).type === 'text' &&
        typeof (part as { text?: unknown }).text === 'string'
    )
    .map((part) => part.text)
    .join('\n')
}

export function rebuildDisplay(history: ModelMessage[]): DisplayMessage[] {
  const output: DisplayMessage[] = []

  for (const message of history) {
    if (message.role === 'user') {
      const text = textParts(message.content)
      if (text) output.push({ role: 'user', text })
      continue
    }

    if (message.role === 'assistant') {
      const text = textParts(message.content)
      if (text) output.push({ role: 'assistant', text })

      if (!Array.isArray(message.content)) continue
      for (const part of message.content) {
        if (part.type !== 'tool-call') continue
        output.push({
          role: 'assistant',
          isToolActivity: true,
          text: `🔧 ${formatToolInput(part.toolName, (part.input ?? {}) as Record<string, unknown>)}`,
        })
      }
      continue
    }

    if (message.role !== 'tool') continue
    for (const part of message.content) {
      if (part.type !== 'tool-result') continue
      const content = toolOutputText(part.output)
      output.push({
        role: 'assistant',
        isToolActivity: true,
        text: `-> ${content.length > 200 ? `${content.slice(0, 200)}…` : content}`,
        isError: part.output.type.startsWith('error-') || undefined,
      })
    }
  }

  return output
}
