import { generateText } from "ai";
import { z } from "zod";

import type { TaskPlan } from "../runtime/types.js";
import type { AppSettings } from "../settings/types.js";
import { createProvider, getActiveModel } from "../aiProvider.js";
import { taskPlanSchema } from "./planSchema.js";

// Permissive schema for model output — command/parser may appear on views or in dataSources.
// normalizePlan() consolidates both forms into the strict runtime shape.
const plannerOutputSchema = z.object({
  title: z.string().optional(),
  mode: z.enum(["one-shot", "streaming", "interactive"]).optional(),
  summary: z.string().optional(),
  views: z
    .array(
      z.object({
        id: z.string().optional(),
        type: z.string().describe("View type: markdown, log, stats, table, bar-chart, actions"),
        title: z.string().optional(),
        content: z.string().optional().describe("For markdown/log views"),
        items: z.array(z.any()).optional().describe("For stats/bar-chart views"),
        columns: z.array(z.string()).optional().describe("For table views"),
        rows: z.array(z.record(z.string())).optional().describe("For table views"),
        actions: z.array(z.any()).optional().describe("For actions views"),
        command: z.string().optional().describe("Shell command to populate this view"),
        parser: z
          .string()
          .optional()
          .describe("Parser: raw, git-log, process-table, du-table, du-chart"),
        intervalMs: z.number().optional().describe("Update interval ms for live views")
      })
    )
    .optional(),
  dataSources: z
    .array(
      z.object({
        id: z.string().optional(),
        command: z.string(),
        parser: z.string(),
        targetViewId: z.string(),
        intervalMs: z.number().optional()
      })
    )
    .optional()
    .describe("Explicit data sources — alternative to attaching command/parser on views")
});

type DebugLogger = (entry: { level: "info" | "warn" | "error"; message: string; detail?: string }) => void;

export async function createAIPlan(
  prompt: string,
  settings: AppSettings,
  cwd: string,
  log: DebugLogger = () => undefined
): Promise<TaskPlan> {
  const provider = createProvider(settings);
  const model = getActiveModel(settings);

  const systemPrompt = [
    "You are the planning model for anti terminal, an Electron shell assistant.",
    "Return JSON only. No markdown fences. No explanation outside the JSON.",
    "Choose exactly one mode: one-shot, streaming, or interactive.",
    "Attach command and parser directly to views that need shell data.",
    "Use only view types: markdown, html, log, stats, table, bar-chart, actions.",
    "Use html view for interactive widgets, SVG charts, styled tables, or any rich visual content. Put body-level HTML/CSS/JS in the content field — no <html>/<head>/<body> wrapper, no command needed.",
    "html renders inline in the app (not an iframe). Inherit the dark theme via CSS vars: --text, --accent, --muted, --bg, --border, --success, --warn, --danger. Font: 'IBM Plex Sans', system-ui.",
    "html scripts can call `const r = await window.antiTerminal.runShell('command')` and receive {stdout, stderr, code, status, commandId}. Non-read commands are allowed only after the runtime shows an approval card.",
    "Use only parsers: raw, git-log, process-table, du-table, du-chart.",
    "Use bar-chart view with du-chart parser for graphs, charts, or size comparisons.",
    "Commands must be bash-compatible and read-only. No destructive commands or package installs.",
    "NEVER run unbounded recursive scans. For file-size queries always use: find . -maxdepth 3 -type f -exec du -h {} + 2>/dev/null | sort -rh | head -n 20  OR  du -ah --max-depth=2 . 2>/dev/null | sort -rh | head -n 20.",
    "For interactive tasks, include at least one actions view.",
    "For streaming tasks, set intervalMs (e.g. 2000) on views with commands.",
    `Current working directory: ${cwd}`,
    "Known good commands:",
    "  git log --pretty=format:'%h%x09%an%x09%ad%x09%s' --date=short -n 8  (parser: git-log)",
    "  ps aux | sort -nrk 3 | head -n 12  (parser: process-table)",
    "  find . -type f -maxdepth 3 -exec du -h {} + 2>/dev/null | sort -hr | head -n 15  (parser: du-table or du-chart)",
    "  Raw text output uses parser: raw",
    'Schema: { title, mode, summary, views: [{ id?, type, title?, content?, items?, columns?, rows?, actions?, command?, parser?, intervalMs? }], dataSources?: [{ id?, command, parser, targetViewId, intervalMs? }] }'
  ].join("\n");

  log({ level: "info", message: "OpenRouter request started." });
  log({ level: "info", message: "Agent outbound system prompt.", detail: systemPrompt });
  log({ level: "info", message: "Agent outbound user prompt.", detail: prompt });

  const { text } = await generateText({
    model: provider(model),
    system: systemPrompt,
    prompt,
    temperature: 0.2
  });

  log({ level: "info", message: "Agent raw plan received.", detail: text.slice(0, 500) });
  const output = plannerOutputSchema.parse(extractJson(text));

  const normalized = normalizePlan(output);

  log({ level: "info", message: "Agent normalized plan.", detail: JSON.stringify(normalized).slice(0, 500) });

  return taskPlanSchema.parse(normalized);
}

