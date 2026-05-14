import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { AppSettings, ProviderType } from "./settings/types.js";

const LOCAL_PROVIDERS = new Set<ProviderType>(["ollama", "lmstudio", "opencode"]);

export function createProvider(settings: AppSettings) {
  const { provider } = settings;

  const config = settings.providers[provider];

  return createOpenAICompatible({
    name: provider,
    baseURL: config.baseUrl,
    // Local providers don't need a real key; send "local" as a placeholder
    apiKey: config.apiKey || (LOCAL_PROVIDERS.has(provider) ? "local" : ""),
    headers:
      provider === "openrouter"
        ? { "HTTP-Referer": "https://antiterminal.com", "X-Title": "anti terminal" }
        : {}
  });
}

export function getActiveModel(settings: AppSettings): string {
  return settings.providers[settings.provider].model;
}
