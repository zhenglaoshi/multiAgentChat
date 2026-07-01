import { spawn } from 'node:child_process';

export interface RunScriptResult {
  stdout: string;
  stderr: string;
  code: number;
}

export function runScript(script: string, args: string[] = []): Promise<RunScriptResult> {
  return new Promise((resolveP, rejectP) => {
    const proc = spawn('osascript', ['-', ...args], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d: Buffer) => (stdout += d.toString('utf8')));
    proc.stderr.on('data', (d: Buffer) => (stderr += d.toString('utf8')));
    proc.on('error', rejectP);
    proc.on('close', (code) => {
      resolveP({ stdout, stderr, code: code ?? -1 });
    });
    proc.stdin.write(script);
    proc.stdin.end();
  });
}

export async function runScriptOrThrow(
  script: string,
  args: string[] = [],
): Promise<string> {
  const r = await runScript(script, args);
  if (r.code !== 0) {
    throw new Error(`osascript exit ${r.code}: ${r.stderr || r.stdout}`);
  }
  return r.stdout;
}
