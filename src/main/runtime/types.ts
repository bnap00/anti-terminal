export type RuntimeMode = "one-shot" | "streaming" | "interactive";
export type CommandRisk = "read" | "write" | "destructive" | "network/install" | "unknown";
export type CommandStatus = "pending-approval" | "running" | "completed" | "failed" | "denied" | "stopped" | "timed-out";

export interface FileTreeNode {
  name: string;
  type: "file" | "dir";
  children?: FileTreeNode[];
}

export type ViewNode =
  | { id: string; type: "markdown"; title?: string; content: string }
  | { id: string; type: "html"; title?: string; content: string }
  | { id: string; type: "log"; title?: string; content: string }
  | { id: string; type: "terminal"; title?: string; content: string }
  | {
      id: string;
      type: "approval";
      title?: string;
      data: {
        commandId: string;
        command: string;
        risk: CommandRisk;
        reason: string;
        status: CommandStatus;
      };
    }
  | { id: string; type: "code"; title?: string; lang?: string; content: string }
  | { id: string; type: "diff"; title?: string; content: string }
  | { id: string; type: "json-tree"; title?: string; content: string }
  | { id: string; type: "stats"; title?: string; items: Array<{ label: string; value: string }> }
  | { id: string; type: "table"; title?: string; columns: string[]; rows: Array<Record<string, string>> }
  | { id: string; type: "bar-chart"; title?: string; items: Array<{ label: string; value: string; bytes: number }> }
  | { id: string; type: "actions"; title?: string; actions: ActionSpec[] }
  | {
      id: string; type: "line-chart"; title?: string;
      data: {
        points?: Array<{ x: string; y: number }>;
        series?: Array<{ name: string; points: Array<{ x: string; y: number }> }>;
        xLabel?: string;
        yLabel?: string;
      };
    }
  | {
      id: string; type: "pie-chart"; title?: string;
      data: { items: Array<{ label: string; value: number; color?: string }>; donut?: boolean };
    }
  | {
      id: string; type: "gauge"; title?: string;
      data: { value: number; min: number; max: number; unit?: string; label?: string };
    }
  | {
      id: string; type: "timeline"; title?: string;
      data: {
        events: Array<{
          time: string; label: string; detail?: string;
          status?: "info" | "success" | "warn" | "error";
        }>;
      };
    }
  | {
      id: string; type: "form"; title?: string;
      data: {
        fields: Array<{
          name: string; label: string;
          type: "text" | "number" | "select" | "checkbox" | "textarea";
          placeholder?: string; options?: string[]; defaultValue?: string; required?: boolean;
        }>;
        submitCommand: string;
        submitLabel?: string;
      };
    }
  | {
      id: string; type: "progress"; title?: string;
      data: {
        steps?: Array<{ label: string; status: "done" | "active" | "pending" | "error"; detail?: string }>;
        value?: number; max?: number; label?: string;
      };
    }
  | {
      id: string; type: "alert"; title?: string;
      data: { message: string; level: "info" | "success" | "warn" | "error"; detail?: string };
    }
  | { id: string; type: "image"; title?: string; data: { src: string; alt?: string; caption?: string } }
  | {
      id: string; type: "kanban"; title?: string;
      data: {
        columns: Array<{
          label: string; color?: string;
          cards: Array<{ id: string; title: string; body?: string; tags?: string[] }>;
        }>;
      };
    }
  | { id: string; type: "file-tree"; title?: string; data: { nodes: FileTreeNode[] } }
  | {
      id: string; type: "metric"; title?: string;
      data: { value: string; label: string; change?: string; trend?: "up" | "down" | "neutral"; subtext?: string };
    }
  | {
      id: string; type: "card-grid"; title?: string;
      data: { cards: Array<{ title: string; body?: string; footer?: string; accent?: string; tags?: string[] }> };
    }
  | {
      id: string; type: "heatmap"; title?: string;
      data: { rows: string[]; cols: string[]; values: number[][]; colorScale?: "blue" | "green" | "red" };
    };

export interface ActionSpec {
  id: string;
  label: string;
  command: string;
  targetViewId?: string;
  description?: string;
}

export interface ActionInvocation {
  sessionId: string;
  action: ActionSpec;
}

export interface DataSourceSpec {
  id: string;
  command: string;
  intervalMs?: number;
  parser: "raw" | "git-log" | "process-table" | "du-table" | "du-chart";
  targetViewId: string;
}

export interface TaskPlan {
  title: string;
  mode: RuntimeMode;
  summary: string;
  views: ViewNode[];
  dataSources: DataSourceSpec[];
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  at: number;
  viewIds?: string[];
}

export interface DebugLogEntry {
  id: string;
  at: number;
  level: "info" | "warn" | "error";
  scope: string;
  sessionId?: string;
  message: string;
  detail?: string;
}

export interface RunResult {
  commandId?: string;
  status?: CommandStatus;
  startedAt?: number;
  endedAt?: number;
  stdout: string;
  stderr: string;
  code: number | null;
  signal?: string | null;
  risk?: CommandRisk;
  approvedByUser?: boolean;
}

export interface CommandExecution extends RunResult {
  commandId: string;
  sessionId?: string;
  viewId?: string;
  command: string;
  cwd: string;
  status: CommandStatus;
  startedAt: number;
  endedAt?: number;
  code: number | null;
  signal: string | null;
  risk: CommandRisk;
  riskReason: string;
  approvedByUser: boolean;
  parser?: DataSourceSpec["parser"];
}

export interface TaskSession {
  id: string;
  prompt: string;
  title: string;
  mode: RuntimeMode;
  summary: string;
  plannerSource: string;
  status: "running" | "idle" | "stopped" | "error" | "completed";
  createdAt: number;
  messages: ChatMessage[];
  views: ViewNode[];
  liveViewIds: string[];
  dataSources: DataSourceSpec[];
  commands?: CommandExecution[];
  eventLog: Array<{ at: number; message: string }>;
  tokenUsage?: { input: number; output: number };
  busyHint?: string;
}

export interface SessionSnapshot {
  sessions: TaskSession[];
}
