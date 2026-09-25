import * as vscode from 'vscode';
import { formatHourMinuteUtc } from '../core/time';
import { AuditStats } from '../session/auditSession';

/**
 * Indicador de estado en la barra inferior (RF-02).
 */

export type StatusView =
  | { kind: 'idle' }
  | { kind: 'standby'; startMs: number; examId: string }
  | { kind: 'active'; user: string; examId: string; deadlineMs: number; stats?: AuditStats }
  | { kind: 'declined'; examId: string }
  | { kind: 'concluded'; examId: string; pendingBatches: number }
  | { kind: 'error'; message: string };

export class UatuStatusBar implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;
  private view: StatusView = { kind: 'idle' };

  constructor() {
    this.item = vscode.window.createStatusBarItem('uatu.status', vscode.StatusBarAlignment.Left, 1000);
    this.item.name = 'Uatu';
    this.item.command = 'uatu.focusPanel';
    this.render();
    this.item.show();
  }

  public get current(): StatusView {
    return this.view;
  }

  public set(view: StatusView): void {
    this.view = view;
    this.render();
  }

  /** Actualiza las estadísticas del estado activo sin cambiar de estado. */
  public updateStats(stats: AuditStats): void {
    if (this.view.kind === 'active') {
      this.view = { ...this.view, stats };
      this.render();
    }
  }

  private render(): void {
    const v = this.view;
    this.item.backgroundColor = undefined;
    switch (v.kind) {
      case 'idle':
        this.item.text = '$(shield) Uatu: Inactivo';
        this.item.tooltip = 'Uatu no supervisa este workspace (no hay .uatu.conf activo).';
        break;
      case 'standby': {
        const hhmm = formatHourMinuteUtc(new Date(v.startMs));
        this.item.text = `$(clock) Uatu: Esperando inicio (${hhmm} UTC)`;
        this.item.tooltip = `Examen en espera: ${v.examId}. Inicia a las ${hhmm} UTC. No se registra actividad hasta entonces.`;
        break;
      }
      case 'active': {
        const s = v.stats;
        const batch = s ? s.batches : 0;
        const events = s ? s.events : 0;
        this.item.text = `$(shield) Uatu: @${v.user} (Lote: ${batch}, Eventos: ${events})`;
        const lines = [
          `Sesión de examen activa: ${v.examId}`,
          `Cierre: ${formatHourMinuteUtc(new Date(v.deadlineMs))} UTC`,
        ];
        if (s) {
          lines.push(`Eventos pendientes de lote: ${s.pendingEvents}`, `Lotes sin sincronizar: ${s.sync.pendingBatches}`);
          if (s.sync.lastError) {
            lines.push(`Última falla de sincronización: ${s.sync.lastError}`);
            this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
          }
        }
        this.item.tooltip = lines.join('\n');
        break;
      }
      case 'declined':
        this.item.text = '$(circle-slash) Uatu: Consentimiento pendiente';
        this.item.tooltip = `No se aceptaron los términos del examen ${v.examId}. Ejecute "Uatu: Iniciar / reintentar sesión de examen".`;
        this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
        break;
      case 'concluded':
        this.item.text = '$(check) Uatu: Examen Concluido';
        this.item.tooltip =
          `Sesión de examen finalizada (${v.examId}).` +
          (v.pendingBatches > 0 ? ` Lotes aún por sincronizar: ${v.pendingBatches}.` : ' Telemetría sincronizada.');
        break;
      case 'error':
        this.item.text = '$(error) Uatu: Error de integridad';
        this.item.tooltip = v.message;
        this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
        break;
    }
  }

  public dispose(): void {
    this.item.dispose();
  }
}
