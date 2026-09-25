import * as path from 'path';
import * as vscode from 'vscode';
import { EventData, EventType } from '../audit/events';
import { UatuManifest } from '../config/manifest';
import { Clock } from '../core/time';
import { auditExtensions, ExtensionState } from '../monitors/extensionAudit';
import { FocusTracker } from '../monitors/focusTracker';
import { DetectedInsertion, InsertionDetector } from '../monitors/insertionDetector';
import { buildInsertionRecord } from '../monitors/insertionEvent';

/**
 * Observadores de eventos del editor montados durante el estado ACTIVO.
 */

export interface MonitorContext {
  manifest: UatuManifest;
  repoRoot: string;
  teacherEncryptionKey: Buffer;
  clock: Clock;
  sessionStartedMs: number;
  record: (type: EventType, data: EventData) => void;
  flush: (reason: string) => void;
  log: (message: string) => void;
}

/** Ruta que se registra como target_file (relativa al repositorio, con "/"). */
export function describeTarget(uri: vscode.Uri, repoRoot: string): string | undefined {
  if (uri.scheme === 'untitled') {
    return `untitled:${uri.path}`;
  }
  if (uri.scheme !== 'file' && uri.scheme !== 'vscode-notebook-cell') {
    return undefined; // output, git, settings, etc.
  }
  const rel = path.relative(repoRoot, uri.fsPath);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    return `external:${path.basename(uri.fsPath)}`;
  }
  const normalized = rel.split(path.sep).join('/');
  if (normalized === '.git' || normalized.startsWith('.git/')) {
    return undefined;
  }
  return normalized;
}

/** Estado observable de los monitores para el panel lateral. */
export interface MonitorSnapshot {
  focused: boolean;
  unfocusedTotalMs: number;
  lastHeartbeatMs?: number;
  extensions: { id: string; state: ExtensionState }[];
  insertions: number;
}

