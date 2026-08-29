import { createAnthropic } from '@ai-sdk/anthropic'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import type { LanguageModel } from 'ai'
import { DEFAULT_BASE_URLS } from './config'
import type { ProviderType } from './types'

function withoutTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '')
}

export function normalizeBaseUrl(provider: ProviderType, value: string): string {
  const configured = withoutTrailingSlash(value.trim() || DEFAULT_BASE_URLS[provider])
  if (provider === 'anthropic') return configured.replace(/\/messages$/, '')
  return configured.replace(/\/chat\/completions$/, '')
}

export function createModel(
  provider: ProviderType,
  apiKey: string,
  baseUrl: string,
  modelId: string
): LanguageModel {
  const normalizedBaseUrl = normalizeBaseUrl(provider, baseUrl)

  if (provider === 'anthropic') {
    return createAnthropic({
      apiKey,
      baseURL: normalizedBaseUrl,
      headers: { 'anthropic-dangerous-direct-browser-access': 'true' },
    })(modelId)
  }

  return createOpenAICompatible({
    name: 'openai-compatible',
    apiKey,
    baseURL: normalizedBaseUrl,
    includeUsage: true,
  })(modelId)
}
