/**
 * Auditoría de extensiones no autorizadas (RF-03).
 */

export interface ExtensionInfo {
  id: string;
  version: string;
  isActive: boolean;
  /** Integrada en VS Code (`packageJSON.isBuiltin` o publisher `vscode`): nunca es un hallazgo. */
  builtin?: boolean;
}

/**
 * Política de extensiones del manifiesto: la lista de prohibidas y, si no está
 * vacía, la de permitidas (portada de grid, N-GRID-01), con la que cualquier
 * otra extensión instalada es un hallazgo. `propia` es la de uatu, siempre permitida.
 */
export interface ExtensionPolicy {
  disallowed: string[];
  allowed?: string[];
  propia?: string;
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
  policy: string[] | ExtensionPolicy,
  previous: Map<string, ExtensionState>
): ExtensionFinding[] {
  const { disallowed, allowed = [], propia } = Array.isArray(policy) ? { disallowed: policy } : policy;
  const blocked = new Set(disallowed.map((d) => d.toLowerCase()));
  const permitidas = new Set(allowed.map((d) => d.toLowerCase()));
  const noPermitida = (ext: ExtensionInfo, id: string): boolean =>
    blocked.has(id) ||
    (permitidas.size > 0 && !permitidas.has(id) && !ext.builtin && !id.startsWith('vscode.') && id !== propia?.toLowerCase());
  const findings: ExtensionFinding[] = [];
  const seen = new Set<string>();
  for (const ext of installed) {
    const id = ext.id.toLowerCase();
    if (!noPermitida(ext, id)) {
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
