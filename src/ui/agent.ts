import {
  ToolLoopAgent,
  dynamicTool,
  jsonSchema,
  stepCountIs,
  type ModelMessage,
  type ToolSet,
} from 'ai'
import { MAX_AGENT_STEPS, MAX_OUTPUT_TOKENS, SYSTEM_PROMPT } from './config'
import { createModel } from './provider'
import { formatToolInput } from './protocol'
import type { DisplayMessage, ProviderType, ToolDef } from './types'

interface AgentContext {
  provider: ProviderType
  baseUrl: string
  apiKey: string
  model: string
  tools: ToolDef[]
}

interface AgentDependencies {
  getHistory: () => ModelMessage[]
  appendHistory: (message: ModelMessage) => void
  executeTool: (name: string, input: Record<string, unknown>) => Promise<unknown>
  requestApproval: (code: string) => Promise<boolean>
  addDisplayMessage: (message: DisplayMessage) => void
}

function recordInput(input: unknown): Record<string, unknown> {
  return input !== null && typeof input === 'object' && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : {}
}

function serialized(value: unknown): string {
  try {
    return JSON.stringify(value) ?? 'null'
  } catch {
    return String(value)
  }
}

function buildTools(definitions: ToolDef[], dependencies: AgentDependencies): ToolSet {
  return Object.fromEntries(
    definitions.map((definition) => [
      definition.name,
      dynamicTool({
        description: definition.description,
        inputSchema: jsonSchema(definition.input_schema as Parameters<typeof jsonSchema>[0]),
        execute: async (rawInput) => {
          const input = recordInput(rawInput)
          dependencies.addDisplayMessage({
            role: 'assistant',
            isToolActivity: true,
            text: `🔧 ${formatToolInput(definition.name, input)}`,
          })

          if (definition.name === 'execute_plugin_code') {
            const approved = await dependencies.requestApproval(String(input.code ?? ''))
            if (!approved) {
              const declined = { declined: true, message: 'User declined code execution' }
              dependencies.addDisplayMessage({
                role: 'assistant',
                isToolActivity: true,
                text: '-> User declined execution',
              })
              return declined
            }
          }

          try {
            const result = await dependencies.executeTool(definition.name, input)
            const content = serialized(result)
            dependencies.addDisplayMessage({
              role: 'assistant',
              isToolActivity: true,
              text: `-> ${content.length > 200 ? `${content.slice(0, 200)}…` : content}`,
            })
            return result
          } catch (error) {
            const result = { error: error instanceof Error ? error.message : String(error) }
            dependencies.addDisplayMessage({
              role: 'assistant',
              isToolActivity: true,
              text: `-> ${serialized(result)}`,
              isError: true,
            })
            return result
          }
        },
      }),
    ])
  )
}

export class AgentRunner {
  private activeAbort: AbortController | null = null

  async run(
    userText: string,
    context: AgentContext,
    dependencies: AgentDependencies
  ): Promise<void> {
    const controller = new AbortController()
    this.activeAbort = controller
    dependencies.appendHistory({ role: 'user', content: userText })

    try {
      const agent = new ToolLoopAgent({
        model: createModel(context.provider, context.apiKey, context.baseUrl, context.model),
        instructions: SYSTEM_PROMPT,
        tools: buildTools(context.tools, dependencies),
        maxOutputTokens: MAX_OUTPUT_TOKENS,
        stopWhen: stepCountIs(MAX_AGENT_STEPS),
        onStepEnd: ({ text }) => {
          if (text) dependencies.addDisplayMessage({ role: 'assistant', text })
        },
      })

      const result = await agent.generate({
        messages: dependencies.getHistory(),
        abortSignal: controller.signal,
      })
      result.responseMessages.forEach(dependencies.appendHistory)

      if (result.steps.length >= MAX_AGENT_STEPS && result.finishReason === 'tool-calls') {
        dependencies.addDisplayMessage({
          role: 'assistant',
          text: `(Stopped after reaching the ${MAX_AGENT_STEPS}-step limit)`,
          isError: true,
        })
      }
    } finally {
      this.activeAbort = null
    }
  }

  abort(): void {
    this.activeAbort?.abort()
  }
}
