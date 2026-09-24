import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { readJsonIfExists, writeFileAtomicSync } from '../storage/fsUtil';

/**
 * Almacén de sesiones en ${globalStorageUri}/sessions/<session_uuid>/.
 *
 *   session.json   metadatos inmutables de la sesión
 *   owner.lock     proceso (extension host) que la está operando
 *   events.wal     write-ahead log
 *   batches/       lotes empaquetados
 *   git-index      índice privado para la plomería Git
 *
 * El lock de propiedad permite que varias ventanas de VS Code convivan:
 * cada una opera su propia sesión y solo recupera sesiones cuyo proceso
 * dueño ya no existe (cierre abrupto del IDE o del equipo).
 */

export interface SessionMetadata {
  format: 1;
  session_uuid: string;
  github_user: string;
  exam_id: string;
  repo_root: string;
  remote_name: string;
  /** Referencia completa: refs/heads/<prefix>/<user>/<uuid>. */
  ref: string;
  auto_push: boolean;
  max_backoff_ms: number;
  student_public_key: string;
  genesis_hash: string;
  created_at_utc: string;
}

interface OwnerLock {
  pid: number;
  hostname: string;
  claimed_at_utc: string;
}

export interface KeyVault {
  get(sessionUuid: string): Promise<Buffer | undefined>;
  store(sessionUuid: string, privateKeyDer: Buffer): Promise<void>;
  delete(sessionUuid: string): Promise<void>;
}

/** Bóveda en memoria (pruebas). */
export class MemoryKeyVault implements KeyVault {
  private readonly keys = new Map<string, Buffer>();
  async get(id: string) {
    return this.keys.get(id);
  }
  async store(id: string, der: Buffer) {
    this.keys.set(id, Buffer.from(der));
  }
  async delete(id: string) {
    this.keys.delete(id);
  }
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export class SessionStore {
  public readonly sessionsDir: string;

  constructor(
    storageRoot: string,
    private readonly pid: number = process.pid,
    private readonly hostname: string = os.hostname(),
    private readonly alive: (pid: number) => boolean = isProcessAlive
  ) {
    this.sessionsDir = path.join(storageRoot, 'sessions');
  }

  public dir(sessionUuid: string): string {
    return path.join(this.sessionsDir, sessionUuid);
  }

  /** Registra una sesión nueva y la reclama para este proceso. */
  public create(meta: SessionMetadata): string {
    const dir = this.dir(meta.session_uuid);
    fs.mkdirSync(dir, { recursive: true });
    writeFileAtomicSync(path.join(dir, 'session.json'), JSON.stringify(meta, null, 2));
    if (!this.claim(meta.session_uuid)) {
      throw new Error(`No se pudo reclamar la sesión ${meta.session_uuid}.`);
    }
    return dir;
  }

  public read(sessionUuid: string): SessionMetadata | undefined {
    return readJsonIfExists<SessionMetadata>(path.join(this.dir(sessionUuid), 'session.json'));
  }

  private lockPath(sessionUuid: string): string {
    return path.join(this.dir(sessionUuid), 'owner.lock');
  }

  private ownerIsAlive(lock: OwnerLock): boolean {
    if (lock.hostname !== this.hostname) {
      // No es posible verificar procesos de otro equipo: se respeta el lock.
      return true;
    }
    return lock.pid === this.pid || this.alive(lock.pid);
  }

  /**
   * Intenta reclamar la sesión con creación exclusiva del lock. Si el lock
   * pertenece a un proceso muerto, lo roba.
   */
  public claim(sessionUuid: string): boolean {
    const lockFile = this.lockPath(sessionUuid);
    const mine: OwnerLock = { pid: this.pid, hostname: this.hostname, claimed_at_utc: new Date().toISOString() };
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const fd = fs.openSync(lockFile, 'wx');
        fs.writeSync(fd, JSON.stringify(mine));
        fs.closeSync(fd);
        return true;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') {
          throw e;
        }
      }
      let current: OwnerLock | undefined;
      try {
        current = readJsonIfExists<OwnerLock>(lockFile);
      } catch {
        current = undefined; // lock ilegible: se considera abandonado
      }
      if (current && current.pid === this.pid && current.hostname === this.hostname) {
        return true;
      }
      if (current && this.ownerIsAlive(current)) {
        return false;
      }
      fs.rmSync(lockFile, { force: true });
    }
    return false;
  }

  public release(sessionUuid: string): void {
    const lockFile = this.lockPath(sessionUuid);
    const current = readJsonIfExists<OwnerLock>(lockFile);
    if (current && current.pid === this.pid && current.hostname === this.hostname) {
      fs.rmSync(lockFile, { force: true });
    }
  }

  /** Sesiones del repositorio indicado que no tienen un proceso dueño vivo. */
  public findOrphans(repoRoot: string): SessionMetadata[] {
    let entries: string[];
    try {
      entries = fs.readdirSync(this.sessionsDir);
    } catch {
      return [];
    }
    const result: SessionMetadata[] = [];
    for (const id of entries) {
      let meta: SessionMetadata | undefined;
      try {
        meta = this.read(id);
      } catch {
        continue;
      }
      if (!meta || path.resolve(meta.repo_root) !== path.resolve(repoRoot)) {
        continue;
      }
      let lock: OwnerLock | undefined;
      try {
        lock = readJsonIfExists<OwnerLock>(this.lockPath(id));
      } catch {
        lock = undefined;
      }
      if (lock && this.ownerIsAlive(lock) && lock.pid !== this.pid) {
        continue;
      }
      result.push(meta);
    }
    return result;
  }
}
