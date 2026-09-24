import { GitError, runGit } from './gitRunner';

/**
 * Operaciones Git de bajo nivel para la rama huérfana de telemetría
 * (Secciones 2 y 6.3).
 *
 * Los commits se construyen con comandos de plomería (read-tree,
 * hash-object, update-index, write-tree, commit-tree, update-ref) sobre un
 * índice privado (GIT_INDEX_FILE): nunca se modifica el working tree, el
 * index ni HEAD del estudiante, que puede seguir usando git add, git status
 * o git commit sin interferencia.
 */

const ZERO_OID = '0'.repeat(40);

export interface CommitIdentity {
  name: string;
  email: string;
}

export interface CommitFileRequest {
  ref: string;
  indexFile: string;
  pathInTree: string;
  content: string | Buffer;
  message: string;
  identity: CommitIdentity;
  /** Fecha del commit (ISO-8601); por omisión la actual. */
  date?: string;
}

export class GitPlumbing {
  constructor(public readonly repoRoot: string) {}

  private git(args: string[], opts: { input?: string | Buffer; env?: Record<string, string>; timeoutMs?: number } = {}) {
    return runGit(args, { cwd: this.repoRoot, ...opts });
  }

  /** Raíz del repositorio que contiene `dir`, o undefined si no es un repositorio. */
  public static async topLevel(dir: string): Promise<string | undefined> {
    try {
      return (await runGit(['rev-parse', '--show-toplevel'], { cwd: dir })).trim();
    } catch {
      return undefined;
    }
  }

  public async resolveRef(ref: string): Promise<string | null> {
    try {
      const out = (await this.git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])).trim();
      return out || null;
    } catch {
      return null;
    }
  }

  public headCommit(): Promise<string | null> {
    return this.resolveRef('HEAD');
  }

  /** Commit raíz (el más antiguo) de la historia de HEAD. */
  public async initialCommit(): Promise<string | null> {
    try {
      const roots = (await this.git(['rev-list', '--max-parents=0', 'HEAD'])).trim().split('\n').filter(Boolean);
      return roots.length > 0 ? roots[roots.length - 1] : null;
    } catch {
      return null;
    }
  }

  public async pathExists(ref: string, pathInTree: string): Promise<boolean> {
    try {
      await this.git(['cat-file', '-e', `${ref}:${pathInTree}`]);
      return true;
    } catch {
      return false;
    }
  }

  public async remoteExists(remote: string): Promise<boolean> {
    try {
      await this.git(['remote', 'get-url', remote]);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Agrega (o reemplaza) un archivo en la punta de `ref` creando un commit
   * nuevo. Si la rama no existe, el commit se crea sin padres (huérfano).
   * La actualización de la referencia es compare-and-swap.
   */
  public async commitFile(req: CommitFileRequest): Promise<string> {
    const env = { GIT_INDEX_FILE: req.indexFile };
    const parent = await this.resolveRef(req.ref);
    if (parent) {
      await this.git(['read-tree', parent], { env });
    } else {
      await this.git(['read-tree', '--empty'], { env });
    }
    const blob = (await this.git(['hash-object', '-w', '--stdin'], { input: req.content })).trim();
    await this.git(['update-index', '--add', '--cacheinfo', `100644,${blob},${req.pathInTree}`], { env });
    const tree = (await this.git(['write-tree'], { env })).trim();

    const date = req.date ?? new Date().toISOString();
    const identityEnv = {
      GIT_AUTHOR_NAME: req.identity.name,
      GIT_AUTHOR_EMAIL: req.identity.email,
      GIT_AUTHOR_DATE: date,
      GIT_COMMITTER_NAME: req.identity.name,
      GIT_COMMITTER_EMAIL: req.identity.email,
      GIT_COMMITTER_DATE: date,
    };
    const commitArgs = ['-c', 'commit.gpgSign=false', 'commit-tree', tree, '-m', req.message];
    if (parent) {
      commitArgs.push('-p', parent);
    }
    const commit = (await this.git(commitArgs, { env: identityEnv })).trim();
    await this.git(['update-ref', '-m', 'uatu: lote de telemetría', req.ref, commit, parent ?? ZERO_OID]);
    return commit;
  }

  /** Empuja la referencia al remoto sin forzar ni ejecutar hooks locales. */
  public async push(remote: string, ref: string, timeoutMs = 60_000): Promise<void> {
    await this.git(['push', '--no-verify', '--porcelain', remote, `${ref}:${ref}`], { timeoutMs });
  }

  public static isNonFastForward(e: unknown): boolean {
    return e instanceof GitError && /non-fast-forward|\[rejected\]|fetch first/.test(e.stderr);
  }
}
