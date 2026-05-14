import { exec } from "node:child_process";

import type { RunResult } from "./types.js";

const COMMAND_TIMEOUT_MS = 15_000;

export function runCommand(command: string, cwd: string): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = exec(
      command,
      {
        cwd,
        maxBuffer: 1024 * 1024 * 8,
        shell: "/bin/zsh",
        timeout: COMMAND_TIMEOUT_MS
      },
      (error, stdout, stderr) => {
        const timedOut = error !== null && (error as NodeJS.ErrnoException & { killed?: boolean }).killed === true;
        resolve({
          code: timedOut ? 124 : (error?.code ?? 0),
          stdout,
          stderr: timedOut
            ? `Command timed out after ${COMMAND_TIMEOUT_MS / 1000}s.\n${stderr}`
            : stderr
        });
      }
    );

    return child;
  });
}
