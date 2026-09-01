import type { AssistantContent, ModelMessage, ToolResultPart } from 'ai'
import { randomId, storageDelete, storageGet, storageSet } from './plugin-client'
import { DEFAULT_PROVIDER } from './config'
import type { ApiConfig, SavedChat, StorageStateV2, StorageStateV3 } from './types'

const STATE_STORAGE_KEY = 'chat-state-v3'
const API_KEY_PREFIX = 'api-key:'
const LEGACY_SINGLE_API_KEY_STORAGE_KEY = 'ai-api-key'
const LEGACY_API_KEY_STORAGE_KEY = 'anthropic-api-key'
const LEGACY_STATE_V2_STORAGE_KEY = 'chat-state-v2'
const LEGACY_STATE_V1_STORAGE_KEY = 'chat-state-v1'
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

function apiKeyStorageKey(configId: string): string {
  return API_KEY_PREFIX + configId
}

function defaultState(): StorageStateV3 {
  return {
    version: 3,
    configs: [],
    activeConfigId: null,
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

async function buildSeedConfig(settings: StorageStateV2['settings']): Promise<ApiConfig | null> {
  const hasSettings = Boolean(
    settings.model.trim() || settings.baseUrl.trim() || settings.provider !== DEFAULT_PROVIDER
  )
  if (!hasSettings) {
    const [singleKey, legacyKey] = await Promise.all([
      storageGet(LEGACY_SINGLE_API_KEY_STORAGE_KEY),
      storageGet(LEGACY_API_KEY_STORAGE_KEY),
    ])
    if (!singleKey && !legacyKey) return null
  }
  return {
    id: randomId(),
    name: '',
    provider: settings.provider,
    model: settings.model,
    baseUrl: settings.baseUrl,
  }
}

function migrateV2ToV3(state: StorageStateV2, seedConfig: ApiConfig | null): StorageStateV3 {
  return {
    version: 3,
    configs: seedConfig ? [seedConfig] : [],
    activeConfigId: seedConfig ? seedConfig.id : null,
    skills: state.skills ?? [],
    chats: state.chats,
    currentChatId: state.currentChatId,
  }
}

export class ChatStore {
  private state: StorageStateV3 = defaultState()
  private apiKeys = new Map<string, string>()
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

  get configs(): ApiConfig[] {
    return this.state.configs
  }

  get activeConfigId(): string | null {
    return this.state.activeConfigId
  }

  get activeConfig(): ApiConfig | null {
    return this.state.configs.find((config) => config.id === this.state.activeConfigId) ?? null
  }

  setChangeListener(listener: () => void): void {
    this.changeListener = listener
  }

  getApiKey(configId: string): string {
    return this.apiKeys.get(configId) ?? ''
  }

  async load(): Promise<void> {
    try {
      this.state = await this.loadState()
      this.sanitizeState()
      const current = this.state.chats.find((chat) => chat.id === this.state.currentChatId)
      if (current) {
        this.activeChatId = current.id
        this.chatCreatedAt = current.createdAt
        this.messageHistory = cloneMessages(current.messages)
      }

      const entries = await Promise.all(
        this.state.configs.map(async (config) => {
          const key = await storageGet(apiKeyStorageKey(config.id))
          return [config.id, key] as const
        })
      )
      this.apiKeys = new Map(entries.filter(([, key]) => key !== ''))

      await this.migrateLegacyApiKey()
    } catch (error) {
      console.warn('[storage] load failed:', error)
      this.state = defaultState()
      this.apiKeys = new Map()
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

  upsertConfig(config: ApiConfig, apiKey: string): void {
    const index = this.state.configs.findIndex((candidate) => candidate.id === config.id)
    if (index === -1) {
      this.state.configs.push(config)
      this.state.activeConfigId = config.id
    } else {
      this.state.configs[index] = config
    }

    const trimmedKey = apiKey.trim()
    if (trimmedKey) this.apiKeys.set(config.id, trimmedKey)
    else this.apiKeys.delete(config.id)

    this.checkpoint()
    this.queueStorageWrite(() =>
      trimmedKey
        ? storageSet(apiKeyStorageKey(config.id), trimmedKey)
        : storageDelete(apiKeyStorageKey(config.id))
    )
  }

  deleteConfig(configId: string): void {
    this.state.configs = this.state.configs.filter((config) => config.id !== configId)
    if (this.state.activeConfigId === configId) {
      this.state.activeConfigId = this.state.configs[0]?.id ?? null
    }
    this.apiKeys.delete(configId)

    this.queueStorageWrite(() => storageDelete(apiKeyStorageKey(configId)))
    this.checkpoint()
  }

  setActiveConfig(configId: string): void {
    if (configId === this.state.activeConfigId) return
    if (!this.state.configs.some((config) => config.id === configId)) return
    this.state.activeConfigId = configId
    this.checkpoint()
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

  private queueStorageWrite(operation: () => Promise<void>): void {
    this.persistChain = this.persistChain
      .then(operation)
      .catch((error) => console.warn('[storage] persist failed:', error))
  }

  private checkpoint(): void {
    if (!this.loaded) return
    this.syncCurrentChat()
    const snapshot = JSON.stringify(this.state)
    this.queueStorageWrite(() => storageSet(STATE_STORAGE_KEY, snapshot))
    this.changeListener?.()
  }

  // A v2→v3 migration persists the new state before the api key is forwarded,
  // so every load falls back to the legacy key slots until that completes.
  private async migrateLegacyApiKey(): Promise<void> {
    const activeId = this.state.activeConfigId
    if (!activeId || this.apiKeys.get(activeId)) return

    const singleKey = await storageGet(LEGACY_SINGLE_API_KEY_STORAGE_KEY)
    const legacyKey = singleKey || await storageGet(LEGACY_API_KEY_STORAGE_KEY)
    if (!legacyKey) return

    this.apiKeys.set(activeId, legacyKey)
    await storageSet(apiKeyStorageKey(activeId), legacyKey)
    await storageDelete(LEGACY_SINGLE_API_KEY_STORAGE_KEY)
    await storageDelete(LEGACY_API_KEY_STORAGE_KEY)
  }

  private sanitizeState(): void {
    const ids = new Set(this.state.configs.map((config) => config.id))
    if (this.state.activeConfigId && !ids.has(this.state.activeConfigId)) {
      this.state.activeConfigId = this.state.configs[0]?.id ?? null
    }
  }

  private async loadState(): Promise<StorageStateV3> {
    const raw = await storageGet(STATE_STORAGE_KEY)
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as StorageStateV3
        if (parsed.version === 3 && Array.isArray(parsed.configs)) return parsed
      } catch {
        // If the current state is corrupt, continue by trying legacy states.
      }
      console.warn('[storage] unrecognized v3 state, trying legacy state')
    }

    const v2Raw = await storageGet(LEGACY_STATE_V2_STORAGE_KEY)
    if (v2Raw) {
      try {
        const v2 = JSON.parse(v2Raw) as StorageStateV2
        if (v2.version === 2) {
          const seedConfig = await buildSeedConfig(v2.settings)
          const migrated = migrateV2ToV3(v2, seedConfig)
          await storageSet(STATE_STORAGE_KEY, JSON.stringify(migrated))
          await storageDelete(LEGACY_STATE_V2_STORAGE_KEY)
          return migrated
        }
      } catch {
        console.warn('[storage] v2 state is corrupt, trying older state')
      }
    }

    const v1Raw = await storageGet(LEGACY_STATE_V1_STORAGE_KEY)
    if (v1Raw) {
      try {
        const legacy = JSON.parse(v1Raw) as LegacyStateV1
        if (legacy.version === 1) {
          const v2 = migrateState(legacy)
          const seedConfig = await buildSeedConfig(v2.settings)
          const migrated = migrateV2ToV3(v2, seedConfig)
          await storageSet(STATE_STORAGE_KEY, JSON.stringify(migrated))
          await storageDelete(LEGACY_STATE_V1_STORAGE_KEY)
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
    const v2: StorageStateV2 = {
      version: 2,
      settings: {
        provider: 'anthropic',
        model,
        baseUrl: baseUrl.replace(/\/+$/, '').replace(/\/messages$/, ''),
      },
      skills: [],
      chats: [],
      currentChatId: null,
    }
    const seedConfig = await buildSeedConfig(v2.settings)
    const migrated = migrateV2ToV3(v2, seedConfig)
    await storageSet(STATE_STORAGE_KEY, JSON.stringify(migrated))
    await storageDelete(LEGACY_STORAGE_KEYS.baseUrl)
    await storageDelete(LEGACY_STORAGE_KEYS.model)
    return migrated
  }
}
