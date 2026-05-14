import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { defaultSettings, PROVIDER_DEFAULTS, type AppSettings } from "./types.js";

export class SettingsManager {
  constructor(private readonly filePath: string) {}

  async get(): Promise<AppSettings> {
    try {
      const raw = await readFile(this.filePath, "utf8");
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const parsed = JSON.parse(raw) as Record<string, any>;

      // Deep-merge providers so adding a new provider key never loses saved configs
      const providers = { ...PROVIDER_DEFAULTS };
      for (const key of Object.keys(providers) as Array<keyof typeof providers>) {
        if (parsed.providers?.[key]) {
          providers[key] = { ...providers[key], ...parsed.providers[key] };
        }
      }

      // Migrate from old flat fields — only if the new providers section doesn't already have the value
      if (typeof parsed.openrouterApiKey === "string" && !parsed.providers?.openrouter?.apiKey) {
        providers.openrouter.apiKey = parsed.openrouterApiKey;
      }
      if (typeof parsed.openrouterModel === "string" && !parsed.providers?.openrouter?.model) {
        providers.openrouter.model = parsed.openrouterModel;
      }

      return { ...defaultSettings, ...parsed, providers };
    } catch {
      return defaultSettings;
    }
  }

  async update(next: Partial<AppSettings>): Promise<AppSettings> {
    const current = await this.get();
    const providers = { ...current.providers };

    // Merge each provider sub-object independently so a partial update doesn't wipe other keys
    if (next.providers) {
      for (const key of Object.keys(next.providers) as Array<keyof typeof providers>) {
        providers[key] = { ...providers[key], ...next.providers[key] };
      }
    }

    const merged: AppSettings = { ...current, ...next, providers };
    // Strip legacy flat fields so they can't interfere with future reads
    const LEGACY = new Set(["openrouterApiKey", "openrouterModel", "appUrl", "appTitle"]);
    const clean = Object.fromEntries(
      Object.entries(merged as unknown as Record<string, unknown>).filter(([k]) => !LEGACY.has(k))
    );
    await mkdir(path.dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, JSON.stringify(clean, null, 2), "utf8");
    return merged;
  }
}
