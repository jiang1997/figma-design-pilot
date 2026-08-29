import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { AgentRunner } from './agent'
import { ChatStore } from './chat-store'
import { DEFAULT_BASE_URLS, DEFAULT_MODELS } from './config'
import { executeInPlugin, getToolDefs } from './plugin-client'
import { rebuildDisplay } from './protocol'
import type { DisplayMessage, ProviderType, SavedChat, ToolDef } from './types'

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

interface SettingsProps {
  provider: ProviderType
  baseUrl: string
  model: string
  apiKey: string
  onProviderChange: (provider: ProviderType) => void
  onBaseUrlChange: (value: string) => void
  onModelChange: (value: string) => void
  onApiKeyChange: (value: string) => void
}

function Settings({
  provider,
  baseUrl,
  model,
  apiKey,
  onProviderChange,
  onBaseUrlChange,
  onModelChange,
  onApiKeyChange,
}: SettingsProps) {
  return (
    <>
      <select
        id="provider"
        aria-label="Model provider"
        value={provider}
        onChange={(event) => onProviderChange(event.target.value as ProviderType)}
      >
        <option value="anthropic">Anthropic</option>
        <option value="openai-compatible">OpenAI Compatible</option>
      </select>
      <input
        id="api-url"
        type="text"
        value={baseUrl}
        placeholder={`Base URL (default: ${DEFAULT_BASE_URLS[provider]})`}
        onChange={(event) => onBaseUrlChange(event.target.value)}
        onBlur={() => store.updateSettings({ baseUrl: baseUrl.trim() })}
      />
      <input
        id="model"
        type="text"
        value={model}
        placeholder={`Model (default: ${DEFAULT_MODELS[provider]})`}
        onChange={(event) => onModelChange(event.target.value)}
        onBlur={() => store.updateSettings({ model: model.trim() })}
      />
      <input
        id="api-key"
        type="password"
        value={apiKey}
        placeholder="API Key"
        onChange={(event) => onApiKeyChange(event.target.value)}
        onBlur={() => store.saveApiKey(apiKey.trim())}
      />
    </>
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
        <div className="hint">Send a message to start a conversation.</div>
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
  const [provider, setProvider] = useState<ProviderType>('anthropic')
  const [baseUrl, setBaseUrl] = useState('')
  const [model, setModel] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [input, setInput] = useState('')
  const [displayMessages, setDisplayMessages] = useState<DisplayMessage[]>([])
  const [historyOpen, setHistoryOpen] = useState(false)
  const [isSending, setIsSending] = useState(false)
  const [stateLoaded, setStateLoaded] = useState(false)
  const [, setStoreRevision] = useState(0)
  const [approvalCode, setApprovalCode] = useState<string | null>(null)
  const approvalResolver = useRef<((approved: boolean) => void) | null>(null)
  const stopRequested = useRef(false)

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
      const savedApiKey = await store.load()
      if (!active) return

      setProvider(store.settings.provider)
      setBaseUrl(store.settings.baseUrl)
      setModel(store.settings.model)
      setApiKey(savedApiKey)
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

  const handleSend = async () => {
    const text = input.trim()
    const trimmedApiKey = apiKey.trim()
    if (!text || isSending || !stateLoaded) return

    if (!trimmedApiKey) {
      addDisplayMessage({ role: 'assistant', text: 'Enter an API key to continue.', isError: true })
      return
    }

    const resolvedBaseUrl = baseUrl.trim() || DEFAULT_BASE_URLS[provider]
    const resolvedModel = model.trim() || DEFAULT_MODELS[provider]

    setInput('')
    addDisplayMessage({ role: 'user', text })
    setHistoryOpen(false)
    setIsSending(true)
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
        { provider, baseUrl: resolvedBaseUrl, apiKey: trimmedApiKey, model: resolvedModel, tools },
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
    setHistoryOpen(false)
  }

  const deleteChat = (id: string) => {
    if (isSending) return
    if (store.deleteChat(id)) setDisplayMessages([])
  }

  const startNewChat = () => {
    if (isSending) return
    store.startNewChat()
    setDisplayMessages([])
    setHistoryOpen(false)
  }

  return (
    <main className="app">
      <Settings
        provider={provider}
        baseUrl={baseUrl}
        model={model}
        apiKey={apiKey}
        onProviderChange={(nextProvider) => {
          setProvider(nextProvider)
          store.updateSettings({ provider: nextProvider })
        }}
        onBaseUrlChange={setBaseUrl}
        onModelChange={setModel}
        onApiKeyChange={setApiKey}
      />
      <div id="chat-bar">
        <button onClick={() => setHistoryOpen((open) => !open)}>
          {historyOpen ? 'Back to chat' : 'History'}
        </button>
        <button onClick={startNewChat} disabled={isSending}>
          New chat
        </button>
      </div>

      {historyOpen ? (
        <History
          chats={store.chats}
          currentChatId={store.currentChatId}
          onOpen={openChat}
          onDelete={deleteChat}
        />
      ) : (
        <Messages messages={displayMessages} />
      )}

      {approvalCode !== null && <Approval code={approvalCode} onResolve={resolveApproval} />}

      <div id="input-row">
        <textarea
          id="chat-input"
          rows={2}
          value={input}
          placeholder="Type a message. Press Enter to send."
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={handleInputKeyDown}
        />
        <button id="send" disabled={isSending || !stateLoaded} onClick={() => void handleSend()}>
          {isSending ? 'Sending…' : 'Send'}
        </button>
        {isSending && (
          <button id="stop" onClick={handleStop}>
            Stop
          </button>
        )}
      </div>
    </main>
  )
}
