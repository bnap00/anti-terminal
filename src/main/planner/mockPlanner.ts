import type { TaskPlan } from "../runtime/types.js";

export function createPlan(prompt: string): TaskPlan {
  const value = prompt.toLowerCase();

  if (
    value.includes("monitor") ||
    value.includes("watch") ||
    value.includes("htop") ||
    value.includes("cpu") ||
    value.includes("process")
  ) {
    return {
      title: "Live Process Monitor",
      mode: "streaming",
      summary: "Polling process information and rendering it as a live table.",
      views: [
        {
          id: "processes",
          type: "table",
          title: "Processes",
          columns: ["user", "pid", "cpu", "mem", "command"],
          rows: []
        },
        {
          id: "summary",
          type: "stats",
          title: "Stream Stats",
          items: []
        }
      ],
      dataSources: [
        {
          id: "process-source",
          command: "ps aux | sort -nrk 3 | head -n 12",
          intervalMs: 2000,
          parser: "process-table",
          targetViewId: "processes"
        },
        {
          id: "process-summary",
          command: "ps aux | wc -l",
          intervalMs: 2000,
          parser: "raw",
          targetViewId: "summary"
        }
      ]
    };
  }

  if (
    value.includes("interactive") ||
    value.includes("dashboard") ||
    value.includes("explore") ||
    value.includes("inspect repo")
  ) {
    return {
      title: "Repository Control Panel",
      mode: "interactive",
      summary: "A schema-driven view with buttons that trigger follow-up shell commands.",
      views: [
        {
          id: "intro",
          type: "markdown",
          title: "Overview",
          content:
            "This interactive session loads repository context and exposes action buttons for follow-up inspection."
        },
        {
          id: "repo-status",
          type: "log",
          title: "Repository Status",
          content: "Loading..."
        },
        {
          id: "details",
          type: "log",
          title: "Details",
          content: "Choose an action to inspect more data."
        },
        {
          id: "actions",
          type: "actions",
          title: "Actions",
          actions: [
            {
              id: "git-status",
              label: "Git Status",
              command: "git status --short --branch",
              targetViewId: "details",
              description: "Refresh repo status details."
            },
            {
              id: "recent-commits",
              label: "Recent Commits",
              command: "git log --pretty=format:'%h %ad %s' --date=short -n 5",
              targetViewId: "details",
              description: "Show the latest commits."
            },
            {
              id: "top-files",
              label: "Largest Files",
              command: "find . -type f -maxdepth 3 -exec du -h {} + 2>/dev/null | sort -hr | head -n 10",
              targetViewId: "details",
              description: "Inspect large files near the workspace root."
            }
          ]
        }
      ],
      dataSources: [
        {
          id: "repo-status-source",
          command: "git status --short --branch",
          parser: "raw",
          targetViewId: "repo-status"
        }
      ]
    };
  }

  if (
    value.includes("largest") ||
    value.includes("disk") ||
    value.includes("files") ||
    value.includes("graph") ||
    value.includes("chart") ||
    value.includes("size")
  ) {
    return {
      title: "File Size Chart",
      mode: "one-shot",
      summary: "Finding large files and rendering them as a proportional bar chart.",
      views: [
        {
          id: "largest-files",
          type: "bar-chart",
          title: "File Sizes",
          items: []
        }
      ],
      dataSources: [
        {
          id: "largest-files-source",
          command: "find . -type f -maxdepth 3 -exec du -h {} + 2>/dev/null | sort -hr | head -n 15",
          parser: "du-chart",
          targetViewId: "largest-files"
        }
      ]
    };
  }

  return {
    title: "Git Activity Summary",
    mode: "one-shot",
    summary: "Collecting recent git activity as a structured table.",
    views: [
      {
        id: "git-log",
        type: "table",
        title: "Recent Activity",
        columns: ["hash", "author", "date", "subject"],
        rows: []
      }
    ],
    dataSources: [
      {
        id: "git-log-source",
        command: "git log --pretty=format:'%h%x09%an%x09%ad%x09%s' --date=short -n 8",
        parser: "git-log",
        targetViewId: "git-log"
      }
    ]
  };
}
