export interface ComponentDoc {
  type: string;
  summary: string;
  dataSchema: string;
  example: Record<string, unknown>;
  tips: string[];
}

export const COMPONENT_REGISTRY: ComponentDoc[] = [
  {
    type: "line-chart",
    summary: "Time series or continuous data plotted as lines",
    dataSchema: `{
  points?: { x: string; y: number }[];
  series?: { name: string; points: { x: string; y: number }[] }[];
  xLabel?: string;
  yLabel?: string;
}`,
    example: {
      id: "cpu-history", type: "line-chart", title: "CPU Usage",
      data: {
        points: [{ x: "10:00", y: 12 }, { x: "10:05", y: 45 }, { x: "10:10", y: 33 }],
        yLabel: "CPU %"
      }
    },
    tips: [
      "Use points for a single series; series for multiple overlapping lines.",
      "x values are string labels (time, dates, categories). y must be numbers.",
      "Pair with command + intervalMs for a live chart."
    ]
  },
  {
    type: "pie-chart",
    summary: "Proportional data as a pie or donut",
    dataSchema: `{
  items: { label: string; value: number; color?: string }[];
  donut?: boolean;
}`,
    example: {
      id: "lang-breakdown", type: "pie-chart", title: "Languages",
      data: {
        items: [{ label: "TypeScript", value: 68 }, { label: "CSS", value: 18 }, { label: "HTML", value: 14 }],
        donut: true
      }
    },
    tips: [
      "Values are relative — they don't need to sum to 100.",
      "Optional color is a hex string like '#4cc2ff'.",
      "Keep items ≤ 8 for readability. Set donut: true for a ring chart."
    ]
  },
  {
    type: "gauge",
    summary: "Single numeric value as a radial fill gauge",
    dataSchema: `{
  value: number;
  min: number;
  max: number;
  unit?: string;
  label?: string;
}`,
    example: {
      id: "cpu-gauge", type: "gauge", title: "CPU",
      data: { value: 67, min: 0, max: 100, unit: "%", label: "CPU" }
    },
    tips: [
      "Great for CPU %, disk usage, memory, battery.",
      "Value > 80% of range shows in warning color; > 90% in danger color.",
      "Pair with intervalMs for live monitoring."
    ]
  },
  {
    type: "code",
    summary: "Syntax-highlighted source code or config file",
    dataSchema: "(none — put code in content, language in lang)",
    example: {
      id: "file-view", type: "code", title: "package.json",
      lang: "json", content: '{\n  "name": "my-app"\n}'
    },
    tips: [
      "Set lang to: js, ts, json, bash, python, rust, go, yaml, css, html, etc.",
      "content is the raw code string. No command needed — embed code directly.",
      "Different from log — code has a language badge and styled background."
    ]
  },
  {
    type: "diff",
    summary: "Unified diff with green/red line highlighting",
    dataSchema: "(none — put unified diff text in content)",
    example: {
      id: "git-diff", type: "diff", title: "Changes",
      content: "--- a/file.ts\n+++ b/file.ts\n@@ -1,3 +1,4 @@\n line1\n-old line\n+new line\n+added line\n line3"
    },
    tips: [
      "content must be unified diff format (output of git diff, diff -u, etc.).",
      "Pair with command: { shell: 'git diff HEAD', parser: 'raw' }.",
      "Lines starting with + are green, - are red, @@ are purple/blue."
    ]
  },
  {
    type: "json-tree",
    summary: "Collapsible interactive JSON explorer",
    dataSchema: "(none — put JSON string in content)",
    example: {
      id: "api-response", type: "json-tree", title: "Response",
      content: '{"status":"ok","data":{"users":[{"id":1,"name":"Alice"}]}}'
    },
    tips: [
      "content must be a valid JSON string.",
      "Top 2 levels are auto-expanded; deeper nodes collapse.",
      "Great for API responses, config files, package.json inspection."
    ]
  },
  {
    type: "timeline",
    summary: "Ordered events list with timestamps and status dots",
    dataSchema: `{
  events: {
    time: string;
    label: string;
    detail?: string;
    status?: "info" | "success" | "warn" | "error";
  }[];
}`,
    example: {
      id: "deploy-log", type: "timeline", title: "Deploy",
      data: {
        events: [
          { time: "14:32", label: "Build started", status: "info" },
          { time: "14:34", label: "Tests passed", status: "success" },
          { time: "14:35", label: "Deploy failed", detail: "Container OOM", status: "error" }
        ]
      }
    },
    tips: [
      "Events are shown in order (top = first).",
      "status controls dot color: success=green, warn=yellow, error=red, info=blue.",
      "detail is a secondary line under the label."
    ]
  },
  {
    type: "form",
    summary: "Interactive form that runs a shell command with user inputs",
    dataSchema: `{
  fields: {
    name: string;
    label: string;
    type: "text" | "number" | "select" | "checkbox" | "textarea";
    placeholder?: string;
    options?: string[];
    defaultValue?: string;
    required?: boolean;
  }[];
  submitCommand: string;
  submitLabel?: string;
}`,
    example: {
      id: "deploy-form", type: "form", title: "Deploy",
      data: {
        fields: [
          { name: "env", label: "Environment", type: "select", options: ["staging", "production"] },
          { name: "tag", label: "Git Tag", type: "text", placeholder: "v1.2.3", required: true }
        ],
        submitCommand: "echo 'Deploying {{tag}} to {{env}}'",
        submitLabel: "Deploy"
      }
    },
    tips: [
      "submitCommand uses {{fieldName}} placeholders for field values.",
      "Form output renders in a log view below the form after submit.",
      "Write commands ARE allowed in form submissions.",
      "No command field needed — form handles its own execution."
    ]
  },
  {
    type: "progress",
    summary: "Step-by-step pipeline tracker or percentage bar",
    dataSchema: `{
  steps?: { label: string; status: "done" | "active" | "pending" | "error"; detail?: string }[];
  value?: number;
  max?: number;
  label?: string;
}`,
    example: {
      id: "pipeline", type: "progress", title: "Build Pipeline",
      data: {
        steps: [
          { label: "Install deps", status: "done" },
          { label: "Type check", status: "done" },
          { label: "Run tests", status: "active" },
          { label: "Build", status: "pending" },
          { label: "Deploy", status: "pending" }
        ]
      }
    },
    tips: [
      "Use steps for named stages (CI, wizard, checklist). Use value+max for a simple bar.",
      "active shows a pulsing animation. error shows red.",
      "Pair with intervalMs to auto-refresh."
    ]
  },
  {
    type: "alert",
    summary: "Info, success, warning, or error banner",
    dataSchema: `{
  message: string;
  level: "info" | "success" | "warn" | "error";
  detail?: string;
}`,
    example: {
      id: "disk-warn", type: "alert", title: "Disk Space",
      data: { message: "Disk usage above 90%", level: "warn", detail: "Run: npm cache clean" }
    },
    tips: [
      "Use for surfacing conditions from shell output.",
      "detail is a secondary line for context or next steps.",
      "No command needed — embed message directly."
    ]
  },
  {
    type: "image",
    summary: "Render an image by file path or data URI",
    dataSchema: `{
  src: string;
  alt?: string;
  caption?: string;
}`,
    example: {
      id: "screenshot", type: "image", title: "Screenshot",
      data: { src: "/Users/user/screenshot.png", caption: "v2.1.0" }
    },
    tips: [
      "src can be an absolute file path or a data: URI.",
      "caption shows below the image.",
      "Absolute paths are auto-converted to file:// URLs."
    ]
  },
  {
    type: "kanban",
    summary: "Kanban board with columns and cards",
    dataSchema: `{
  columns: {
    label: string;
    color?: string;
    cards: { id: string; title: string; body?: string; tags?: string[] }[];
  }[];
}`,
    example: {
      id: "sprint", type: "kanban", title: "Sprint",
      data: {
        columns: [
          { label: "Todo", cards: [{ id: "1", title: "Write tests", tags: ["backend"] }] },
          { label: "In Progress", cards: [{ id: "2", title: "Fix login", body: "Session bug", tags: ["urgent"] }] },
          { label: "Done", cards: [] }
        ]
      }
    },
    tips: [
      "Keep 3-5 columns for readability.",
      "tags render as chips under the card title.",
      "color is a hex string for the column header accent."
    ]
  },
  {
    type: "file-tree",
    summary: "Collapsible directory and file tree",
    dataSchema: `{
  nodes: { name: string; type: "file" | "dir"; children?: /* recursive */ }[];
}`,
    example: {
      id: "project-tree", type: "file-tree", title: "Project",
      data: {
        nodes: [
          { name: "src", type: "dir", children: [
            { name: "main.ts", type: "file" },
            { name: "renderer", type: "dir", children: [{ name: "App.tsx", type: "file" }] }
          ]},
          { name: "package.json", type: "file" }
        ]
      }
    },
    tips: [
      "dirs are collapsible; files show an extension-based icon.",
      "Build nodes from find output, or construct them directly.",
      "Pair with command: { shell: 'find . -maxdepth 3', parser: 'raw' } and build nodes in the data."
    ]
  },
  {
    type: "metric",
    summary: "Single large number with label, trend, and change indicator",
    dataSchema: `{
  value: string;
  label: string;
  change?: string;
  trend?: "up" | "down" | "neutral";
  subtext?: string;
}`,
    example: {
      id: "requests", type: "metric", title: "Requests",
      data: { value: "24,891", label: "Requests Today", change: "+8%", trend: "up", subtext: "vs. yesterday" }
    },
    tips: [
      "value is pre-formatted — use '1.2 GB', '99.9%', '1,204', not raw numbers.",
      "trend up = green arrow, down = red, neutral = gray dash.",
      "Place multiple metrics side-by-side for a dashboard feel."
    ]
  },
  {
    type: "card-grid",
    summary: "Grid of summary cards with title, body, footer, and tags",
    dataSchema: `{
  cards: { title: string; body?: string; footer?: string; accent?: string; tags?: string[] }[];
}`,
    example: {
      id: "services", type: "card-grid", title: "Services",
      data: {
        cards: [
          { title: "API", body: "Port 3000 · 142 MB", footer: "Uptime: 3d", accent: "#3dd68c", tags: ["healthy"] },
          { title: "Redis", body: "Port 6379 · 28 MB", footer: "Uptime: 3d", accent: "#3dd68c" },
          { title: "Worker", body: "89 MB", footer: "Queue: 0", accent: "#e4b349", tags: ["idle"] }
        ]
      }
    },
    tips: [
      "accent is a left-border color: #3dd68c (success), #e4b349 (warn), #ff6057 (danger), #4cc2ff (info).",
      "Great for service overviews, packages, environment summaries.",
      "tags render as small chips on the card."
    ]
  },
  {
    type: "heatmap",
    summary: "2D grid colored by value intensity, like a contribution graph",
    dataSchema: `{
  rows: string[];
  cols: string[];
  values: number[][];
  colorScale?: "blue" | "green" | "red";
}`,
    example: {
      id: "activity", type: "heatmap", title: "Commit Activity",
      data: {
        rows: ["Mon", "Tue", "Wed", "Thu", "Fri"],
        cols: ["W1", "W2", "W3", "W4"],
        values: [[3,5,0,2],[1,0,7,4],[0,3,2,6],[4,1,0,3],[2,8,5,1]],
        colorScale: "green"
      }
    },
    tips: [
      "values[rowIndex][colIndex] — must match rows and cols lengths.",
      "colorScale: green (default for activity), blue, or red.",
      "Color intensity scales automatically from min to max value."
    ]
  },
  {
    type: "terminal",
    summary: "Dark terminal-style streaming command output",
    dataSchema: "(none — put output text in content)",
    example: {
      id: "build-output", type: "terminal", title: "Build Output",
      content: "$ npm run build\n> tsc...\nDone in 3.4s"
    },
    tips: [
      "Like log but styled as a dark terminal (green text, monospace).",
      "Pair with command + intervalMs for live output streams.",
      "ANSI escape codes are stripped for clean rendering."
    ]
  }
];

export function getComponentIndex(): string {
  return COMPONENT_REGISTRY.map((c) => `- ${c.type}: ${c.summary}`).join("\n");
}

export function formatComponentDocs(types: string[]): string {
  return types
    .map((t) => {
      const doc = COMPONENT_REGISTRY.find((c) => c.type === t);
      if (!doc) return `## ${t}\n(unknown component type — use html as a fallback)`;
      const lines = [
        `## ${doc.type}  —  ${doc.summary}`,
        "",
        "Data schema:",
        "```",
        doc.dataSchema,
        "```",
        "",
        "Minimal example (use as the view field):",
        "```json",
        JSON.stringify(doc.example, null, 2),
        "```"
      ];
      if (doc.tips.length) {
        lines.push("", "Tips:", ...doc.tips.map((tip) => `- ${tip}`));
      }
      return lines.join("\n");
    })
    .join("\n\n---\n\n");
}
