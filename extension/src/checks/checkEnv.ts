/**
 * Verificación local del entorno antes del examen (check-env, QoL #1288).
 *
 * Responde, antes de `start_utc`, si el equipo del estudiante va a poder rendir:
 * manifiesto y firma docente, ventana horaria y reloj, extensiones y
 * configuración del editor según la política del manifiesto, Git listo para
 * publicar la telemetría y las herramientas que pide el examen. Es una función
 * pura sobre lo que observa la extensión: no inicia la sesión, no registra
 * eventos y no envía nada (el único acceso a la red es el que ya hace la
 * extensión para leer el registro público de claves docentes).
 */

import { ParsedManifest } from '../config/manifest';
import { auditExtensions, ExtensionInfo } from '../monitors/extensionAudit';
import { auditSettings } from '../monitors/settingsAudit';
import { formatHourMinuteUtc } from '../core/time';

export type CheckStatus = 'ok' | 'warn' | 'fail';

export interface EnvCheck {
  id: string;
  title: string;
  status: CheckStatus;
  detail: string;
  /** Qué hacer para resolverlo (solo si no está ok). */
  fix?: string;
}

/** Firma del manifiesto: verificada, inválida o sin poder verificar (sin registro de claves). */
export type SignatureState = { kind: 'valid' } | { kind: 'invalid' } | { kind: 'unverified'; reason: string };

export interface GitState {
  available: boolean;
  version?: string;
  repoRoot?: string;
  remoteUrl?: string;
  userName?: string;
}

export interface ToolState {
  name: string;
  found: boolean;
  version?: string;
}

export interface EnvInputs {
  manifest?: ParsedManifest;
  manifestError?: string;
  signature?: SignatureState;
  nowMs: number;
  /** Desfase observado contra la hora del servidor (HTTP Date), si se calibró. */
  clockOffsetMs?: number;
  extensions: ExtensionInfo[];
  ownExtensionId: string;
  readSetting: (key: string) => unknown;
  workspaceTrusted: boolean;
  git: GitState;
  tools: ToolState[];
}

/** Desfase de reloj a partir del cual se avisa (el mismo umbral que registra clock_skew). */
export const CLOCK_SKEW_WARN_MS = 30_000;

function check(id: string, title: string, status: CheckStatus, detail: string, fix?: string): EnvCheck {
  return fix && status !== 'ok' ? { id, title, status, detail, fix } : { id, title, status, detail };
}

