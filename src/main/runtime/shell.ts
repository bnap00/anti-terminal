import type { RunResult } from "./types.js";
import { CommandRuntime } from "./commandRuntime.js";

const runtime = new CommandRuntime();

export function runCommand(command: string, cwd: string): Promise<RunResult> {
  return runtime.run({ command, cwd, requireApproval: false });
}
