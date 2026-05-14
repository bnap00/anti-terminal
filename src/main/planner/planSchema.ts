import { z } from "zod";

export const actionSpecSchema = z.object({
  id: z.string(),
  label: z.string(),
  command: z.string(),
  targetViewId: z.string().optional(),
  description: z.string().optional()
});

export const viewNodeSchema = z.discriminatedUnion("type", [
  z.object({
    id: z.string(),
    type: z.literal("markdown"),
    title: z.string().optional(),
    content: z.string()
  }),
  z.object({
    id: z.string(),
    type: z.literal("html"),
    title: z.string().optional(),
    content: z.string()
  }),
  z.object({
    id: z.string(),
    type: z.literal("log"),
    title: z.string().optional(),
    content: z.string()
  }),
  z.object({
    id: z.string(),
    type: z.literal("stats"),
    title: z.string().optional(),
    items: z.array(
      z.object({
        label: z.string(),
        value: z.string()
      })
    )
  }),
  z.object({
    id: z.string(),
    type: z.literal("table"),
    title: z.string().optional(),
    columns: z.array(z.string()),
    rows: z.array(z.record(z.string()))
  }),
  z.object({
    id: z.string(),
    type: z.literal("bar-chart"),
    title: z.string().optional(),
    items: z.array(
      z.object({
        label: z.string(),
        value: z.string(),
        bytes: z.number()
      })
    )
  }),
  z.object({
    id: z.string(),
    type: z.literal("actions"),
    title: z.string().optional(),
    actions: z.array(actionSpecSchema)
  })
]);

export const dataSourceSpecSchema = z.object({
  id: z.string(),
  command: z.string(),
  intervalMs: z.number().optional(),
  parser: z.enum(["raw", "git-log", "process-table", "du-table", "du-chart"]),
  targetViewId: z.string()
});

export const taskPlanSchema = z.object({
  title: z.string(),
  mode: z.enum(["one-shot", "streaming", "interactive"]),
  summary: z.string(),
  views: z.array(viewNodeSchema),
  dataSources: z.array(dataSourceSpecSchema)
});
