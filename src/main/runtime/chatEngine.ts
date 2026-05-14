import { generateText } from "ai";
import { z } from "zod";

import { formatComponentDocs } from "../components/registry.js";
import type { AppSettings } from "../settings/types.js";
import { DEFAULT_CHAT_SYSTEM_PROMPT } from "../settings/types.js";
import type { DataSourceSpec, TaskSession, ViewNode } from "./types.js";
import { createProvider, getActiveModel } from "../aiProvider.js";
import { runCommand } from "./shell.js";

const rawViewSchema = z.object({
  id: z.string().describe("Kebab-case ID; reuse an existing view ID to update in place"),
  type: z.string(),
  title: z.string(),
  // string-payload types (log, markdown, html, code, diff, json-tree, terminal)
  content: z.string().optional(),
  lang: z.string().optional(),
  // structured-data types (line-chart, pie-chart, gauge, timeline, form, …)
  data: z.record(z.string(), z.unknown()).optional(),
  // legacy inline fields kept for backward-compat (bar-chart, table, stats)
  items: z.array(z.unknown()).optional(),
  columns: z.array(z.string()).optional(),
  rows: z.array(z.record(z.string(), z.string())).optional()
});

const chatResponseSchema = z.object({
  reply: z.string().min(1).describe("Conversational response — always present"),
  run: z
    .string()
    .optional()
    .describe("Execute this read-only shell command and receive its output before producing the final response. Use for multi-step queries where you need intermediate data."),
  load_components: z
    .array(z.string())
    .optional()
    .describe("Request full docs for these component types before generating the view"),
  view: rawViewSchema.nullable().optional().describe("Omit when no visual output is needed"),
  command: z
    .object({
      shell: z.string().describe("Read-only bash command"),
      parser: z
        .enum(["raw", "git-log", "process-table", "du-table", "du-chart"])
        .describe("Parser for the command output"),
      intervalMs: z.number().nullish().describe("Set for live views; omit for one-shot")
    })
    .nullable()
    .optional()
    .describe("Required when view needs shell data; omit for html/form/static views")
});

export type ChatResponse = z.infer<typeof chatResponseSchema>;
export type ChatResult = ChatResponse & { _usage: { input: number; output: number } };

type DebugLogger = (entry: { level: "info" | "warn" | "error"; message: string; detail?: string }) => void;
type StepCallback = (hint: string) => void;

const MAX_AGENT_STEPS = 5;

export async function sendChatMessage(
  userText: string,
  session: TaskSession,
  settings: AppSettings,
  cwd: string,
  log: DebugLogger = () => undefined,
  retryHint?: string,
  onStep?: StepCallback
): Promise<ChatResult> {
  const provider = createProvider(settings);
  const model = getActiveModel(settings);
  const systemPrompt = buildSystemPrompt(session, cwd, retryHint, settings.chatSystemPrompt);

  let agentMessages: Array<{ role: "user" | "assistant"; content: string }> = [
    ...session.messages.map((msg) => ({
      role: msg.role as "user" | "assistant",
      content: msg.content
    })),
    { role: "user", content: userText }
  ];

  const totalUsage = { input: 0, output: 0 };

  log({ level: "info", message: `Chat request started${retryHint ? " (retry)" : ""}.`, detail: userText.slice(0, 120) });

  for (let step = 0; step <= MAX_AGENT_STEPS; step++) {
    const result = await callModel(provider, model, systemPrompt, agentMessages);
    totalUsage.input += result.usage.inputTokens ?? 0;
    totalUsage.output += result.usage.outputTokens ?? 0;

    const responseText = result.text ?? "";
    console.log(`[chatEngine] step ${step} response (${responseText.length} chars):\n`, responseText);
    log({ level: "info", message: `Step ${step} response.`, detail: responseText.slice(0, 500) || "(empty)" });

    if (!responseText.trim()) {
      console.error("[chatEngine] Empty response at step", step);
      throw new Error("Model returned an empty response.");
    }

    let parsed: ChatResponse;
    try {
      const raw = extractJson(responseText);
      parsed = chatResponseSchema.parse(raw);
    } catch (err) {
      console.error("[chatEngine] Parse failed at step", step, ":", err, "\n", responseText);
      throw new Error("Chat response was not valid JSON.");
    }

    // load_components — inject schema docs then continue
    if (parsed.load_components?.length) {
      const docs = formatComponentDocs(parsed.load_components);
      log({ level: "info", message: "Agent requested component docs.", detail: parsed.load_components.join(", ") });
      onStep?.("Loading component docs…");
      agentMessages = [
        ...agentMessages,
        { role: "assistant", content: result.text },
        {
          role: "user",
          content: [
            "Here are the full component docs you requested:",
            "",
            docs,
            "",
            "Now generate your final response. Do NOT include load_components."
          ].join("\n")
        }
      ];
      continue;
    }

    // run — execute intermediate shell command, feed output back, continue
    if (parsed.run) {
      const cmd = parsed.run;
      log({ level: "info", message: "Agent intermediate run.", detail: cmd });
      onStep?.(`Running: ${cmd.length > 60 ? cmd.slice(0, 57) + "…" : cmd}`);

      const cmdResult = await runCommand(cmd, cwd);
      const output = [cmdResult.stdout.trim(), cmdResult.stderr.trim()]
        .filter(Boolean)
        .join("\n")
        .slice(0, 4000);

      log({ level: "info", message: "Intermediate run output.", detail: output.slice(0, 300) });

      agentMessages = [
        ...agentMessages,
        { role: "assistant", content: result.text },
        {
          role: "user",
          content: [
            `Output of \`${cmd}\`:`,
            "```",
            output || "(no output)",
            "```",
            "Now produce your final response using this. Do NOT include `run`."
          ].join("\n")
        }
      ];
      continue;
    }

    // Final response — no run, no load_components
    log({ level: "info", message: "Final response parsed.", detail: JSON.stringify(parsed).slice(0, 200) });
    return { ...parsed, _usage: totalUsage };
  }

  throw new Error("Agent loop exceeded maximum steps.");
}

