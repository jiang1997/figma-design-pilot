import type { AssistantContent, ModelMessage, ToolResultPart } from 'ai'
import { randomId, storageDelete, storageGet, storageSet } from './plugin-client'
import type { SavedChat, StorageStateV2 } from './types'

const API_KEY_STORAGE_KEY = 'ai-api-key'
const STATE_STORAGE_KEY = 'chat-state-v2'
const LEGACY_API_KEY_STORAGE_KEY = 'anthropic-api-key'
const LEGACY_STATE_STORAGE_KEY = 'chat-state-v1'
const LEGACY_STORAGE_KEYS = {
  baseUrl: 'anthropic-api-url',
  model: 'anthropic-model',
}

type LegacyBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | {
      type: 'tool_result'
      tool_use_id: string
      content: string
      is_error?: boolean
    }

interface LegacyMessage {
  role: 'user' | 'assistant'
  content: string | LegacyBlock[]
}

interface LegacyStateV1 {
  version: 1
  settings: { model: string; baseUrl: string }
  skills: StorageStateV2['skills']
  chats: Array<{
    id: string
    title: string
    createdAt: number
    updatedAt: number
    apiHistory: LegacyMessage[]
  }>
  currentChatId: string | null
}

function defaultState(): StorageStateV2 {
  return {
    version: 2,
    settings: { provider: 'anthropic', model: '', baseUrl: '' },
    skills: [],
    chats: [],
    currentChatId: null,
  }
}

function cloneMessages(messages: ModelMessage[]): ModelMessage[] {
  return JSON.parse(JSON.stringify(messages)) as ModelMessage[]
}

function chatTitle(messages: ModelMessage[]): string {
  const first = messages.find(
    (message) => message.role === 'user' && typeof message.content === 'string'
  )
  const text = first && typeof first.content === 'string' ? first.content : 'New chat'
  return text.length > 24 ? `${text.slice(0, 24)}…` : text
}

function migrateMessages(history: LegacyMessage[]): ModelMessage[] {
  const messages: ModelMessage[] = []
  const toolNames = new Map<string, string>()

  for (const message of history) {
    if (typeof message.content === 'string') {
      messages.push({ role: message.role, content: message.content })
      continue
    }

    if (message.role === 'assistant') {
      const content: Exclude<AssistantContent, string> = []
      for (const block of message.content) {
        if (block.type === 'text') {
          content.push({ type: 'text', text: block.text })
          continue
        }
        if (block.type === 'tool_use') {
          toolNames.set(block.id, block.name)
          content.push({
            type: 'tool-call',
            toolCallId: block.id,
            toolName: block.name,
            input: block.input,
          })
        }
      }
      if (content.length > 0) messages.push({ role: 'assistant', content })
      continue
    }

    const toolResults: ToolResultPart[] = message.content.flatMap((block) => {
      if (block.type !== 'tool_result') return []
      return [
        {
          type: 'tool-result' as const,
          toolCallId: block.tool_use_id,
          toolName: toolNames.get(block.tool_use_id) ?? 'legacy-tool',
          output: {
            type: block.is_error ? ('error-text' as const) : ('text' as const),
            value: block.content,
          },
        },
      ]
    })
    if (toolResults.length > 0) messages.push({ role: 'tool', content: toolResults })

    const text = message.content
      .filter((block): block is Extract<LegacyBlock, { type: 'text' }> => block.type === 'text')
      .map((block) => block.text)
      .join('\n')
    if (text) messages.push({ role: 'user', content: text })
  }

  return messages
}

function migrateState(state: LegacyStateV1): StorageStateV2 {
  return {
    version: 2,
    settings: {
      provider: 'anthropic',
      model: state.settings.model,
      baseUrl: state.settings.baseUrl.replace(/\/+$/, '').replace(/\/messages$/, ''),
    },
    skills: state.skills ?? [],
    chats: state.chats.map((chat) => ({
      id: chat.id,
      title: chat.title,
      createdAt: chat.createdAt,
      updatedAt: chat.updatedAt,
      messages: migrateMessages(chat.apiHistory),
    })),
    currentChatId: state.currentChatId,
  }
}

export class ChatStore {
  private state: StorageStateV2 = defaultState()
  private messageHistory: ModelMessage[] = []
  private activeChatId: string | null = null
  private chatCreatedAt = 0
  private loaded = false
  private persistChain: Promise<void> = Promise.resolve()
  private changeListener: (() => void) | null = null

  get history(): ModelMessage[] {
    return this.messageHistory
  }

  get chats(): SavedChat[] {
    return this.state.chats
  }

  get currentChatId(): string | null {
    return this.activeChatId
  }

  get settings(): StorageStateV2['settings'] {
    return this.state.settings
  }

  setChangeListener(listener: () => void): void {
    this.changeListener = listener
  }

