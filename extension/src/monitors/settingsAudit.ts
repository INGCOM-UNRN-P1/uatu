/**
 * Auditoría de la configuración del editor contra las reglas del manifiesto
 * (`monitoring.setting_rules`). Portada de grid (N-GRID-01), cuya bitácora con
 * SHA-256 sin firma se podía reescribir: acá los hallazgos entran a la cadena
 * firmada de uatu.
 */

import { SettingRule } from '../config/manifest';

export type SettingState = 'violated' | 'resolved';

export interface SettingFinding {
  key: string;
  /** Valor observado serializado como JSON (acotado): un valor real puede no ser canónico (p. ej., 14.5). */
  value_json: string;
  state: SettingState;
  note: string;
}

/** Largo máximo del valor registrado: la bitácora no es lugar para objetos grandes de configuración. */
export const MAX_VALUE_JSON = 200;

export function violatesRule(rule: SettingRule, value: unknown): boolean {
  if (rule.forbid) {
    return Boolean(value);
  }
  if (rule.allow) {
    const actual = JSON.stringify(value ?? null);
    return !rule.allow.some((permitido) => JSON.stringify(permitido) === actual);
  }
  return false;
}

function serializeValue(value: unknown): string {
  const json = JSON.stringify(value ?? null) ?? 'null';
  return json.length > MAX_VALUE_JSON ? `${json.slice(0, MAX_VALUE_JSON)}…` : json;
}

/**
 * Evalúa las reglas con `read` (en la extensión, `workspace.getConfiguration().get`)
 * y devuelve solo las transiciones: la primera violación de una clave y su
 * resolución posterior, no cada lectura. `previous` guarda el último estado por
 * clave y se actualiza en el lugar.
 */
export function auditSettings(
  rules: SettingRule[],
  read: (key: string) => unknown,
  previous: Map<string, SettingState>
): SettingFinding[] {
  const findings: SettingFinding[] = [];
  for (const rule of rules) {
    const value = read(rule.key);
    const state: SettingState = violatesRule(rule, value) ? 'violated' : 'resolved';
    const before = previous.get(rule.key);
    if (state === before || (state === 'resolved' && before === undefined)) {
      continue; // sin cambio, o cumple desde el principio: nada que registrar
    }
    previous.set(rule.key, state);
    findings.push({ key: rule.key, value_json: serializeValue(value), state, note: rule.note ?? '' });
  }
  return findings;
}
