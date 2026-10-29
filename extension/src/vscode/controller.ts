import { execFile } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
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
import { consignaTreeHash } from '../core/consigna';
import { checkEnvironment, EnvCheck, SignatureState, ToolState } from '../checks/checkEnv';
import { GitPlumbing } from '../git/gitPlumbing';
import { runGit } from '../git/gitRunner';
import { AuditSession } from '../session/auditSession';
import { KeyVault, SessionMetadata, SessionStore } from '../session/sessionStore';
import { TimeGate, TimePhase, TrustedClock } from '../session/timeGate';
import { ConsentDeclined, resolveGithubUser, showFairPlayDisclaimer } from './consent';
import { EditorMonitors } from './monitors';
import { StatusView, UatuStatusBar } from './statusBar';
import { UatuSnapshot } from '../views/model';

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
  /** Última sesión abierta en esta ventana: su bitácora sigue visible al concluir. */
  private lastSession: AuditSession | undefined;
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  /** Se dispara ante cualquier cambio visible (estado, eventos, sincronización). */
  public readonly onDidChange = this.changeEmitter.event;
  private drainTimer: NodeJS.Timeout | undefined;
  private retryTimer: NodeJS.Timeout | undefined;
  private consignaTimer: NodeJS.Timeout | undefined;
  private starting = false;
  private evaluation: Promise<void> = Promise.resolve();
  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly deps: ControllerDeps) {
    const storage = deps.context.globalStorageUri.fsPath;
    this.store = new SessionStore(storage);
    this.resolver = new RegistryResolver(deps.anchors, `${storage}/registry-cache`);
  }

  private setView(view: StatusView): void {
    this.deps.statusBar.set(view);
    this.changeEmitter.fire();
  }

  /** Instantánea del estado para el panel lateral. */
  public snapshot(): UatuSnapshot {
    const view = this.deps.statusBar.current;
    const exam = this.exam;
    const session = this.active?.session ?? this.lastSession;
    const snap: UatuSnapshot = {
      nowMs: this.clock.now(),
      phase: view.kind,
      message: view.kind === 'error' ? view.message : undefined,
      clock: { source: this.clock.origin, offsetMs: this.clockObservedOffsetMs },
      events: [],
      batches: [],
    };
    if (exam) {
      const m = exam.parsed.manifest;
      snap.exam = {
        examId: m.exam_id,
        startMs: exam.parsed.startMs,
        deadlineMs: exam.parsed.deadlineMs,
        teacherKeyId: m.crypto.teacher_key_id,
        registryUrl: m.auth.public_key_registry_url,
        manifestPath: exam.manifestPath,
        clipboard: {
          enabled: m.monitoring.clipboard.enabled,
          threshold: m.monitoring.clipboard.character_threshold,
          encrypt: m.monitoring.clipboard.encrypt_content,
        },
        windowFocus: m.monitoring.window_focus,
        disallowedExtensions: m.monitoring.disallowed_extensions,
        allowedExtensions: m.monitoring.allowed_extensions,
        settingRules: m.monitoring.setting_rules.map((r) => ({ key: r.key, note: r.note })),
        heartbeatSeconds: m.session.heartbeat_interval_seconds,
        batchIntervalSeconds: m.session.batch_interval_seconds,
        batchMaxEvents: m.session.batch_max_events,
        autoPush: m.git.auto_push,
        remote: m.git.remote_name,
        branchPrefix: m.git.telemetry_branch_prefix,
      };
    }
    if (session) {
      const meta = session.metadata;
      snap.session = {
        uuid: meta.session_uuid,
        user: meta.github_user,
        ref: meta.ref,
        studentPublicKey: meta.student_public_key,
        genesisHash: meta.genesis_hash,
        createdMs: Date.parse(meta.created_at_utc),
        directory: session.sessionDir,
        closedReason: session.closedReason,
        stats: session.stats,
      };
      const batches = session.batches();
      snap.batches = batches;
      snap.events = session.events().map((event) => {
        const batch = batches.find((b) => event.sequence_id >= b.first_seq && event.sequence_id <= b.last_seq);
        return { event, state: session.eventState(event.sequence_id), batch: batch?.batch_sequence_id };
      });
    }
    if (this.active) {
      snap.monitors = this.active.monitors.snapshot();
    }
    return snap;
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
    this.setView({ kind: 'error', message });
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
      this.setView({ kind: 'idle' });
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
        this.setView({ kind: 'standby', startMs: exam.parsed.startMs, examId });
        break;
      case 'ACTIVE':
        void this.startSession();
        break;
      case 'CONCLUDED':
        void this.concludeSession(previous === 'ACTIVE');
        break;
    }
  }

  // ---------------------------------------------------------------- check-env

  /**
   * Verificación local del entorno (check-env): no inicia la sesión, no registra
   * eventos y no envía datos. Reusa la evaluación del manifiesto si ya está hecha.
   */
  public async checkEnvironment(): Promise<EnvCheck[]> {
    await this.evaluation;
    const found = this.findManifest();
    let manifest: ParsedManifest | undefined;
    let manifestError: string | undefined;
    if (found) {
      try {
        manifest = parseManifest(fs.readFileSync(found.manifestPath, 'utf-8'));
      } catch (e) {
        manifestError = e instanceof ManifestError ? e.message : `No se pudo leer .uatu.conf: ${(e as Error).message}`;
      }
    }

    let signature: SignatureState | undefined;
    if (manifest) {
      if (this.exam && this.exam.parsed.sha256 === manifest.sha256) {
        signature = { kind: 'valid' };
      } else if (this.deps.anchors.length === 0) {
        signature = { kind: 'unverified', reason: 'la extensión no tiene anclas raíz institucionales.' };
      } else {
        try {
          const resolution = await this.resolver.resolve(manifest.manifest.auth.public_key_registry_url);
          const teacher = resolveTeacher(resolution.registry, manifest.manifest.crypto.teacher_key_id, this.clock.now());
          signature = verifyManifestSignature(manifest, teacher.verifyKeyHex) ? { kind: 'valid' } : { kind: 'invalid' };
        } catch (e) {
          signature = { kind: 'unverified', reason: (e as Error).message };
        }
      }
    }

    const cwd = found?.folder.uri.fsPath ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const git = await this.gitState(cwd, manifest?.manifest.git.remote_name ?? 'origin');
    const tools = await Promise.all(
      (manifest?.manifest.environment.required_tools ?? []).map((name) => probarHerramienta(name))
    );
    const config = vscode.workspace.getConfiguration();
    return checkEnvironment({
      manifest,
      manifestError,
      signature,
      nowMs: this.clock.now(),
      clockOffsetMs: this.clock.origin === 'http-date' ? this.clockObservedOffsetMs : undefined,
      extensions: vscode.extensions.all.map((x) => ({
        id: x.id,
        version: String((x.packageJSON as { version?: string })?.version ?? ''),
        isActive: x.isActive,
        builtin: (x.packageJSON as { isBuiltin?: boolean })?.isBuiltin === true,
      })),
      ownExtensionId: this.deps.context.extension.id,
      readSetting: (key) => config.get(key),
      workspaceTrusted: vscode.workspace.isTrusted,
      git,
      tools,
    });
  }

  private async gitState(cwd: string | undefined, remote: string) {
    let version: string;
    try {
      version = (await runGit(['--version'], { cwd: cwd ?? process.cwd(), timeoutMs: 5000 })).trim();
    } catch {
      return { available: false };
    }
    const repoRoot = cwd ? await GitPlumbing.topLevel(cwd) : undefined;
    if (!repoRoot) {
      return { available: true, version };
    }
    const leer = async (args: string[]) => {
      try {
        return (await runGit(args, { cwd: repoRoot, timeoutMs: 5000 })).trim() || undefined;
      } catch {
        return undefined;
      }
    };
    return {
      available: true,
      version,
      repoRoot,
      remoteUrl: await leer(['remote', 'get-url', remote]),
      userName: await leer(['config', 'user.name']),
    };
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
          this.setView({ kind: 'declined', examId: m.exam_id });
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
        allowedExtensions: m.monitoring.allowed_extensions,
        settingRules: m.monitoring.setting_rules.map((r) => ({ key: r.key, note: r.note })),
      });
      if (!accepted) {
        this.log('El estudiante no aceptó los términos del examen.');
        this.setView({ kind: 'declined', examId: m.exam_id });
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
      onStats: (stats) => {
        this.deps.statusBar.updateStats(stats);
        this.changeEmitter.fire();
      },
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
    this.lastSession = session;
    this.setView({ kind: 'active', user, examId: m.exam_id, deadlineMs: exam.parsed.deadlineMs, stats: session.stats });
    this.log(`Sesión ${sessionUuid} iniciada para @${user} en ${meta.ref}.`);
    if (m.consigna) {
      void this.verificarConsigna(exam, session, 1);
    }
  }

  /** Intervalo entre intentos de traer la consigna (la liberación puede demorar unos minutos). */
  public static readonly CONSIGNA_RETRY_MS = 20_000;
  public static readonly CONSIGNA_MAX_INTENTOS = 30;

  /**
   * Trae la consigna liberada (`git pull --ff-only`) y verifica su hash contra
   * el del manifiesto firmado; registra `consigna_verificada`. Si todavía no
   * llegó, reintenta (hasta CONSIGNA_MAX_INTENTOS).
   */
  private async verificarConsigna(exam: ExamContext, session: AuditSession, intento: number): Promise<void> {
    const settings = exam.parsed.manifest.consigna;
    if (!settings || this.active?.session !== session) {
      return;
    }
    const dir = path.join(exam.repoRoot, settings.carpeta);
    let obtenido = consignaTreeHash(dir);
    if (obtenido === undefined) {
      try {
        // Rama explícita: sin upstream configurado, `git pull <remoto>` se niega a elegirla.
        const rama = (await runGit(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: exam.repoRoot })).trim();
        await runGit(['pull', '--ff-only', '--quiet', exam.parsed.manifest.git.remote_name, rama], {
          cwd: exam.repoRoot,
          timeoutMs: 60_000,
        });
      } catch (e) {
        this.log(`No se pudo traer la consigna (intento ${intento}): ${(e as Error).message}`);
      }
      obtenido = consignaTreeHash(dir);
    }
    if (obtenido === undefined) {
      if (intento >= UatuController.CONSIGNA_MAX_INTENTOS) {
        void vscode.window.showWarningMessage(
          `Uatu: la consigna todavía no llegó a ${settings.carpeta}/. Hacé git pull o avisale al docente.`
        );
        return;
      }
      this.consignaTimer = setTimeout(() => void this.verificarConsigna(exam, session, intento + 1), UatuController.CONSIGNA_RETRY_MS);
      this.consignaTimer.unref?.();
      return;
    }
    const coincide = obtenido === settings.sha256;
    try {
      session.record('consigna_verificada', {
        carpeta: settings.carpeta,
        sha256_esperado: settings.sha256,
        sha256_obtenido: obtenido,
        coincide,
        intentos: intento,
      });
    } catch (e) {
      this.log(`No se pudo registrar consigna_verificada: ${(e as Error).message}`);
    }
    if (coincide) {
      void vscode.window.showInformationMessage(`Uatu: la consigna está en ${settings.carpeta}/ y es la firmada por la cátedra.`);
    } else {
      void vscode.window.showWarningMessage(
        `Uatu: el contenido de ${settings.carpeta}/ no coincide con la consigna firmada por la cátedra. Avisale al docente.`
      );
    }
  }

  private async closeActive(reason: string, waitMs: number): Promise<AuditSession | undefined> {
    const active = this.active;
    if (!active) {
      return undefined;
    }
    this.active = undefined;
    if (this.consignaTimer) {
      clearTimeout(this.consignaTimer);
      this.consignaTimer = undefined;
    }
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
    this.setView({ kind: 'concluded', examId, pendingBatches: session?.stats.sync.pendingBatches ?? 0 });
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
          this.setView({ ...view, pendingBatches: pending });
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
    this.changeEmitter.dispose();
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

/** ¿Está `nombre` en el PATH? Se ejecuta `nombre --version` (sin shell); un código distinto de 0 igual cuenta como instalada. */
function probarHerramienta(nombre: string): Promise<ToolState> {
  return new Promise((resolve) => {
    execFile(nombre, ['--version'], { timeout: 5000, windowsHide: true }, (error, stdout) => {
      const noEsta = error && ((error as NodeJS.ErrnoException).code === 'ENOENT' || error.killed);
      if (noEsta) {
        resolve({ name: nombre, found: false });
        return;
      }
      const primera = String(stdout).split(/\r?\n/)[0]?.trim();
      resolve(primera ? { name: nombre, found: true, version: primera } : { name: nombre, found: true });
    });
  });
}
