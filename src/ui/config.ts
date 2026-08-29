import type { ProviderType } from './types'

export const DEFAULT_PROVIDER: ProviderType = 'anthropic'
export const DEFAULT_BASE_URLS: Record<ProviderType, string> = {
  anthropic: 'https://api.anthropic.com/v1',
  'openai-compatible': 'https://api.openai.com/v1',
}
export const DEFAULT_MODELS: Record<ProviderType, string> = {
  anthropic: 'claude-sonnet-4-6',
  'openai-compatible': 'gpt-4.1',
}
export const MAX_OUTPUT_TOKENS = 4096
export const MAX_AGENT_STEPS = 10

export const SYSTEM_PROMPT = `You are a Figma design assistant with tools to read and modify the Figma document.

Rules:
- Read the selection with get_current_page_selection before modifying selected nodes.
- create_text loads its font for you; in execute_plugin_code, load fonts before touching text, e.g. await figma.loadFontAsync({ family: 'Inter', style: 'Regular' }).
- execute_plugin_code must be self-contained: no references to outside variables.
- Explicitly return what you want to see; returned Figma nodes are serialized to {id, name, type}.
- Prefer dedicated tools (create_rectangle, create_text, set_fill, rename_node) for simple edits; use execute_plugin_code for composed operations such as Auto Layout.
- execute_plugin_code is shown to the user for approval before it runs.`