  async load(): Promise<string> {
    try {
      this.state = await this.loadState()
      const current = this.state.chats.find((chat) => chat.id === this.state.currentChatId)
      if (current) {
        this.activeChatId = current.id
        this.chatCreatedAt = current.createdAt
        this.messageHistory = cloneMessages(current.messages)
      }

      const apiKey = await storageGet(API_KEY_STORAGE_KEY)
      if (apiKey) return apiKey
      const legacyApiKey = await storageGet(LEGACY_API_KEY_STORAGE_KEY)
      if (legacyApiKey) {
        await storageSet(API_KEY_STORAGE_KEY, legacyApiKey)
        await storageDelete(LEGACY_API_KEY_STORAGE_KEY)
      }
      return legacyApiKey
    } catch (error) {
      console.warn('[storage] load failed:', error)
      this.state = defaultState()
      return ''
    } finally {
      this.loaded = true
    }
  }

  append(message: ModelMessage): void {
    this.messageHistory.push(message)
    this.checkpoint()
  }

  loadChat(id: string): boolean {
    const chat = this.state.chats.find((candidate) => candidate.id === id)
    if (!chat) return false

    this.activeChatId = chat.id
    this.chatCreatedAt = chat.createdAt
    this.messageHistory = cloneMessages(chat.messages)
    this.checkpoint()
    return true
  }

  deleteChat(id: string): boolean {
    this.state.chats = this.state.chats.filter((chat) => chat.id !== id)
    const deletedCurrent = this.activeChatId === id
    if (deletedCurrent) this.resetCurrentChat()
    this.checkpoint()
    return deletedCurrent
  }

  startNewChat(): void {
    this.resetCurrentChat()
    this.checkpoint()
  }

  updateSettings(settings: Partial<StorageStateV2['settings']>): void {
    this.state.settings = { ...this.state.settings, ...settings }
    this.checkpoint()
  }

  saveApiKey(apiKey: string): void {
    void storageSet(API_KEY_STORAGE_KEY, apiKey)
  }

  private resetCurrentChat(): void {
    this.activeChatId = null
    this.chatCreatedAt = 0
    this.messageHistory = []
  }

  private syncCurrentChat(): void {
    this.state.chats = this.state.chats.filter((chat) => chat.messages.length > 0)

    if (this.messageHistory.length === 0) {
      this.state.currentChatId = null
      return
    }

    if (!this.activeChatId) {
      this.activeChatId = randomId()
      this.chatCreatedAt = Date.now()
    }

    this.state.chats = this.state.chats.filter((chat) => chat.id !== this.activeChatId)
    this.state.chats.push({
      id: this.activeChatId,
      title: chatTitle(this.messageHistory),
      createdAt: this.chatCreatedAt,
      updatedAt: Date.now(),
      messages: this.messageHistory,
    })
    this.state.currentChatId = this.activeChatId
  }

  private checkpoint(): void {
    if (!this.loaded) return
    this.syncCurrentChat()
    const snapshot = JSON.stringify(this.state)
    this.persistChain = this.persistChain
      .then(() => storageSet(STATE_STORAGE_KEY, snapshot))
      .catch((error) => console.warn('[storage] persist failed:', error))
    this.changeListener?.()
  }

  private async loadState(): Promise<StorageStateV2> {
    const raw = await storageGet(STATE_STORAGE_KEY)
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as StorageStateV2
        if (parsed.version === 2) return parsed
      } catch {
        // If the current state is corrupt, continue by trying to migrate the legacy state.
      }
      console.warn('[storage] unrecognized v2 state, trying legacy state')
    }

    const legacyRaw = await storageGet(LEGACY_STATE_STORAGE_KEY)
    if (legacyRaw) {
      try {
        const legacy = JSON.parse(legacyRaw) as LegacyStateV1
        if (legacy.version === 1) {
          const migrated = migrateState(legacy)
          await storageSet(STATE_STORAGE_KEY, JSON.stringify(migrated))
          await storageDelete(LEGACY_STATE_STORAGE_KEY)
          return migrated
        }
      } catch {
        console.warn('[storage] legacy state is corrupt, starting fresh')
      }
    }

    const [baseUrl, model] = await Promise.all([
      storageGet(LEGACY_STORAGE_KEYS.baseUrl),
      storageGet(LEGACY_STORAGE_KEYS.model),
    ])
    const migrated = defaultState()
    if (baseUrl) migrated.settings.baseUrl = baseUrl.replace(/\/+$/, '').replace(/\/messages$/, '')
    if (model) migrated.settings.model = model
    await storageSet(STATE_STORAGE_KEY, JSON.stringify(migrated))
    await storageDelete(LEGACY_STORAGE_KEYS.baseUrl)
    await storageDelete(LEGACY_STORAGE_KEYS.model)
    return migrated
  }
}
