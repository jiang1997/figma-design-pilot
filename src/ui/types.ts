import type { ModelMessage } from 'ai'

export interface DisplayMessage {
  role: 'user' | 'assistant'
  text: string
  isError?: boolean
  isToolActivity?: boolean
}

export interface ToolDef {
  name: string
  description: string
  input_schema: Record<string, unknown>
}

export interface Skill {
  id: string
  name: string
  prompt: string
}

export interface SavedChat {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  messages: ModelMessage[]
}

export type ProviderType = 'anthropic' | 'openai-compatible'

export interface StorageStateV2 {
  version: 2
  settings: {
    provider: ProviderType
    model: string
    baseUrl: string
  }
  skills: Skill[]
  chats: SavedChat[]
  currentChatId: string | null
}

export interface ApiConfig {
  id: string
  name: string
  provider: ProviderType
  model: string
  baseUrl: string
}

export interface StorageStateV3 {
  version: 3
  configs: ApiConfig[]
  activeConfigId: string | null
  skills: Skill[]
  chats: SavedChat[]
  currentChatId: string | null
}
