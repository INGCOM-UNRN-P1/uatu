/**
 * Serialización JSON canónica de uatu (Sección 5.2 de la especificación).
 *
 * Reglas:
 *  - Claves de objetos ordenadas alfabéticamente (por punto de código).
 *  - Sin espacios redundantes (separadores "," y ":").
 *  - Codificación UTF-8 sin escapar caracteres no ASCII.
 *  - Solo se admiten enteros seguros como números: los flotantes tienen
 *    representaciones divergentes entre JavaScript y Python y romperían la
 *    verificación cruzada de hashes y firmas.
 *
 * La salida es byte a byte idéntica a
 * `json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=False)`
 * en Python, que es la forma que utiliza el validador `uatu_audit.py`.
 */

export type CanonicalValue =
  | null
  | boolean
  | number
  | string
  | CanonicalValue[]
  | { [key: string]: CanonicalValue };

export class CanonicalJsonError extends Error {}

function compareKeys(a: string, b: string): number {
  // Orden por punto de código Unicode (equivalente a sorted() de Python).
  const ca = Array.from(a);
  const cb = Array.from(b);
  const len = Math.min(ca.length, cb.length);
  for (let i = 0; i < len; i++) {
    const da = ca[i].codePointAt(0)!;
    const db = cb[i].codePointAt(0)!;
    if (da !== db) {
      return da - db;
    }
  }
  return ca.length - cb.length;
}

function serialize(value: unknown, path: string): string {
  if (value === null) {
    return 'null';
  }
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isSafeInteger(value)) {
        throw new CanonicalJsonError(
          `Valor numérico no canónico en ${path}: solo se admiten enteros seguros (recibido ${value}).`
        );
      }
      return Object.is(value, -0) ? '0' : String(value);
    case 'string':
      return JSON.stringify(value);
    case 'object': {
      if (Array.isArray(value)) {
        return '[' + value.map((item, i) => serialize(item, `${path}[${i}]`)).join(',') + ']';
      }
      const obj = value as Record<string, unknown>;
      const keys = Object.keys(obj)
        .filter((k) => obj[k] !== undefined)
        .sort(compareKeys);
      const parts = keys.map((k) => JSON.stringify(k) + ':' + serialize(obj[k], `${path}.${k}`));
      return '{' + parts.join(',') + '}';
    }
    default:
      throw new CanonicalJsonError(`Tipo no serializable en ${path}: ${typeof value}.`);
  }
}

/** Devuelve la serialización canónica como cadena. */
export function canonicalStringify(value: unknown): string {
  return serialize(value, '$');
}

/** Devuelve la serialización canónica codificada en UTF-8. */
export function canonicalBytes(value: unknown): Buffer {
  return Buffer.from(canonicalStringify(value), 'utf-8');
}

/** Copia superficial de un objeto sin la clave indicada. */
export function omitKey<T extends object, K extends keyof T>(obj: T, key: K): Omit<T, K> {
  const copy = { ...obj };
  delete copy[key];
  return copy;
}
