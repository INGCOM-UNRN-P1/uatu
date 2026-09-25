import * as vscode from 'vscode';
import { computeEventHash } from '../audit/hashChain';
import {
  buildLogTree,
  buildStatusTree,
  LogGrouping,
  renderEventDetail,
  UatuSnapshot,
  ViewNode,
} from '../views/model';

/**
 * Panel lateral de uatu: contenedor en la barra de actividad con las vistas
 * "Monitoreo" (estado) y "Bitácora" (eventos registrados).
 */

export const STATUS_VIEW_ID = 'uatu.statusView';
export const LOG_VIEW_ID = 'uatu.logView';

/** Eventos que se cuentan en el badge del panel: los que la cátedra revisará. */
const FLAGGED = new Set(['clipboard_paste', 'external_insertion', 'disallowed_extension', 'config_changed', 'clock_skew']);

const GROUPING_LABELS: Record<LogGrouping, string> = {
  batch: 'por lote',
  type: 'por tipo',
  time: 'cronológica',
};

export interface SnapshotSource {
  snapshot(): UatuSnapshot;
  readonly onDidChange: vscode.Event<void>;
}

class NodeTreeProvider implements vscode.TreeDataProvider<ViewNode> {
  private nodes: ViewNode[] = [];
  private readonly emitter = new vscode.EventEmitter<ViewNode | undefined | void>();
  public readonly onDidChangeTreeData = this.emitter.event;

  public setNodes(nodes: ViewNode[]): void {
    this.nodes = nodes;
    this.emitter.fire();
  }

  public get roots(): ViewNode[] {
    return this.nodes;
  }

  public getChildren(node?: ViewNode): ViewNode[] {
    return node ? node.children ?? [] : this.nodes;
  }

  public getTreeItem(node: ViewNode): vscode.TreeItem {
    const state = node.children && node.children.length > 0
      ? node.expanded
        ? vscode.TreeItemCollapsibleState.Expanded
        : vscode.TreeItemCollapsibleState.Collapsed
      : vscode.TreeItemCollapsibleState.None;
    const item = new vscode.TreeItem(node.label, state);
    item.id = node.id;
    item.description = node.description;
    if (node.tooltip) {
      item.tooltip = new vscode.MarkdownString(node.tooltip);
    }
    if (node.icon) {
      item.iconPath = new vscode.ThemeIcon(node.icon, node.color ? new vscode.ThemeColor(node.color) : undefined);
    }
    item.contextValue = node.contextValue;
    return item;
  }

  public dispose(): void {
    this.emitter.dispose();
  }
}

export class UatuSidebar implements vscode.Disposable {
  private readonly statusProvider = new NodeTreeProvider();
  private readonly logProvider = new NodeTreeProvider();
  private readonly statusView: vscode.TreeView<ViewNode>;
  private readonly logView: vscode.TreeView<ViewNode>;
  private readonly disposables: vscode.Disposable[] = [];
  private grouping: LogGrouping = 'batch';
  private current: UatuSnapshot | undefined;
  private pending: NodeJS.Timeout | undefined;
  private readonly ticker: NodeJS.Timeout;

  constructor(private readonly source: SnapshotSource) {
    this.statusView = vscode.window.createTreeView(STATUS_VIEW_ID, { treeDataProvider: this.statusProvider });
    this.logView = vscode.window.createTreeView(LOG_VIEW_ID, { treeDataProvider: this.logProvider, showCollapseAll: true });
    this.disposables.push(
      this.statusView,
      this.logView,
      this.statusProvider,
      this.logProvider,
      source.onDidChange(() => this.scheduleRefresh()),
      vscode.commands.registerCommand('uatu.refreshViews', () => this.refresh()),
      vscode.commands.registerCommand('uatu.changeLogGrouping', () => this.pickGrouping()),
      vscode.commands.registerCommand('uatu.showEventDetail', (node?: ViewNode) => this.showDetail(node)),
      vscode.commands.registerCommand('uatu.copyEventHash', (node?: ViewNode) => this.copyHash(node)),
      vscode.commands.registerCommand('uatu.openSessionFolder', () => this.openSessionFolder()),
      vscode.commands.registerCommand('uatu.focusPanel', () => vscode.commands.executeCommand(`${STATUS_VIEW_ID}.focus`))
    );
    // Las cuentas regresivas y los "hace X" se actualizan aunque no haya eventos.
    this.ticker = setInterval(() => this.refresh(), 15_000).unref();
    this.refresh();
  }

  public get statusNodes(): ViewNode[] {
    return this.statusProvider.roots;
  }

  public get logNodes(): ViewNode[] {
    return this.logProvider.roots;
  }

  public get logGrouping(): LogGrouping {
    return this.grouping;
  }

  public setGrouping(grouping: LogGrouping): void {
    this.grouping = grouping;
    this.refresh();
  }

  private scheduleRefresh(): void {
    if (this.pending) {
      return;
    }
    this.pending = setTimeout(() => {
      this.pending = undefined;
      this.refresh();
    }, 200);
  }

  public refresh(): void {
    const s = this.source.snapshot();
    this.current = s;
    this.statusProvider.setNodes(buildStatusTree(s));
    this.logProvider.setNodes(buildLogTree(s, this.grouping));

    this.logView.description = s.events.length > 0 ? `${s.events.length} eventos · ${GROUPING_LABELS[this.grouping]}` : undefined;
    const flagged = s.events.filter((e) => FLAGGED.has(e.event.event_type)).length;
    this.logView.badge = flagged > 0 ? { value: flagged, tooltip: `${flagged} evento(s) relevantes para la auditoría` } : undefined;
    this.statusView.description = s.session ? `@${s.session.user}` : undefined;
  }

  private async pickGrouping(): Promise<void> {
    const items = (Object.keys(GROUPING_LABELS) as LogGrouping[]).map((g) => ({
      label: `Agrupar ${GROUPING_LABELS[g]}`,
      description: g === this.grouping ? 'actual' : undefined,
      grouping: g,
    }));
    const choice = await vscode.window.showQuickPick(items, { placeHolder: 'Organización de la bitácora' });
    if (choice) {
      this.setGrouping(choice.grouping);
    }
  }

  private findEvent(node?: ViewNode) {
    const seq = node?.eventSeq ?? this.logView.selection[0]?.eventSeq;
    if (seq === undefined || !this.current) {
      return undefined;
    }
    return this.current.events.find((e) => e.event.sequence_id === seq);
  }

  private async showDetail(node?: ViewNode): Promise<void> {
    const item = this.findEvent(node);
    if (!item) {
      return;
    }
    const doc = await vscode.workspace.openTextDocument({ language: 'json', content: renderEventDetail(item) });
    await vscode.window.showTextDocument(doc, { preview: true });
  }

  private async copyHash(node?: ViewNode): Promise<void> {
    const item = this.findEvent(node);
    if (!item) {
      return;
    }
    await vscode.env.clipboard.writeText(computeEventHash(item.event));
    vscode.window.setStatusBarMessage(`[Uatu] Hash del evento ${item.event.sequence_id} copiado`, 3000);
  }

  private async openSessionFolder(): Promise<void> {
    const dir = this.current?.session?.directory;
    if (!dir) {
      void vscode.window.showInformationMessage('Uatu: no hay una sesión de examen en este workspace.');
      return;
    }
    await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(dir));
  }

  public dispose(): void {
    clearInterval(this.ticker);
    if (this.pending) {
      clearTimeout(this.pending);
    }
    this.disposables.forEach((d) => d.dispose());
  }
}
