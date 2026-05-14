import type { DataSourceSpec, RunResult, ViewNode } from "./types.js";

export function applyResultToView(
  view: ViewNode,
  result: RunResult,
  parser: DataSourceSpec["parser"]
): void {
  if (view.type === "log" || view.type === "markdown" || view.type === "html" || view.type === "terminal") {
    const combined = [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join("\n\n");
    view.content = combined || "";
    return;
  }

  if (view.type === "stats") {
    view.items = buildStats(result);
    return;
  }

  if (view.type === "table") {
    if (parser === "process-table") {
      view.rows = parseProcessTable(result.stdout);
    } else if (parser === "git-log") {
      view.rows = parseGitLogTable(result.stdout);
    } else if (parser === "du-table") {
      view.rows = parseDuTable(result.stdout);
    } else {
      view.rows = parseGenericTable(result.stdout, view.columns);
    }
    return;
  }

  if (view.type === "bar-chart") {
    view.items = parseDuChart(result.stdout);
  }
}

export function appendChunkToView(view: ViewNode, chunk: string, stream: "stdout" | "stderr"): void {
  if (view.type !== "log" && view.type !== "terminal") return;
  const prefix = stream === "stderr" ? "" : "";
  view.content += `${prefix}${chunk}`;
}

export function resultText(result: RunResult): string {
  return [result.stdout.trimEnd(), result.stderr.trimEnd()].filter(Boolean).join("\n") || "(no output)";
}

export function parseFixedWidthTable(text: string): { columns: string[]; rows: Array<Record<string, string>> } | null {
  const lines = text.split("\n").map((line) => line.trimEnd()).filter((line) => line.trim());
  if (lines.length < 2) return null;

  const columns = splitTableLine(lines[0]);
  if (columns.length < 2) return null;

  const rows = lines.slice(1).map((line) => {
    const values = splitTableLine(line);
    const row: Record<string, string> = {};
    for (let index = 0; index < columns.length; index += 1) {
      row[columns[index]] = values[index] ?? "";
    }
    if (values.length > columns.length) {
      row[columns[columns.length - 1]] = values.slice(columns.length - 1).join(" ");
    }
    return row;
  });

  return { columns, rows };
}

export function summarizeResult(result: RunResult): string {
  const stdout = result.stdout.trim();
  const stderr = result.stderr.trim();
  const preview = [stdout, stderr].filter(Boolean).join("\n").slice(0, 240);
  return preview || "(no output)";
}

function splitTableLine(line: string): string[] {
  return line.trim().split(/\s{2,}/).map((part) => part.trim()).filter(Boolean);
}

function buildStats(result: RunResult): Array<{ label: string; value: string }> {
  const output = [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join("\n");
  const lines = output.split("\n").filter(Boolean);

  return [
    { label: "lines", value: String(lines.length) },
    { label: "exit code", value: String(result.code ?? 0) },
    { label: "bytes", value: String(output.length) }
  ];
}

function parseProcessTable(stdout: string): Array<Record<string, string>> {
  const lines = stdout.split("\n").filter(Boolean);
  const body = lines.slice(1, 13);

  return body.map((line) => {
    const parts = line.trim().split(/\s+/, 11);
    const command = parts.slice(10).join(" ");

    return {
      user: parts[0] ?? "",
      pid: parts[1] ?? "",
      cpu: parts[2] ?? "",
      mem: parts[3] ?? "",
      command
    };
  });
}

function parseGitLogTable(stdout: string): Array<Record<string, string>> {
  return stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [hash, author, date, subject] = line.split("\t");
      return {
        hash: hash ?? "",
        author: author ?? "",
        date: date ?? "",
        subject: subject ?? ""
      };
    });
}

function parseDuTable(stdout: string): Array<Record<string, string>> {
  return stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [size, ...pathParts] = line.trim().split(/\s+/);
      return {
        size: size ?? "",
        path: pathParts.join(" ")
      };
    });
}

function parseDuChart(stdout: string): Array<{ label: string; value: string; bytes: number }> {
  return stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [size, ...pathParts] = line.trim().split(/\s+/);
      const label = pathParts.join(" ").replace(/^\.\//, "");
      const value = size ?? "0";
      return { label, value, bytes: parseHumanSize(value) };
    })
    .filter((item) => item.bytes > 0);
}

function parseHumanSize(value: string): number {
  if (!value) return 0;
  const num = parseFloat(value);
  if (isNaN(num)) return 0;
  const unit = value.slice(-1).toUpperCase();
  const multipliers: Record<string, number> = { K: 1024, M: 1024 ** 2, G: 1024 ** 3, T: 1024 ** 4 };
  return multipliers[unit] ? num * multipliers[unit] : num;
}

function parseGenericTable(stdout: string, columns: string[]): Array<Record<string, string>> {
  return stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const parts = line.split(/\s+/);
      const row: Record<string, string> = {};
      for (let index = 0; index < columns.length; index += 1) {
        row[columns[index]] = parts[index] ?? "";
      }
      return row;
    });
}
