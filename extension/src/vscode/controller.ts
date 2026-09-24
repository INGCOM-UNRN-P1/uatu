import * as crypto from 'crypto';
import * as fs from 'fs';
import * as vscode from 'vscode';
import { computeGenesisHash, EMPTY_COMMIT_SHA } from '../audit/hashChain';
import {
  MANIFEST_FILENAME,
  ManifestError,
  parseManifest,
  ParsedManifest,
  verifyManifestSignature,
} from '../config/manifest';
import { RegistryResolver, resolveTeacher, TeacherCertificate, TrustAnchor } from '../config/registry';
import { formatHourMinuteUtc, isoUtc, systemClock } from '../core/time';
import { UatuCryptoEngine } from '../crypto/cryptoEngine';
import { GitPlumbing } from '../git/gitPlumbing';
import { runGit } from '../git/gitRunner';
import { AuditSession } from '../session/auditSession';
import { KeyVault, SessionMetadata, SessionStore } from '../session/sessionStore';
import { TimeGate, TimePhase, TrustedClock } from '../session/timeGate';
import { ConsentDeclined, resolveGithubUser, showFairPlayDisclaimer } from './consent';
import { EditorMonitors } from './monitors';
import { UatuStatusBar } from './statusBar';

/**
 * Orquestador de la máquina de estados de activación (Sección 3.1):
 *
 *   ¿Existe .uatu.conf? -> ¿Firma docente válida? -> ventana temporal
 *     INACTIVO | ERROR DE INTEGRIDAD | STANDBY | ACTIVO | CONCLUIDO
 */

/** Desfase de reloj a partir del cual se registra un evento clock_skew. */
const CLOCK_SKEW_REPORT_MS = 30_000;
const REGISTRY_RETRY_MS = 60_000;

interface ExamContext {
  folder: vscode.WorkspaceFolder;
  manifestPath: string;
  repoRoot: string;
  parsed: ParsedManifest;
  teacher: TeacherCertificate;
}

interface ActiveSession {
  session: AuditSession;
  monitors: EditorMonitors;
  user: string;
  configSha256: string;
}

export interface ControllerDeps {
  context: vscode.ExtensionContext;
  anchors: TrustAnchor[];
  vault: KeyVault;
  statusBar: UatuStatusBar;
  output: vscode.OutputChannel;
}