export function checkEnvironment(i: EnvInputs): EnvCheck[] {
  const checks: EnvCheck[] = [];
  const m = i.manifest;

  if (!m) {
    checks.push(
      check(
        'manifiesto',
        'Manifiesto del examen (.uatu.conf)',
        'fail',
        i.manifestError ?? 'No hay .uatu.conf en el workspace abierto.',
        'Abrí en VS Code la carpeta del repositorio del examen (la que tiene .uatu.conf).'
      )
    );
  } else {
    checks.push(check('manifiesto', 'Manifiesto del examen (.uatu.conf)', 'ok', `Examen ${m.manifest.exam_id}.`));
    const sig = i.signature ?? { kind: 'unverified', reason: 'todavía no se verificó' };
    if (sig.kind === 'valid') {
      checks.push(check('firma', 'Firma docente del manifiesto', 'ok', 'Válida.'));
    } else if (sig.kind === 'invalid') {
      checks.push(
        check('firma', 'Firma docente del manifiesto', 'fail', 'INVÁLIDA: el manifiesto fue modificado.',
          'Descartá los cambios en .uatu.conf (git checkout -- .uatu.conf) o volvé a clonar el repositorio.')
      );
    } else {
      checks.push(
        check('firma', 'Firma docente del manifiesto', 'warn', `No se pudo verificar: ${sig.reason}`,
          'Conectate a internet una vez antes del examen para descargar el registro de claves de la cátedra.')
      );
    }

    if (i.nowMs >= m.deadlineMs) {
      checks.push(
        check('ventana', 'Horario del examen', 'fail', `El examen terminó (${formatHourMinuteUtc(new Date(m.deadlineMs))} UTC).`,
          'Verificá con la cátedra que sea el repositorio correcto.')
      );
    } else if (i.nowMs < m.startMs) {
      checks.push(
        check('ventana', 'Horario del examen', 'ok',
          `Empieza a las ${formatHourMinuteUtc(new Date(m.startMs))} UTC y termina a las ${formatHourMinuteUtc(new Date(m.deadlineMs))} UTC.`)
      );
    } else {
      checks.push(check('ventana', 'Horario del examen', 'ok', `En curso hasta las ${formatHourMinuteUtc(new Date(m.deadlineMs))} UTC.`));
    }
  }

  if (i.clockOffsetMs === undefined) {
    checks.push(check('reloj', 'Reloj del equipo', 'warn', 'No se pudo comparar con la hora del servidor.',
      'Conectate a internet para que uatu calibre el reloj.'));
  } else if (Math.abs(i.clockOffsetMs) >= CLOCK_SKEW_WARN_MS) {
    checks.push(
      check('reloj', 'Reloj del equipo', 'warn',
        `Está ${Math.round(Math.abs(i.clockOffsetMs) / 1000)} s ${i.clockOffsetMs > 0 ? 'atrasado' : 'adelantado'} respecto del servidor.`,
        'Activá la sincronización automática de la hora del sistema; uatu usa la del servidor, pero el desfase queda registrado.')
    );
  } else {
    checks.push(check('reloj', 'Reloj del equipo', 'ok', 'Sincronizado con el servidor.'));
  }

  if (m) {
    const { disallowed_extensions, allowed_extensions, setting_rules } = m.manifest.monitoring;
    const hallazgos = auditExtensions(
      i.extensions,
      { disallowed: disallowed_extensions, allowed: allowed_extensions, propia: i.ownExtensionId },
      new Map()
    );
    if (hallazgos.length === 0) {
      checks.push(check('extensiones', 'Extensiones del editor', 'ok', 'Ninguna extensión no permitida.'));
    } else {
      checks.push(
        check('extensiones', 'Extensiones del editor', 'fail',
          `No permitidas durante el examen: ${hallazgos.map((h) => h.extension_id).join(', ')}.`,
          'Deshabilitalas (Extensiones → Deshabilitar) antes de empezar: si quedan activas, se registran en la bitácora.')
      );
    }

    const violaciones = auditSettings(setting_rules, i.readSetting, new Map()).filter((f) => f.state === 'violated');
    if (violaciones.length === 0) {
      checks.push(check('configuracion', 'Configuración del editor', 'ok',
        setting_rules.length ? 'Cumple las reglas del examen.' : 'El examen no tiene reglas de configuración.'));
    } else {
      checks.push(
        check('configuracion', 'Configuración del editor', 'fail',
          violaciones.map((v) => `${v.key} = ${v.value_json}${v.note ? ` (${v.note})` : ''}`).join('; '),
          'Cambiá esos valores en la configuración de VS Code (Ctrl+,) antes de empezar.')
      );
    }
  }

  if (!i.workspaceTrusted) {
    checks.push(check('confianza', 'Confianza del workspace', 'fail', 'El workspace está en modo restringido.',
      'Confiá en la carpeta del examen (Administrar confianza del workspace): sin eso uatu no puede auditar.'));
  }

  if (!i.git.available) {
    checks.push(check('git', 'Git', 'fail', 'No se encontró git.', 'Instalá Git y reiniciá VS Code.'));
  } else if (!i.git.repoRoot) {
    checks.push(check('git', 'Git', 'fail', 'La carpeta abierta no es un repositorio Git.',
      'Cloná el repositorio del examen con git clone y abrí esa carpeta.'));
  } else if (!i.git.remoteUrl) {
    const remoto = m?.manifest.git.remote_name ?? 'origin';
    checks.push(check('git', 'Git', 'fail', `El repositorio no tiene el remoto "${remoto}".`,
      'Volvé a clonar el repositorio del examen desde GitHub.'));
  } else {
    const usuario = i.git.userName ? ` Usuario: ${i.git.userName}.` : '';
    checks.push(check('git', 'Git', 'ok', `${i.git.version ?? 'git'}; remoto ${i.git.remoteUrl}.${usuario}`));
    if (m && !m.manifest.auth.require_github_auth && !i.git.userName) {
      checks.push(check('git-usuario', 'Identidad de Git', 'fail', 'git config user.name está vacío y el examen la usa para identificarte.',
        'git config --global user.name "tu-usuario-de-github"'));
    }
  }

  for (const t of i.tools) {
    checks.push(
      t.found
        ? check(`herramienta:${t.name}`, `Herramienta ${t.name}`, 'ok', t.version ?? 'Instalada.')
        : check(`herramienta:${t.name}`, `Herramienta ${t.name}`, 'fail', 'No está en el PATH.',
            `Instalá ${t.name} (ver la guía de instalación de la cátedra) y reiniciá VS Code.`)
    );
  }
  return checks;
}

export function overallStatus(checks: EnvCheck[]): CheckStatus {
  if (checks.some((c) => c.status === 'fail')) return 'fail';
  if (checks.some((c) => c.status === 'warn')) return 'warn';
  return 'ok';
}

const ICONO: Record<CheckStatus, string> = { ok: '✓', warn: '⚠', fail: '✗' };

/** Reporte en texto para el canal de salida (nada sale del equipo). */
export function formatReport(checks: EnvCheck[]): string {
  const total = overallStatus(checks);
  const titulo =
    total === 'ok' ? 'Entorno listo para el examen.'
      : total === 'warn' ? 'Entorno utilizable, con avisos.'
        : 'Hay problemas que resolver antes del examen.';
  const lineas = [`Uatu — verificación del entorno: ${titulo}`, ''];
  for (const c of checks) {
    lineas.push(`${ICONO[c.status]} ${c.title}: ${c.detail}`);
    if (c.fix) lineas.push(`    → ${c.fix}`);
  }
  lineas.push('', 'Esta verificación es local: no inicia la sesión ni envía datos.');
  return lineas.join('\n');
}
