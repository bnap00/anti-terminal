import { useEffect, useState } from "react";
import type { AppSettings, ProviderType } from "../main/settings/types";
import { DEFAULT_CHAT_SYSTEM_PROMPT } from "../main/settings/types";

interface ProviderMeta {
  label: string;
  needsKey: boolean;
  showBaseUrl: boolean;
  keyPlaceholder?: string;
  urlPlaceholder?: string;
  modelPlaceholder?: string;
}

const PROVIDER_META: Record<Exclude<ProviderType, "mock">, ProviderMeta> = {
  openrouter: {
    label: "OpenRouter",
    needsKey: true,
    showBaseUrl: false,
    keyPlaceholder: "sk-or-v1-…",
    modelPlaceholder: "openrouter/auto"
  },
  openai: {
    label: "OpenAI",
    needsKey: true,
    showBaseUrl: false,
    keyPlaceholder: "sk-…",
    modelPlaceholder: "gpt-4o"
  },
  opencode: {
    label: "OpenCode",
    needsKey: true,
    showBaseUrl: true,
    urlPlaceholder: "https://opencode.ai/zen/go/v1",
    modelPlaceholder: "kimi-k2.6"
  },
  ollama: {
    label: "Ollama",
    needsKey: false,
    showBaseUrl: true,
    urlPlaceholder: "http://localhost:11434/v1",
    modelPlaceholder: "llama3.2"
  },
  lmstudio: {
    label: "LM Studio",
    needsKey: false,
    showBaseUrl: true,
    urlPlaceholder: "http://localhost:1234/v1",
    modelPlaceholder: "local-model"
  }
};

const ALL_PROVIDERS: ProviderType[] = ["openrouter", "openai", "opencode", "ollama", "lmstudio"];

export default function SettingsPage() {
  const bridge = window.antiTerminal;
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<"idle" | "saved" | "error">("idle");
  const [errorMsg, setErrorMsg] = useState("");

  useEffect(() => {
    void bridge?.getSettings().then(setSettings);
  }, [bridge]);

  async function handleSave() {
    if (!bridge || !settings) return;
    setSaving(true);
    setStatus("idle");
    try {
      const saved = await bridge.updateSettings(settings);
      setSettings(saved);
      setStatus("saved");
      setTimeout(() => setStatus("idle"), 2000);
    } catch (e: unknown) {
      setErrorMsg(e instanceof Error ? e.message : "Failed to save.");
      setStatus("error");
    } finally {
      setSaving(false);
    }
  }

  function patchProvider(key: keyof AppSettings["providers"][Exclude<ProviderType, "mock">], value: string) {
    const p = settings?.provider;
    if (!p || p === "mock" || !settings) return;
    setSettings((s) =>
      s
        ? {
            ...s,
            providers: {
              ...s.providers,
              [p]: { ...s.providers[p], [key]: value }
            }
          }
        : s
    );
  }

  if (!settings) {
    return <div className="sp-loading">Loading settings…</div>;
  }

  const activeProvider = settings.provider;
  const meta = activeProvider !== "mock" ? PROVIDER_META[activeProvider] : null;
  const config = activeProvider !== "mock" ? settings.providers[activeProvider] : null;

  return (
    <div className="sp-root">
      <header className="sp-header">
        <span className="sp-title">Settings</span>
        <span className="sp-subtitle">anti terminal</span>
      </header>

      <div className="sp-body">
        {/* Provider selection */}
        <section className="sp-section">
          <div className="sp-section-label">Provider</div>
          <div className="sp-provider-grid">
            {ALL_PROVIDERS.map((p) => (
              <button
                key={p}
                className={`sp-provider-btn ${settings.provider === p ? "active" : ""}`}
                onClick={() => setSettings((s) => (s ? { ...s, provider: p } : s))}
              >
                {p === "mock" ? "Mock" : PROVIDER_META[p].label}
                {p === "mock" && <span className="sp-provider-badge">offline</span>}
                {p === "opencode" && <span className="sp-provider-badge">proxy</span>}
                {(p === "ollama" || p === "lmstudio") && (
                  <span className="sp-provider-badge">local</span>
                )}
              </button>
            ))}
          </div>
        </section>

        {/* Provider-specific config */}
        {meta && config && (
          <section className="sp-section">
            <div className="sp-section-label">{meta.label}</div>

            {meta.needsKey && (
              <label className="sp-field">
                <span>API key</span>
                <input
                  type="password"
                  value={config.apiKey}
                  onChange={(e) => patchProvider("apiKey", e.target.value)}
                  placeholder={meta.keyPlaceholder ?? ""}
                  spellCheck={false}
                />
              </label>
            )}

            {meta.showBaseUrl && (
              <label className="sp-field">
                <span>Base URL</span>
                <input
                  value={config.baseUrl}
                  onChange={(e) => patchProvider("baseUrl", e.target.value)}
                  placeholder={meta.urlPlaceholder ?? ""}
                  spellCheck={false}
                />
              </label>
            )}

            <label className="sp-field">
              <span>Model</span>
              <input
                value={config.model}
                onChange={(e) => patchProvider("model", e.target.value)}
                placeholder={meta.modelPlaceholder ?? ""}
                spellCheck={false}
              />
            </label>
          </section>
        )}

        {activeProvider === "mock" && (
          <section className="sp-section">
            <p className="sp-mock-note">
              Mock mode returns canned plans without any network requests. Useful for testing the UI.
            </p>
          </section>
        )}

        {/* System prompt */}
        <section className="sp-section">
          <div className="sp-section-header">
            <div className="sp-section-label">System prompt</div>
            <button
              className="sp-reset-btn"
              onClick={() => setSettings((s) => s ? { ...s, chatSystemPrompt: undefined } : s)}
              disabled={!settings.chatSystemPrompt}
            >
              Reset to default
            </button>
          </div>
          <textarea
            className="sp-prompt-textarea"
            value={settings.chatSystemPrompt ?? DEFAULT_CHAT_SYSTEM_PROMPT}
            onChange={(e) => setSettings((s) => s ? { ...s, chatSystemPrompt: e.target.value } : s)}
            spellCheck={false}
            rows={14}
          />
        </section>

      </div>

      <footer className="sp-footer">
        {status === "saved" && <span className="sp-status-ok">Saved.</span>}
        {status === "error" && <span className="sp-status-err">{errorMsg}</span>}
        <button
          className="sp-save-btn"
          disabled={saving}
          onClick={() => void handleSave()}
        >
          {saving ? "Saving…" : "Save"}
        </button>
      </footer>
    </div>
  );
}
