import type { TaskPlan } from "../runtime/types.js";
import type { AppSettings, ProviderType } from "../settings/types.js";
import { createPlan as createMockPlan } from "./mockPlanner.js";
import { createAIPlan } from "./openRouterPlanner.js";

type PlannerLogger = (entry: { level: "info" | "warn" | "error"; message: string; detail?: string }) => void;

const LOCAL_PROVIDERS = new Set<ProviderType>(["ollama", "lmstudio", "opencode"]);

function isReady(settings: AppSettings): boolean {
  const { provider } = settings;
  if (LOCAL_PROVIDERS.has(provider)) return true; // local providers don't need a key
  return !!settings.providers[provider].apiKey.trim();
}

export async function createTaskPlan(
  prompt: string,
  settings: AppSettings,
  cwd: string,
  log: PlannerLogger = () => undefined
): Promise<{ plan: TaskPlan; source: ProviderType | "mock" }> {
  log({
    level: "info",
    message: `Planning request with provider ${settings.provider}.`,
    detail: prompt
  });

  if (isReady(settings)) {
    const { provider } = settings;
    const model = settings.providers[provider as Exclude<ProviderType, "mock">].model;
    try {
      log({ level: "info", message: `Calling ${provider} with model ${model}.` });
      return { plan: await createAIPlan(prompt, settings, cwd, log), source: provider };
    } catch (error) {
      log({
        level: "warn",
        message: `${provider} planner failed. Falling back to mock planner.`,
        detail: error instanceof Error ? error.message : String(error)
      });
      console.error(`${provider} planner failed, falling back to mock planner.`, error);
    }
  }

  log({ level: "info", message: "Using mock planner." });
  return { plan: createMockPlan(prompt), source: "mock" };
}