export class UatuController implements vscode.Disposable {
  private readonly store: SessionStore;
  private readonly resolver: RegistryResolver;
  private readonly clock = new TrustedClock(systemClock);
  private clockObservedOffsetMs = 0;
  private exam: ExamContext | undefined;
  private gate: TimeGate | undefined;
  private active: ActiveSession | undefined;
  private readonly draining = new Map<string, AuditSession>();
  private drainTimer: NodeJS.Timeout | undefined;
  private retryTimer: NodeJS.Timeout | undefined;
  private starting = false;
  private evaluation: Promise<void> = Promise.resolve();
  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly deps: ControllerDeps) {
    const storage = deps.context.globalStorageUri.fsPath;
    this.store = new SessionStore(storage);
    this.resolver = new RegistryResolver(deps.anchors, `${storage}/registry-cache`);
  }

  private log(message: string): void {
    this.deps.output.appendLine(`[${new Date().toISOString()}] ${message}`);
  }

  private get extensionVersion(): string {
    return String((this.deps.context.extension.packageJSON as { version?: string }).version ?? 'desconocida');
  }

  // ---------------------------------------------------------------- ciclo de vida

  public async initialize(): Promise<void> {
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(folder, MANIFEST_FILENAME));
      let debounce: NodeJS.Timeout | undefined;
      const onEvent = () => {
        if (debounce) {
          clearTimeout(debounce);
        }
        debounce = setTimeout(() => void this.onManifestChanged(), 500);
      };
      watcher.onDidCreate(onEvent, undefined, this.disposables);
      watcher.onDidChange(onEvent, undefined, this.disposables);
      watcher.onDidDelete(onEvent, undefined, this.disposables);
      this.disposables.push(watcher);
    }
    this.disposables.push(
      vscode.workspace.onDidChangeWorkspaceFolders(() => void this.evaluate())
    );
    await this.evaluate();
    void this.recoverOrphans();
  }

  /** Reevalúa manifiesto, firma y ventana temporal (serializado). */
  public evaluate(): Promise<void> {
    this.evaluation = this.evaluation.then(() => this.doEvaluate()).catch((e) => {
      this.log(`Error inesperado evaluando el manifiesto: ${(e as Error).stack ?? e}`);
    });
    return this.evaluation;
  }

  private findManifest(): { folder: vscode.WorkspaceFolder; manifestPath: string } | undefined {
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      if (folder.uri.scheme !== 'file') {
        continue;
      }
      const manifestPath = vscode.Uri.joinPath(folder.uri, MANIFEST_FILENAME).fsPath;
      if (fs.existsSync(manifestPath)) {
        return { folder, manifestPath };
      }
    }
    return undefined;
  }

  private fail(message: string, notify = true): void {
    this.log(`ERROR: ${message}`);
    this.deps.statusBar.set({ kind: 'error', message });
    if (notify) {
      void vscode.window.showErrorMessage(`Uatu: ${message}`);
    }
  }

  private async doEvaluate(): Promise<void> {
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = undefined;
    }
    if (this.active) {
      // Con una sesión en curso solo se audita el cambio del manifiesto.
      return;
    }
    const found = this.findManifest();
    if (!found) {
      this.stopGate();
      this.exam = undefined;
      this.deps.statusBar.set({ kind: 'idle' });
      return;
    }

    let parsed: ParsedManifest;
    try {
      parsed = parseManifest(fs.readFileSync(found.manifestPath, 'utf-8'));
    } catch (e) {
      this.stopGate();
      this.fail(e instanceof ManifestError ? e.message : `No se pudo leer .uatu.conf: ${(e as Error).message}`);
      return;
    }

    if (this.deps.anchors.length === 0) {
      this.stopGate();
      this.fail('La extensión no tiene anclas raíz institucionales configuradas (resources/trust-anchors.json).');
      return;
    }

    let teacher: TeacherCertificate;
    try {
      const resolution = await this.resolver.resolve(parsed.manifest.auth.public_key_registry_url);
      if (resolution.serverDateMs !== undefined && resolution.receivedAtMs !== undefined) {
        this.clockObservedOffsetMs = this.clock.calibrate(resolution.serverDateMs, resolution.receivedAtMs);
        this.log(`Reloj calibrado contra HTTP Date: desfase observado ${this.clockObservedOffsetMs} ms.`);
      }
      if (resolution.fromCache) {
        this.log('Registro de claves obtenido desde la caché local (sin red).');
      }
      teacher = resolveTeacher(resolution.registry, parsed.manifest.crypto.teacher_key_id, this.clock.now());
    } catch (e) {
      this.stopGate();
      this.fail(`${(e as Error).message} Se reintentará en ${REGISTRY_RETRY_MS / 1000} s.`, false);
      this.retryTimer = setTimeout(() => void this.evaluate(), REGISTRY_RETRY_MS);
      return;
    }

    if (!verifyManifestSignature(parsed, teacher.verifyKeyHex)) {
      this.stopGate();
      this.fail('La firma docente de .uatu.conf es INVÁLIDA. El manifiesto fue alterado; la sesión no se activará.');
      return;
    }

    const repoRoot = await GitPlumbing.topLevel(found.folder.uri.fsPath);
    if (!repoRoot) {
      this.stopGate();
      this.fail('El workspace del examen no es un repositorio Git.');
      return;
    }

    const previous = this.exam;
    this.exam = { ...found, repoRoot, parsed, teacher };
    this.log(`Manifiesto válido: ${parsed.manifest.exam_id} (${parsed.manifest.session.start_utc} -> ${parsed.manifest.session.deadline_utc}).`);

    if (!this.gate || previous?.parsed.sha256 !== parsed.sha256) {
      this.stopGate();
      this.gate = new TimeGate(this.clock, parsed.startMs, parsed.deadlineMs, (phase, prev) =>
        this.onPhase(phase, prev)
      );
      this.gate.start();
    } else {
      this.gate.evaluate();
    }
  }

  private stopGate(): void {
    this.gate?.stop();
    this.gate = undefined;
  }

  private onPhase(phase: TimePhase, previous: TimePhase | undefined): void {
    const exam = this.exam;
    if (!exam) {
      return;
    }
    this.log(`Transición de fase: ${previous ?? 'inicio'} -> ${phase}`);
    const examId = exam.parsed.manifest.exam_id;
    switch (phase) {
      case 'STANDBY':
        this.deps.statusBar.set({ kind: 'standby', startMs: exam.parsed.startMs, examId });
        break;
      case 'ACTIVE':
        void this.startSession();
        break;
      case 'CONCLUDED':
        void this.concludeSession(previous === 'ACTIVE');
        break;
    }
  }

  // ---------------------------------------------------------------- sesión activa

  public async startSession(): Promise<void> {
    const exam = this.exam;
    if (!exam || this.active || this.starting || this.gate?.current !== 'ACTIVE') {
      return;
    }
    this.starting = true;
    try {
      const m = exam.parsed.manifest;
      let user: string;
      try {
        user = await resolveGithubUser(m.auth.require_github_auth, () => this.gitUserName(exam.repoRoot));
      } catch (e) {
        if (e instanceof ConsentDeclined) {
          this.log(e.message);
          this.deps.statusBar.set({ kind: 'declined', examId: m.exam_id });
          return;
        }
        throw e;
      }

      const accepted = await showFairPlayDisclaimer({
        user,
        examId: m.exam_id,
        startMs: exam.parsed.startMs,
        deadlineMs: exam.parsed.deadlineMs,
        branchPrefix: m.git.telemetry_branch_prefix,
        disallowedExtensions: m.monitoring.disallowed_extensions,
      });
      if (!accepted) {
        this.log('El estudiante no aceptó los términos del examen.');
        this.deps.statusBar.set({ kind: 'declined', examId: m.exam_id });
        return;
      }
      if (this.gate?.current !== 'ACTIVE' || this.exam !== exam) {
        // El modal pudo quedar abierto hasta después del deadline.
        return;
      }
      await this.openSession(exam, user);
    } catch (e) {
      this.fail(`No se pudo iniciar la sesión de auditoría: ${(e as Error).message}`);
    } finally {
      this.starting = false;
    }
  }

  private async gitUserName(repoRoot: string): Promise<string> {
    try {
      return (await runGit(['config', 'user.name'], { cwd: repoRoot })).trim() || 'anonimo';
    } catch {
      return 'anonimo';
    }
  }

  private async openSession(exam: ExamContext, user: string): Promise<void> {
    const m = exam.parsed.manifest;
    const git = new GitPlumbing(exam.repoRoot);
    const keyPair = UatuCryptoEngine.generateStudentKeyPair();
    const sessionUuid = crypto.randomUUID();
    const initialCommit = (await git.initialCommit()) ?? EMPTY_COMMIT_SHA;
    const genesis = computeGenesisHash({
      initialCommitSha: initialCommit,
      configSha256: exam.parsed.sha256,
      githubUser: user,
      studentPublicKeyHex: keyPair.publicKeyHex,
    });
    const meta: SessionMetadata = {
      format: 1,
      session_uuid: sessionUuid,
      github_user: user,
      exam_id: m.exam_id,
      repo_root: exam.repoRoot,
      remote_name: m.git.remote_name,
      ref: `refs/heads/${m.git.telemetry_branch_prefix}/${user}/${sessionUuid}`,
      auto_push: m.git.auto_push,
      max_backoff_ms: m.session.sync_max_backoff_seconds * 1000,
      student_public_key: keyPair.publicKeyHex,
      genesis_hash: genesis,
      created_at_utc: isoUtc(this.clock.now()),
    };
    this.store.create(meta);
    await this.deps.vault.store(sessionUuid, keyPair.privateKeyDer);

    const session = new AuditSession({
      store: this.store,
      meta,
      privateKeyDer: keyPair.privateKeyDer,
      batchIntervalMs: m.session.batch_interval_seconds * 1000,
      batchMaxEvents: m.session.batch_max_events,
      clock: this.clock,
      log: (msg) => this.log(msg),
      onStats: (stats) => this.deps.statusBar.updateStats(stats),
    });
    const startedMs = this.clock.now();
    session.record('session_start', {
      exam_id: m.exam_id,
      session_uuid: sessionUuid,
      github_user: user,
      initial_commit_sha: initialCommit,
      config_sha256: exam.parsed.sha256,
      teacher_key_id: m.crypto.teacher_key_id,
      extension_version: this.extensionVersion,
      vscode_version: vscode.version,
      platform: process.platform,
      clock_source: this.clock.origin,
      clock_offset_ms: this.clockObservedOffsetMs,
    });
    if (Math.abs(this.clockObservedOffsetMs) >= CLOCK_SKEW_REPORT_MS) {
      session.record('clock_skew', { offset_ms: this.clockObservedOffsetMs, source: this.clock.origin });
    }

    const monitors = new EditorMonitors({
      manifest: m,
      repoRoot: exam.repoRoot,
      teacherEncryptionKey: exam.teacher.encryptionKey,
      clock: this.clock,
      sessionStartedMs: startedMs,
      record: (type, data) => {
        try {
          session.record(type, data);
        } catch (e) {
          this.log(`No se pudo registrar ${type}: ${(e as Error).message}`);
        }
      },
      flush: (reason) => void session.flush(reason),
      log: (msg) => this.log(msg),
    });
    this.active = { session, monitors, user, configSha256: exam.parsed.sha256 };
    this.deps.statusBar.set({ kind: 'active', user, examId: m.exam_id, deadlineMs: exam.parsed.deadlineMs, stats: session.stats });
    this.log(`Sesión ${sessionUuid} iniciada para @${user} en ${meta.ref}.`);
  }

  private async closeActive(reason: string, waitMs: number): Promise<AuditSession | undefined> {
    const active = this.active;
    if (!active) {
      return undefined;
    }
    this.active = undefined;
    await active.monitors.stop();
    await active.session.close(reason, {}, waitMs);
    // La sesión ya está cerrada y todos sus eventos firmados: la clave no se necesita más.
    await this.deps.vault.delete(active.session.metadata.session_uuid);
    return active.session;
  }

  private async concludeSession(wasActive: boolean): Promise<void> {
    const exam = this.exam;
    const examId = exam?.parsed.manifest.exam_id ?? '';
    const session = await this.closeActive('deadline', 15_000);
    if (session) {
      this.drain(session);
    }
    this.deps.statusBar.set({ kind: 'concluded', examId, pendingBatches: session?.stats.sync.pendingBatches ?? 0 });
    if (wasActive || session) {
      void vscode.window.showInformationMessage(
        `Uatu: el examen ${examId} concluyó a las ${formatHourMinuteUtc(new Date(exam?.parsed.deadlineMs ?? 0))} UTC. ` +
          'La supervisión se detuvo y se realizó el volcado final de la telemetría.'
      );
    }
  }

  /** Cambios en .uatu.conf: durante una sesión activa se registran como evento prioritario. */
  private async onManifestChanged(): Promise<void> {
    const active = this.active;
    const exam = this.exam;
    if (!active || !exam) {
      await this.evaluate();
      return;
    }
    const data: Record<string, string | boolean> = {};
    if (!fs.existsSync(exam.manifestPath)) {
      data.deleted = true;
    } else {
      try {
        const parsed = parseManifest(fs.readFileSync(exam.manifestPath, 'utf-8'));
        if (parsed.sha256 === active.configSha256) {
          return;
        }
        data.config_sha256 = parsed.sha256;
        data.signature_valid = verifyManifestSignature(parsed, exam.teacher.verifyKeyHex);
      } catch (e) {
        data.parse_error = (e as Error).message;
      }
    }
    active.session.record('config_changed', data);
    this.log(`El manifiesto cambió durante la sesión: ${JSON.stringify(data)}`);
    void vscode.window.showWarningMessage(
      'Uatu: se detectó una modificación de .uatu.conf durante el examen. El cambio quedó registrado y no altera la sesión en curso.'
    );
  }

  // ---------------------------------------------------------------- recuperación

  /** Recupera sesiones de ejecuciones anteriores que quedaron sin sincronizar. */
  private async recoverOrphans(): Promise<void> {
    if (!fs.existsSync(this.store.sessionsDir)) {
      return;
    }
    const roots = new Set<string>();
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      if (folder.uri.scheme === 'file') {
        const root = await GitPlumbing.topLevel(folder.uri.fsPath);
        if (root) {
          roots.add(root);
        }
      }
    }
    for (const root of roots) {
      for (const meta of this.store.findOrphans(root)) {
        if (meta.session_uuid === this.active?.session.metadata.session_uuid || this.draining.has(meta.session_uuid)) {
          continue;
        }
        if (!this.store.claim(meta.session_uuid)) {
          continue;
        }
        try {
          const key = await this.deps.vault.get(meta.session_uuid);
          const session = new AuditSession({
            store: this.store,
            meta,
            privateKeyDer: key,
            batchIntervalMs: 30_000,
            batchMaxEvents: 1_000,
            clock: this.clock,
            log: (msg) => this.log(`[recuperación ${meta.session_uuid.slice(0, 8)}] ${msg}`),
          });
          if (session.closedReason === undefined) {
            await session.close(key ? 'recovered' : 'recovered_without_key', {}, 10_000);
          }
          await this.deps.vault.delete(meta.session_uuid);
          this.log(`Sesión huérfana ${meta.session_uuid} recuperada.`);
          this.drain(session);
        } catch (e) {
          this.log(`No se pudo recuperar la sesión ${meta.session_uuid}: ${(e as Error).message}`);
          this.store.release(meta.session_uuid);
        }
      }
    }
  }

  /** Mantiene viva una sesión cerrada hasta que todos sus lotes estén sincronizados. */
  private drain(session: AuditSession): void {
    if (session.isFullySynced) {
      session.dispose();
      return;
    }
    this.draining.set(session.metadata.session_uuid, session);
    if (!this.drainTimer) {
      this.drainTimer = setInterval(() => {
        for (const [id, s] of this.draining) {
          if (s.isFullySynced) {
            s.dispose();
            this.draining.delete(id);
            this.log(`Sesión ${id} completamente sincronizada.`);
          }
        }
        const view = this.deps.statusBar.current;
        if (view.kind === 'concluded') {
          const pending = [...this.draining.values()].reduce((acc, s) => acc + s.stats.sync.pendingBatches, 0);
          this.deps.statusBar.set({ ...view, pendingBatches: pending });
        }
        if (this.draining.size === 0 && this.drainTimer) {
          clearInterval(this.drainTimer);
          this.drainTimer = undefined;
        }
      }, 5_000);
    }
  }

  // ---------------------------------------------------------------- comandos

  public async flushNow(): Promise<void> {
    const tasks: Promise<unknown>[] = [];
    if (this.active) {
      tasks.push(this.active.session.flush('manual'));
    }
    for (const s of this.draining.values()) {
      tasks.push(s.flush('manual'));
    }
    await Promise.all(tasks);
    void vscode.window.showInformationMessage('Uatu: sincronización solicitada.');
  }

  public async retry(): Promise<void> {
    if (this.gate?.current === 'ACTIVE' && !this.active) {
      await this.startSession();
    } else {
      await this.evaluate();
    }
  }

  public describe(): string {
    const lines: string[] = [];
    const exam = this.exam;
    if (!exam) {
      lines.push('Sin manifiesto .uatu.conf válido en el workspace.');
    } else {
      const m = exam.parsed.manifest;
      lines.push(
        `Examen: ${m.exam_id}`,
        `Ventana: ${m.session.start_utc} -> ${m.session.deadline_utc}`,
        `Fase: ${this.gate?.current ?? 'sin evaluar'}`,
        `Reloj: ${this.clock.origin} (desfase observado ${this.clockObservedOffsetMs} ms)`
      );
    }
    if (this.active) {
      const s = this.active.session.stats;
      const meta = this.active.session.metadata;
      lines.push(
        `Usuario: @${this.active.user}`,
        `Sesión: ${meta.session_uuid}`,
        `Rama: ${meta.ref}`,
        `Eventos: ${s.events} (pendientes de lote: ${s.pendingEvents})`,
        `Lotes: ${s.batches} (sin sincronizar: ${s.sync.pendingBatches})`
      );
      if (s.sync.lastError) {
        lines.push(`Última falla de sincronización: ${s.sync.lastError}`);
      }
    }
    if (this.draining.size > 0) {
      lines.push(`Sesiones cerradas pendientes de sincronizar: ${this.draining.size}`);
    }
    return lines.join('\n');
  }

  /** Cierre del IDE: volcado final forzado con tiempo acotado. */
  public async shutdown(): Promise<void> {
    this.stopGate();
    const session = await this.closeActive('shutdown', 4_000);
    session?.dispose();
    for (const s of this.draining.values()) {
      s.dispose();
    }
    this.draining.clear();
  }

  public dispose(): void {
    this.stopGate();
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
    }
    if (this.drainTimer) {
      clearInterval(this.drainTimer);
    }
    this.disposables.forEach((d) => d.dispose());
  }
}
