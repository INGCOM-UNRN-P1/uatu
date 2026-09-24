import { spawn } from 'child_process';

export class GitError extends Error {
  constructor(
    message: string,
    public readonly args: string[],
    public readonly exitCode: number | null,
    public readonly stderr: string
  ) {
    super(message);
  }
}

export interface GitRunOptions {
  cwd: string;
  input?: string | Buffer;
  env?: Record<string, string>;
  timeoutMs?: number;
}

/**
 * Ejecuta git sin shell ni interacción: sin prompts de credenciales
 * (GIT_TERMINAL_PROMPT=0) y con mensajes en inglés estable (LC_ALL=C)
 * para poder interpretar errores.
 */
export function runGit(args: string[], opts: GitRunOptions): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, {
      cwd: opts.cwd,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C', ...opts.env },
      stdio: [opts.input !== undefined ? 'pipe' : 'ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let timedOut = false;
    const timer =
      opts.timeoutMs !== undefined
        ? setTimeout(() => {
            timedOut = true;
            child.kill('SIGKILL');
          }, opts.timeoutMs)
        : undefined;
    child.stdout!.on('data', (d: Buffer) => out.push(d));
    child.stderr!.on('data', (d: Buffer) => err.push(d));
    child.on('error', (e) => {
      if (timer) {
        clearTimeout(timer);
      }
      reject(new GitError(`No se pudo ejecutar git: ${e.message}`, args, null, ''));
    });
    child.on('close', (code) => {
      if (timer) {
        clearTimeout(timer);
      }
      const stderr = Buffer.concat(err).toString('utf-8').trim();
      if (timedOut) {
        reject(new GitError(`git ${args[0]} excedió el tiempo límite`, args, code, stderr));
      } else if (code !== 0) {
        reject(new GitError(`git ${args[0]} falló (código ${code}): ${stderr}`, args, code, stderr));
      } else {
        resolve(Buffer.concat(out).toString('utf-8'));
      }
    });
    if (child.stdin) {
      // git puede terminar antes de consumir stdin; EPIPE no es un error relevante.
      child.stdin.on('error', () => undefined);
      child.stdin.end(opts.input);
    }
  });
}