async function callModel(
  provider: ReturnType<typeof createProvider>,
  model: string,
  system: string,
  messages: Array<{ role: "user" | "assistant"; content: string }>
) {
  return generateText({ model: provider(model), system, messages, temperature: 0.3 });
}

function buildSystemPrompt(session: TaskSession, cwd: string, retryHint?: string, customPrompt?: string): string {
  const viewContext = serializeViews(session.views);
  const staticSection = customPrompt ?? DEFAULT_CHAT_SYSTEM_PROMPT;

  return [
    staticSection,
    "",
    `Session: "${session.title}" | mode: ${session.mode} | workspace: ${cwd}`,
    "",
    "Current views (use these IDs to update them in place):",
    viewContext || "(none yet)",
    ...(retryHint ? ["", retryHint] : [])
  ].join("\n");
}

function serializeViews(views: ViewNode[]): string {
  return views
    .map((v) => {
      const header = `[${v.id}] ${v.type} "${v.title ?? v.id}"`;
      if (v.type === "bar-chart") {
        const sample = v.items.slice(0, 8).map((i) => `  ${i.value}  ${i.label}`).join("\n");
        return `${header} (${v.items.length} items):\n${sample}`;
      }
      if (v.type === "table") {
        const cols = v.columns.join(" | ");
        const sample = v.rows.slice(0, 5).map((r) => v.columns.map((c) => r[c] ?? "").join(" | ")).join("\n");
        return `${header} (${v.rows.length} rows, cols: ${cols}):\n${sample}`;
      }
      if (v.type === "log" || v.type === "markdown" || v.type === "code" || v.type === "diff" || v.type === "json-tree" || v.type === "terminal") {
        return `${header}:\n${v.content.slice(0, 200)}`;
      }
      if (v.type === "stats") {
        return `${header}: ${v.items.map((i) => `${i.label}=${i.value}`).join(", ")}`;
      }
      if (v.type === "actions") {
        return `${header}: ${v.actions.map((a) => `[${a.id}] ${a.label}`).join(", ")}`;
      }
      return header;
    })
    .join("\n\n");
}

export function rawViewToViewNode(raw: z.infer<typeof rawViewSchema>): ViewNode {
  const { id, title, content = "", lang, data = {}, items = [], columns = [], rows = [] } = raw;
  const type = raw.type;

  // For structured data types, pass data through directly
  const asViewNode = (extra: Record<string, unknown>): ViewNode =>
    ({ id, title, ...extra }) as unknown as ViewNode;

  switch (type) {
    case "bar-chart":
      return asViewNode({ type, items: (data.items ?? items) });
    case "table":
      return asViewNode({ type, columns: (data.columns ?? columns), rows: (data.rows ?? rows) });
    case "stats":
      return asViewNode({ type, items: (data.items ?? items) });
    case "actions":
      return asViewNode({ type, actions: (data.actions ?? []) });
    case "log":      return asViewNode({ type: "log", content });
    case "markdown": return asViewNode({ type: "markdown", content });
    case "html":     return asViewNode({ type: "html", content });
    case "terminal": return asViewNode({ type: "terminal", content });
    case "diff":     return asViewNode({ type: "diff", content });
    case "json-tree":return asViewNode({ type: "json-tree", content });
    case "code":     return asViewNode({ type: "code", lang, content });
    default:
      // All data-driven types: line-chart, pie-chart, gauge, timeline, form,
      // progress, alert, image, kanban, file-tree, metric, card-grid, heatmap
      return asViewNode({ type, data });
  }
}

function extractJson(value: string): unknown {
  const stripped = value.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/i, "").trim();
  try {
    return JSON.parse(stripped);
  } catch {
    const first = stripped.indexOf("{");
    const last = stripped.lastIndexOf("}");
    if (first >= 0 && last > first) return JSON.parse(stripped.slice(first, last + 1));
    throw new Error("No valid JSON found in response.");
  }
}

export function buildEmptyView(
  id: string,
  type: "bar-chart" | "table" | "log" | "stats" | "html",
  title: string
): ViewNode {
  switch (type) {
    case "bar-chart": return { id, type, title, items: [] };
    case "table": return { id, type, title, columns: [], rows: [] };
    case "stats": return { id, type, title, items: [] };
    case "html": return { id, type, title, content: "" };
    default: return { id, type: "log", title, content: "" };
  }
}

export type { DataSourceSpec };
