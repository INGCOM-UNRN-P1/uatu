import * as fs from 'fs';
import * as vscode from 'vscode';
import { parseTrustAnchors, TrustAnchor } from './config/registry';
import { UatuController } from './vscode/controller';
import { SecretKeyVault } from './vscode/secretVault';
import { UatuSidebar } from './vscode/sidebar';
import { UatuStatusBar } from './vscode/statusBar';

let controller: UatuController | undefined;

function loadAnchors(context: vscode.ExtensionContext, output: vscode.OutputChannel): TrustAnchor[] {
  const file = vscode.Uri.joinPath(context.extensionUri, 'resources', 'trust-anchors.json').fsPath;
  try {
    return parseTrustAnchors(fs.readFileSync(file, 'utf-8'));
  } catch (e) {
    output.appendLine(`No se pudieron cargar las anclas raíz: ${(e as Error).message}`);
    return [];
  }
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const output = vscode.window.createOutputChannel('Uatu');
  const statusBar = new UatuStatusBar();
  context.subscriptions.push(output, statusBar);

  controller = new UatuController({
    context,
    anchors: loadAnchors(context, output),
    vault: new SecretKeyVault(context.secrets),
    statusBar,
    output,
  });
  const c = controller;
  context.subscriptions.push(
    c,
    new UatuSidebar(c),
    vscode.commands.registerCommand('uatu.showStatus', async () => {
      const detail = c.describe();
      output.appendLine(detail);
      const choice = await vscode.window.showInformationMessage('Uatu — estado de la sesión', { modal: true, detail }, 'Ver registro');
      if (choice === 'Ver registro') {
        output.show();
      }
    }),
    vscode.commands.registerCommand('uatu.startSession', () => c.retry()),
    vscode.commands.registerCommand('uatu.flushNow', () => c.flushNow()),
    vscode.commands.registerCommand('uatu.showLog', () => output.show())
  );
  await c.initialize();
}

export async function deactivate(): Promise<void> {
  // Volcado forzado por cierre del IDE (Sección 6, criterio de flush forzado).
  await controller?.shutdown();
  controller = undefined;
}
