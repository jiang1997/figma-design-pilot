import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { AgentRunner } from './agent'
import { ChatStore } from './chat-store'
import {
  DEFAULT_BASE_URLS,
  DEFAULT_MODELS,
  DEFAULT_PROVIDER,
  PROVIDER_LABELS,
  connectionLabel,
} from './config'
import { executeInPlugin, getToolDefs, randomId } from './plugin-client'
import { rebuildDisplay } from './protocol'
import type { ApiConfig, DisplayMessage, ProviderType, SavedChat, ToolDef } from './types'

const store = new ChatStore()
const agentRunner = new AgentRunner()

function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleString(undefined, {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function formatElapsed(totalSeconds: number): string {
  if (totalSeconds < 60) return `${totalSeconds}s`
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${minutes}:${String(seconds).padStart(2, '0')}`
}

interface SettingsProps {
  configs: ApiConfig[]
  activeConfigId: string | null
  getApiKey: (configId: string) => string
  onActivate: (configId: string) => void
  onDelete: (configId: string) => void
  onSave: (config: ApiConfig, apiKey: string) => void
}

interface ConnectionFormProps {
  config: ApiConfig | null
  initialApiKey: string
  onSave: (config: ApiConfig, apiKey: string) => void
  onCancel: () => void
}

type AppView = 'chat' | 'history' | 'settings'

function Icon({ children }: { children: ReactNode }) {
  return (
    <svg className="icon" viewBox="0 0 20 20" fill="none" aria-hidden="true">
      {children}
    </svg>
  )
}

function ConnectionForm({ config, initialApiKey, onSave, onCancel }: ConnectionFormProps) {
  const [name, setName] = useState(config?.name ?? '')
  const [provider, setProvider] = useState<ProviderType>(config?.provider ?? DEFAULT_PROVIDER)
  const [model, setModel] = useState(config?.model ?? '')
  const [baseUrl, setBaseUrl] = useState(config?.baseUrl ?? '')
  const [apiKey, setApiKey] = useState(initialApiKey)
  const [showApiKey, setShowApiKey] = useState(false)

  const save = () => {
    onSave(
      {
        id: config?.id ?? randomId(),
        name: name.trim(),
        provider,
        model: model.trim(),
        baseUrl: baseUrl.trim(),
      },
      apiKey.trim()
    )
  }

  return (
    <section className="settings-page">
      <div className="page-heading">
        <h1>{config ? 'Edit connection' : 'Add connection'}</h1>
        <p>Connect the model you want Design Pilot to use.</p>
      </div>

      <div className="settings-card">
        <div className="card-title">Model connection</div>

        <label className="field-label" htmlFor="connection-name">Name</label>
        <input
          id="connection-name"
          type="text"
          value={name}
          placeholder="Optional, e.g. Team Anthropic"
          onChange={(event) => setName(event.target.value)}
        />
        <p className="field-help">Shown in the chat header switcher. Leave empty to use "Provider · Model".</p>

        <label className="field-label" htmlFor="provider">Provider</label>
        <div className="select-wrap">
          <select
            id="provider"
            aria-label="Model provider"
            value={provider}
            onChange={(event) => setProvider(event.target.value as ProviderType)}
          >
            <option value="anthropic">Anthropic</option>
            <option value="openai-compatible">OpenAI Compatible</option>
          </select>
        </div>

        <label className="field-label" htmlFor="api-key">API key</label>
        <div className="secret-field">
          <input
            id="api-key"
            type={showApiKey ? 'text' : 'password'}
            value={apiKey}
            placeholder="Enter your API key"
            onChange={(event) => setApiKey(event.target.value)}
          />
          <button
            className="icon-button reveal-button"
            type="button"
            aria-label={showApiKey ? 'Hide API key' : 'Show API key'}
            onClick={() => setShowApiKey((visible) => !visible)}
          >
            {showApiKey ? 'Hide' : 'Show'}
          </button>
        </div>
        <p className="field-help">Stored only in this Figma plugin's local storage.</p>

        <label className="field-label" htmlFor="model">Model</label>
        <input
          id="model"
          type="text"
          value={model}
          placeholder={DEFAULT_MODELS[provider]}
          onChange={(event) => setModel(event.target.value)}
        />

        <label className="field-label" htmlFor="api-url">Base URL</label>
        <input
          id="api-url"
          type="text"
          value={baseUrl}
          placeholder={DEFAULT_BASE_URLS[provider]}
          onChange={(event) => setBaseUrl(event.target.value)}
        />
        <p className="field-help">Leave model and URL empty to use the defaults.</p>
      </div>

      <div className="settings-actions">
        <button className="secondary-button" onClick={onCancel}>Cancel</button>
        <button className="primary-button settings-save" onClick={save}>
          {config ? 'Save changes' : 'Add connection'}
        </button>
      </div>
    </section>
  )
}

function Settings({ configs, activeConfigId, getApiKey, onActivate, onDelete, onSave }: SettingsProps) {
  const [formTarget, setFormTarget] = useState<string | null>(null)
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null)

  const editingConfig =
    formTarget !== null && formTarget !== 'new'
      ? configs.find((config) => config.id === formTarget) ?? null
      : null

  if (formTarget !== null) {
    return (
      <ConnectionForm
        key={formTarget}
        config={editingConfig}
        initialApiKey={editingConfig ? getApiKey(editingConfig.id) : ''}
        onSave={(config, apiKey) => {
          onSave(config, apiKey)
          setFormTarget(null)
        }}
        onCancel={() => setFormTarget(null)}
      />
    )
  }

  return (
    <section className="settings-page">
      <div className="page-heading">
        <h1>API settings</h1>
        <p>Manage the connections Design Pilot can use to talk to models.</p>
      </div>

      <div className="settings-card">
        <div className="card-title">Connections</div>

        {configs.length === 0 ? (
          <div className="settings-empty">No connections yet. Add one to start chatting.</div>
        ) : (
          <div className="connection-list">
            {configs.map((config) => (
              <div
                className={`connection-row${config.id === activeConfigId ? ' active' : ''}`}
                key={config.id}
                role="button"
                tabIndex={0}
                onClick={() => onActivate(config.id)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') onActivate(config.id)
                }}
              >
                <div className="connection-info">
                  <div className="connection-name">{connectionLabel(config)}</div>
                  <div className="connection-meta">
                    {PROVIDER_LABELS[config.provider]} ·{' '}
                    {config.model.trim() || DEFAULT_MODELS[config.provider]}
                    {!getApiKey(config.id).trim() && (
                      <span className="connection-missing"> · No API key</span>
                    )}
                  </div>
                </div>
                {config.id === activeConfigId && <span className="active-badge">Active</span>}
                <div className="connection-actions">
                  <button
                    className="connection-edit"
                    title="Edit this connection"
                    onClick={(event) => {
                      event.stopPropagation()
                      setFormTarget(config.id)
                    }}
                  >
                    Edit
                  </button>
                  <button
                    className={`connection-delete${pendingDeleteId === config.id ? ' confirm' : ''}`}
                    title="Delete this connection"
                    onClick={(event) => {
                      event.stopPropagation()
                      if (pendingDeleteId === config.id) {
                        setPendingDeleteId(null)
                        onDelete(config.id)
                      } else {
                        setPendingDeleteId(config.id)
                      }
                    }}
                  >
                    {pendingDeleteId === config.id ? 'Confirm' : '×'}
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}

        <button className="secondary-button add-connection" onClick={() => setFormTarget('new')}>
          + Add connection
        </button>
      </div>
    </section>
  )
}

function Messages({ messages }: { messages: DisplayMessage[] }) {
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const container = containerRef.current
    if (container) container.scrollTop = container.scrollHeight
  }, [messages])

  return (
    <div id="messages" ref={containerRef}>
      {messages.length === 0 ? (
        <div className="empty-chat">
          <div className="empty-mark">✦</div>
          <h2>What would you like to design?</h2>
          <p>I can inspect your selection, create components, update styles, and help refine your Figma file.</p>
        </div>
      ) : (
        messages.map((message, index) => {
          const roleClass = message.isToolActivity ? 'tool' : message.role
          return (
            <div
              className={`msg ${roleClass}${message.isError ? ' error' : ''}`}
              key={`${index}-${message.text}`}
            >
              {message.text}
            </div>
          )
        })
      )}
    </div>
  )
}

interface HistoryProps {
  chats: SavedChat[]
  currentChatId: string | null
  onOpen: (id: string) => void
  onDelete: (id: string) => void
}

function History({ chats, currentChatId, onOpen, onDelete }: HistoryProps) {
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null)
  const orderedChats = [...chats].sort((a, b) => b.updatedAt - a.updatedAt)

  if (orderedChats.length === 0) {
    return (
      <div id="history">
        <div className="hint">No chat history yet.</div>
      </div>
    )
  }

  return (
    <div id="history">
      {orderedChats.map((chat) => (
        <div
          className={`chat-row${chat.id === currentChatId ? ' current' : ''}`}
          key={chat.id}
          role="button"
          tabIndex={0}
          onClick={() => onOpen(chat.id)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') onOpen(chat.id)
          }}
        >
          <div className="chat-info">
            <div className="chat-title">{chat.title}</div>
            <div className="chat-time">{formatTime(chat.updatedAt)}</div>
          </div>
          <button
            className={`chat-delete${pendingDeleteId === chat.id ? ' confirm' : ''}`}
            title="Delete this chat"
            onClick={(event) => {
              event.stopPropagation()
              if (pendingDeleteId === chat.id) {
                setPendingDeleteId(null)
                onDelete(chat.id)
              } else {
                setPendingDeleteId(chat.id)
              }
            }}
          >
            {pendingDeleteId === chat.id ? 'Confirm' : '×'}
          </button>
        </div>
      ))}
    </div>
  )
}

interface ApprovalProps {
  code: string
  onResolve: (approved: boolean) => void
}

function Approval({ code, onResolve }: ApprovalProps) {
  return (
    <div id="confirm">
      <div className="confirm-title">The agent wants to run code</div>
      <pre id="confirm-code">{code}</pre>
      <div className="confirm-actions">
        <button id="approve" onClick={() => onResolve(true)}>
          Run code
        </button>
        <button id="decline" onClick={() => onResolve(false)}>
          Decline
        </button>
      </div>
    </div>
  )
}

export function App() {
  const [input, setInput] = useState('')
  const [displayMessages, setDisplayMessages] = useState<DisplayMessage[]>([])
  const [activeView, setActiveView] = useState<AppView>('chat')
  const [isSending, setIsSending] = useState(false)
  const [stateLoaded, setStateLoaded] = useState(false)
  const [, setStoreRevision] = useState(0)
  const [approvalCode, setApprovalCode] = useState<string | null>(null)
  const approvalResolver = useRef<((approved: boolean) => void) | null>(null)
  const stopRequested = useRef(false)
  const [runStartedAt, setRunStartedAt] = useState<number | null>(null)
  const [elapsedSeconds, setElapsedSeconds] = useState(0)

  const addDisplayMessage = useCallback((message: DisplayMessage) => {
    setDisplayMessages((current) => [...current, message])
  }, [])

  const resolveApproval = useCallback((approved: boolean) => {
    approvalResolver.current?.(approved)
    approvalResolver.current = null
    setApprovalCode(null)
  }, [])

  const requestApproval = useCallback((code: string) => {
    return new Promise<boolean>((resolve) => {
      approvalResolver.current = resolve
      setApprovalCode(code)
    })
  }, [])

  useEffect(() => {
    let active = true

    const initialize = async () => {
      await store.load()
      if (!active) return

      setDisplayMessages(rebuildDisplay(store.history))
      store.setChangeListener(() => setStoreRevision((revision) => revision + 1))
      setStateLoaded(true)
    }

    void initialize()
    return () => {
      active = false
      store.setChangeListener(() => undefined)
      approvalResolver.current?.(false)
    }
  }, [])

  useEffect(() => {
    if (runStartedAt === null) return
    const updateElapsed = () => setElapsedSeconds(Math.floor((Date.now() - runStartedAt) / 1000))
    updateElapsed()
    const interval = setInterval(updateElapsed, 1000)
    return () => clearInterval(interval)
  }, [runStartedAt])

  const handleSend = async () => {
    const text = input.trim()
    if (!text || isSending || !stateLoaded) return

    const config = store.activeConfig
    if (!config) {
      addDisplayMessage({
        role: 'assistant',
        text: 'Add an API connection in settings to start chatting.',
        isError: true,
      })
      return
    }

    const trimmedApiKey = store.getApiKey(config.id).trim()
    if (!trimmedApiKey) {
      addDisplayMessage({ role: 'assistant', text: 'Enter an API key to continue.', isError: true })
      return
    }

    const resolvedBaseUrl = config.baseUrl.trim() || DEFAULT_BASE_URLS[config.provider]
    const resolvedModel = config.model.trim() || DEFAULT_MODELS[config.provider]

    setInput('')
    addDisplayMessage({ role: 'user', text })
    setActiveView('chat')
    setIsSending(true)
    setRunStartedAt(Date.now())
    stopRequested.current = false

    try {
      let tools: ToolDef[] = []
      try {
        tools = await getToolDefs()
      } catch {
        addDisplayMessage({
          role: 'assistant',
          isToolActivity: true,
          text: '⚠ Could not load tools. Running in conversation-only mode.',
          isError: true,
        })
      }

      await agentRunner.run(
        text,
        { provider: config.provider, baseUrl: resolvedBaseUrl, apiKey: trimmedApiKey, model: resolvedModel, tools },
        {
          getHistory: () => store.history,
          appendHistory: (message) => store.append(message),
          executeTool: executeInPlugin,
          requestApproval,
          addDisplayMessage,
        }
      )
    } catch (error) {
      const aborted =
        stopRequested.current || (error instanceof Error && error.name === 'AbortError')
      addDisplayMessage({
        role: 'assistant',
        text: aborted ? '(Stopped)' : error instanceof Error ? error.message : String(error),
        isError: aborted ? undefined : true,
      })
    } finally {
      setIsSending(false)
      setRunStartedAt(null)
    }
  }

  const handleInputKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      void handleSend()
    }
  }

  const handleStop = () => {
    stopRequested.current = true
    resolveApproval(false)
    agentRunner.abort()
  }

  const openChat = (id: string) => {
    if (isSending || !store.loadChat(id)) return
    setDisplayMessages(rebuildDisplay(store.history))
    setActiveView('chat')
  }

  const deleteChat = (id: string) => {
    if (isSending) return
    if (store.deleteChat(id)) setDisplayMessages([])
  }

  const startNewChat = () => {
    if (isSending) return
    store.startNewChat()
    setDisplayMessages([])
    setActiveView('chat')
  }

  const configs = store.configs
  const activeConfig = store.activeConfig
  const apiReady = activeConfig !== null && store.getApiKey(activeConfig.id).trim().length > 0

  return (
    <main className="app">
      <div className="app-body">
        <nav className="sidebar" aria-label="Main menu">
          <button
            className={`nav-button ${activeView === 'chat' ? 'active' : ''}`}
            onClick={() => setActiveView('chat')}
            aria-label="Chat"
            title="Chat"
          >
            <Icon><path d="M4 4.75h12v8.5H9l-3.5 2.5v-2.5H4v-8.5Z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" /></Icon>
          </button>
          <button
            className={`nav-button ${activeView === 'history' ? 'active' : ''}`}
            onClick={() => setActiveView('history')}
            aria-label="Chat history"
            title="Chat history"
          >
            <Icon><path d="M4.2 6.2A6.5 6.5 0 1 1 3.6 12M4.2 6.2V2.9M4.2 6.2h3.3M10 6.2V10l2.6 1.6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></Icon>
          </button>
          <button
            className={`nav-button ${activeView === 'settings' ? 'active' : ''}`}
            onClick={() => setActiveView('settings')}
            aria-label="API settings"
            title="API settings"
          >
            <Icon><path d="M10 2.8v2M10 15.2v2M17.2 10h-2M4.8 10h-2M15.1 4.9l-1.4 1.4M6.3 13.7l-1.4 1.4M15.1 15.1l-1.4-1.4M6.3 6.3 4.9 4.9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /><circle cx="10" cy="10" r="3" stroke="currentColor" strokeWidth="1.5" /></Icon>
          </button>
        </nav>

        <div className="content">
          {activeView === 'settings' ? (
            <Settings
              configs={configs}
              activeConfigId={store.activeConfigId}
              getApiKey={(configId) => store.getApiKey(configId)}
              onActivate={(configId) => store.setActiveConfig(configId)}
              onDelete={(configId) => store.deleteConfig(configId)}
              onSave={(config, apiKey) => store.upsertConfig(config, apiKey)}
            />
          ) : activeView === 'history' ? (
            <section className="chat-page">
              <div className="chat-header">
                <div>
                  <h1>Chat history</h1>
                  <p>{store.chats.length} {store.chats.length === 1 ? 'conversation' : 'conversations'}</p>
                </div>
                <button className="primary-button compact" onClick={startNewChat} disabled={isSending}>New chat</button>
              </div>
              <History chats={store.chats} currentChatId={store.currentChatId} onOpen={openChat} onDelete={deleteChat} />
            </section>
          ) : (
            <section className="chat-page">
              <div className="chat-header">
                <div>
                  <h1>Chat</h1>
                  <div className="connection-line">
                    <span
                      className={`status-dot${apiReady ? ' ready' : ''}`}
                      title={apiReady ? 'Connected' : 'Not configured'}
                    />
                    {configs.length > 1 ? (
                      <div className="select-wrap compact">
                        <select
                          className="model-switcher"
                          aria-label="Active API connection"
                          value={store.activeConfigId ?? ''}
                          disabled={isSending}
                          onChange={(event) => store.setActiveConfig(event.target.value)}
                        >
                          {configs.map((config) => (
                            <option key={config.id} value={config.id}>
                              {connectionLabel(config)}
                            </option>
                          ))}
                        </select>
                      </div>
                    ) : (
                      <span className="connection-label">
                        {activeConfig ? connectionLabel(activeConfig) : 'No connection'}
                      </span>
                    )}
                  </div>
                </div>
                <button className="primary-button compact" onClick={startNewChat} disabled={isSending}>New chat</button>
              </div>

              {!apiReady && (
                <button className="setup-banner" onClick={() => setActiveView('settings')}>
                  <span><strong>Connect an API to start chatting</strong><small>Add your provider and API key in settings.</small></span>
                  <span aria-hidden="true">→</span>
                </button>
              )}

              <Messages messages={displayMessages} />

              {approvalCode !== null && <Approval code={approvalCode} onResolve={resolveApproval} />}

              <div id="input-row">
                <textarea
                  id="chat-input"
                  rows={2}
                  value={input}
                  placeholder="Ask Design Pilot to create or edit anything…"
                  onChange={(event) => setInput(event.target.value)}
                  onKeyDown={handleInputKeyDown}
                />
                {isSending && (
                  <span className="run-timer" title="Agent run elapsed time">
                    <span className="timer-dot" aria-hidden="true" />
                    {formatElapsed(elapsedSeconds)}
                  </span>
                )}
                {isSending ? (
                  <button id="stop" className="send-button" onClick={handleStop} aria-label="Stop">■</button>
                ) : (
                  <button id="send" className="send-button" disabled={!stateLoaded || !input.trim()} onClick={() => void handleSend()} aria-label="Send">↑</button>
                )}
              </div>
            </section>
          )}
        </div>
      </div>
    </main>
  )
}
