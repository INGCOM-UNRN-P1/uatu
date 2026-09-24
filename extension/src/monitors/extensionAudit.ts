/**
 * Auditoría de extensiones no autorizadas (RF-03).
 */

export interface ExtensionInfo {
  id: string;
  version: string;
  isActive: boolean;
}

export type ExtensionState = 'installed' | 'active' | 'removed';

export interface ExtensionFinding {
  extension_id: string;
  version: string;
  state: ExtensionState;
}

/**
 * Compara el inventario actual con el estado observado previamente y
 * devuelve solo las transiciones relevantes de extensiones bloqueadas.
 * `previous` se actualiza en el lugar.
 */
export function auditExtensions(
  installed: ExtensionInfo[],
  disallowed: string[],
  previous: Map<string, ExtensionState>
): ExtensionFinding[] {
  const blocked = new Set(disallowed.map((d) => d.toLowerCase()));
  const findings: ExtensionFinding[] = [];
  const seen = new Set<string>();
  for (const ext of installed) {
    const id = ext.id.toLowerCase();
    if (!blocked.has(id)) {
      continue;
    }
    seen.add(id);
    const state: ExtensionState = ext.isActive ? 'active' : 'installed';
    if (previous.get(id) !== state) {
      previous.set(id, state);
      findings.push({ extension_id: id, version: ext.version, state });
    }
  }
  for (const [id, state] of previous) {
    if (!seen.has(id) && state !== 'removed') {
      previous.set(id, 'removed');
      findings.push({ extension_id: id, version: '', state: 'removed' });
    }
  }
  return findings;
}
