import * as vscode from 'vscode';
import { formatHourMinuteUtc } from '../core/time';

/**
 * Identidad GitHub y disclaimer modal de Fair Play (Sección 3.4).
 */

export class ConsentDeclined extends Error {}

/** Normaliza el login para usarlo como componente de referencia Git. */
export function sanitizeGithubLogin(login: string): string {
  const clean = login.trim().replace(/[^A-Za-z0-9-]/g, '-').replace(/^-+|-+$/g, '');
  return clean || 'anonimo';
}

/**
 * Obtiene el usuario de GitHub de la sesión de VS Code. Con
 * require_github_auth solicita el inicio de sesión si hace falta; sin él
 * intenta una sesión existente en silencio y, si no la hay, usa `fallback`.
 */
export async function resolveGithubUser(required: boolean, fallback: () => Promise<string>): Promise<string> {
  if (required) {
    let session: vscode.AuthenticationSession | undefined;
    try {
      session = await vscode.authentication.getSession('github', ['read:user'], { createIfNone: true });
    } catch (e) {
      throw new ConsentDeclined(`No se completó la autenticación con GitHub: ${(e as Error).message}`);
    }
    return sanitizeGithubLogin(session.account.label);
  }
  try {
    const session = await vscode.authentication.getSession('github', ['read:user'], { silent: true });
    if (session) {
      return sanitizeGithubLogin(session.account.label);
    }
  } catch {
    // sin proveedor de autenticación disponible
  }
  return sanitizeGithubLogin(await fallback());
}

export interface DisclaimerInfo {
  user: string;
  examId: string;
  startMs: number;
  deadlineMs: number;
  branchPrefix: string;
  disallowedExtensions: string[];
}

/** Muestra el modal bloqueante de términos. Devuelve true si el estudiante acepta. */
export async function showFairPlayDisclaimer(info: DisclaimerInfo): Promise<boolean> {
  const accept: vscode.MessageItem = { title: 'Aceptar y Comenzar Examen' };
  const cancel: vscode.MessageItem = { title: 'Cancelar / Salir', isCloseAffordance: true };
  const window = `${formatHourMinuteUtc(new Date(info.startMs))} UTC - ${formatHourMinuteUtc(new Date(info.deadlineMs))} UTC`;
  const detail = [
    `Usuario detectado: @${info.user}`,
    `Examen: ${info.examId}`,
    `Ventana: ${window}`,
    '',
    `Esta sesión registrará operaciones de portapapeles y foco de ventana hacia la rama ` +
      `\`${info.branchPrefix}/${info.user}/...\`. El contenido del portapapeles será cifrado ` +
      `para uso exclusivo del cuerpo docente.`,
    info.disallowedExtensions.length > 0
      ? `\nExtensiones no permitidas durante el examen: ${info.disallowedExtensions.join(', ')}.`
      : '',
  ].join('\n');
  const choice = await vscode.window.showWarningMessage(
    'Sesión de Examen Activa - UATU',
    { modal: true, detail },
    accept,
    cancel
  );
  return choice === accept;
}