function normalizePlan(value: unknown): unknown {
  if (!value || typeof value !== "object") return value;

  const record = value as Record<string, unknown>;
  const mode = typeof record.mode === "string" ? record.mode : "one-shot";
  const views = Array.isArray(record.views) ? record.views : [];
  const dataSources = Array.isArray(record.dataSources) ? [...record.dataSources] : [];

  const normalizedViews = views.map((view, index) => {
    if (!view || typeof view !== "object") return view;

    const item = view as Record<string, unknown>;
    const id =
      typeof item.id === "string"
        ? item.id
        : typeof item.title === "string"
          ? slugify(item.title)
          : `view-${index + 1}`;

    const normalized: Record<string, unknown> = { ...item, id };

    if (item.type === "table") {
      normalized.columns = Array.isArray(item.columns)
        ? item.columns
        : inferColumnsFromParser(typeof item.parser === "string" ? item.parser : "raw");
      normalized.rows = Array.isArray(item.rows) ? item.rows : [];
    }
    if (item.type === "stats") normalized.items = Array.isArray(item.items) ? item.items : [];
    if (item.type === "bar-chart") normalized.items = Array.isArray(item.items) ? item.items : [];
    if ((item.type === "markdown" || item.type === "html" || item.type === "log") && typeof item.content !== "string") {
      normalized.content = "";
    }
    if (item.type === "actions" && !Array.isArray(item.actions)) normalized.actions = [];

    const parser = typeof item.parser === "string" ? item.parser : undefined;
    const command = typeof item.command === "string" ? item.command : undefined;
    if (parser && command) {
      dataSources.push({
        id: `${id}-source`,
        command,
        parser,
        targetViewId: id,
        ...(mode === "streaming"
          ? { intervalMs: typeof item.intervalMs === "number" ? item.intervalMs : 2000 }
          : {})
      });
    }

    delete normalized.parser;
    delete normalized.command;
    delete normalized.intervalMs;
    return normalized;
  });

  return {
    title: typeof record.title === "string" ? record.title : inferTitle(normalizedViews, mode),
    mode,
    summary:
      typeof record.summary === "string"
        ? record.summary
        : "Planned by OpenRouter and normalized into the anti terminal runtime schema.",
    views: normalizedViews,
    dataSources
  };
}

function inferColumnsFromParser(parser: string): string[] {
  switch (parser) {
    case "git-log":
      return ["hash", "author", "date", "subject"];
    case "process-table":
      return ["user", "pid", "cpu", "mem", "command"];
    case "du-table":
      return ["size", "path"];
    default:
      return ["value"];
  }
}

function inferTitle(views: unknown[], mode: string): string {
  const titled = views.find(
    (v): v is Record<string, unknown> =>
      !!v && typeof v === "object" && typeof (v as Record<string, unknown>).title === "string"
  );
  return (titled?.title as string | undefined) ?? `${mode} task`;
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function extractJson(value: string): unknown {
  const stripped = value.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/i, "").trim();
  try {
    return JSON.parse(stripped);
  } catch {
    const first = stripped.indexOf("{");
    const last = stripped.lastIndexOf("}");
    if (first >= 0 && last > first) return JSON.parse(stripped.slice(first, last + 1));
    throw new Error("Planner response was not valid JSON.");
  }
}