export class EditorMonitors implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private readonly focus: FocusTracker;
  private readonly extensionState = new Map<string, ExtensionState>();
  private readonly detector: InsertionDetector | undefined;
  private heartbeat: NodeJS.Timeout | undefined;
  private lastSaveFlushMs = 0;
  private readonly inFlight = new Set<Promise<void>>();
  private lastHeartbeatMs: number | undefined;
  private insertions = 0;

  constructor(private readonly ctx: MonitorContext) {
    const now = ctx.clock.now();
    this.focus = new FocusTracker(vscode.window.state.focused, now);
    const { monitoring, session } = ctx.manifest;

    if (monitoring.clipboard.enabled) {
      this.detector = new InsertionDetector(
        monitoring.clipboard.character_threshold,
        (ins) => {
          const p = this.onInsertion(ins).finally(() => this.inFlight.delete(p));
          this.inFlight.add(p);
        },
        ctx.clock
      );
      this.disposables.push(vscode.workspace.onDidChangeTextDocument((e) => this.onDocumentChange(e)));
    }

    if (monitoring.window_focus) {
      this.disposables.push(vscode.window.onDidChangeWindowState((s) => this.onWindowState(s)));
      if (!this.focus.isFocused) {
        ctx.record('window_focus', { focused: false, unfocused_total_ms: 0 });
      }
    }

    if (monitoring.disallowed_extensions.length > 0) {
      this.disposables.push(vscode.extensions.onDidChange(() => this.checkExtensions()));
      this.checkExtensions();
    }

    // Guardado del estudiante: volcado forzado, limitado a uno cada 10 s.
    this.disposables.push(
      vscode.workspace.onDidSaveTextDocument(() => {
        const t = ctx.clock.now();
        if (t - this.lastSaveFlushMs >= 10_000) {
          this.lastSaveFlushMs = t;
          ctx.flush('guardado');
        }
      })
    );

    this.heartbeat = setInterval(() => this.onHeartbeat(), session.heartbeat_interval_seconds * 1000);
  }

  private onDocumentChange(e: vscode.TextDocumentChangeEvent): void {
    if (e.contentChanges.length === 0) {
      return;
    }
    if (e.reason === vscode.TextDocumentChangeReason.Undo || e.reason === vscode.TextDocumentChangeReason.Redo) {
      return;
    }
    const target = describeTarget(e.document.uri, this.ctx.repoRoot);
    if (!target || !this.detector) {
      return;
    }
    this.detector.feed(
      e.document.uri.toString(),
      e.contentChanges.map((c) => ({
        text: c.text,
        start: { line: c.range.start.line, character: c.range.start.character },
      }))
    );
  }

  private async onInsertion(ins: DetectedInsertion): Promise<void> {
    try {
      const uri = vscode.Uri.parse(ins.documentKey);
      const target = describeTarget(uri, this.ctx.repoRoot) ?? uri.toString();
      let clipboardText = '';
      try {
        clipboardText = await vscode.env.clipboard.readText();
      } catch {
        clipboardText = '';
      }
      const active = vscode.window.activeTextEditor?.document.uri.toString() === ins.documentKey;
      const rec = buildInsertionRecord(
        ins,
        { targetFile: target, clipboardText, windowFocused: vscode.window.state.focused, isActiveEditor: active },
        this.ctx.manifest.monitoring.clipboard,
        this.ctx.teacherEncryptionKey
      );
      this.ctx.record(rec.type, rec.data);
      this.insertions++;
      const what = rec.type === 'clipboard_paste' ? 'Portapapeles registrado' : 'Inserción externa registrada';
      const how = this.ctx.manifest.monitoring.clipboard.encrypt_content ? ' y cifrado' : '';
      vscode.window.setStatusBarMessage(`[Uatu] ${what}${how} (Hash: ${rec.plaintextSha256.slice(0, 4)}...)`, 4000);
    } catch (e) {
      this.ctx.log(`[monitor] error registrando inserción: ${(e as Error).message}`);
    }
  }

  private onWindowState(state: vscode.WindowState): void {
    const t = this.focus.update(state.focused, this.ctx.clock.now());
    if (t) {
      const data: EventData = { focused: t.focused, unfocused_total_ms: t.unfocused_total_ms };
      if (t.unfocused_ms !== undefined) {
        data.unfocused_ms = t.unfocused_ms;
      }
      this.ctx.record('window_focus', data);
    }
  }

  private checkExtensions(): void {
    const installed = vscode.extensions.all.map((x) => ({
      id: x.id,
      version: String((x.packageJSON as { version?: string })?.version ?? ''),
      isActive: x.isActive,
    }));
    const findings = auditExtensions(installed, this.ctx.manifest.monitoring.disallowed_extensions, this.extensionState);
    for (const f of findings) {
      this.ctx.record('disallowed_extension', { extension_id: f.extension_id, version: f.version, state: f.state });
      if (f.state !== 'removed') {
        void vscode.window.showWarningMessage(
          `Uatu: la extensión "${f.extension_id}" no está permitida durante el examen y quedó registrada. Deshabilítela para continuar.`
        );
      }
    }
  }

  private onHeartbeat(): void {
    const now = this.ctx.clock.now();
    // La activación de extensiones no emite eventos: se sondea en cada latido.
    if (this.ctx.manifest.monitoring.disallowed_extensions.length > 0) {
      this.checkExtensions();
    }
    this.lastHeartbeatMs = now;
    this.ctx.record('heartbeat', {
      uptime_seconds: Math.floor((now - this.ctx.sessionStartedMs) / 1000),
      window_focused: vscode.window.state.focused,
      unfocused_total_ms: this.focus.totalUnfocused(now),
    });
  }

  public snapshot(): MonitorSnapshot {
    const now = this.ctx.clock.now();
    return {
      focused: this.focus.isFocused,
      unfocusedTotalMs: this.focus.totalUnfocused(now),
      lastHeartbeatMs: this.lastHeartbeatMs,
      extensions: [...this.extensionState.entries()].map(([id, state]) => ({ id, state })),
      insertions: this.insertions,
    };
  }

  /** Desmonta los observadores y espera las inserciones en curso de registro. */
  public async stop(): Promise<void> {
    this.dispose();
    await Promise.all([...this.inFlight]);
  }

  public dispose(): void {
    if (this.heartbeat) {
      clearInterval(this.heartbeat);
      this.heartbeat = undefined;
    }
    this.detector?.flushAll();
    this.disposables.forEach((d) => d.dispose());
    this.disposables.length = 0;
  }
}
