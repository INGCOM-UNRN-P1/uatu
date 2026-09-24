import * as fs from 'fs';
import * as path from 'path';
import { canonicalBytes, omitKey } from '../core/canonicalJson';
import { sha256Hex, UatuCryptoEngine } from '../crypto/cryptoEngine';

/**
 * Registro público de claves docentes con ancla raíz institucional
 * (Sección 3.3, puntos 1 y 2).
 *
 * Formato:
 * {
 *   "version": "1",
 *   "issued_at_utc": "...",
 *   "root_key_id": "uba-root-2026",
 *   "teachers": {
 *     "<teacher_key_id>": {
 *       "ed25519_verify_key": "<hex 32 bytes>",
 *       "x25519_encryption_key": "<hex 32 bytes>",
 *       "not_before_utc": "...",   // opcional
 *       "not_after_utc": "..."     // opcional
 *     }
 *   },
 *   "signature": "<Ed25519 raíz sobre el JSON canónico sin 'signature'>"
 * }
 */

export interface TrustAnchor {
  key_id: string;
  ed25519_public_key: string;
  description?: string;
}

export interface TeacherKeyEntry {
  ed25519_verify_key: string;
  x25519_encryption_key: string;
  not_before_utc?: string;
  not_after_utc?: string;
  name?: string;
}

export interface KeyRegistry {
  version: string;
  issued_at_utc?: string;
  root_key_id: string;
  teachers: Record<string, TeacherKeyEntry>;
  signature: string;
}

/** Certificado docente resuelto (Sección 3.3, punto 2). */
export interface TeacherCertificate {
  keyId: string;
  verifyKeyHex: string;
  encryptionKey: Buffer;
}

export class RegistryError extends Error {}

const HEX32 = /^[0-9a-f]{64}$/;

export function parseTrustAnchors(text: string): TrustAnchor[] {
  const data = JSON.parse(text) as { anchors?: unknown };
  if (!Array.isArray(data.anchors)) {
    throw new RegistryError('trust-anchors.json debe contener una lista "anchors".');
  }
  return data.anchors.filter(
    (a): a is TrustAnchor =>
      typeof a === 'object' && a !== null && typeof a.key_id === 'string' && HEX32.test(String(a.ed25519_public_key))
  );
}

/** Verifica la firma raíz del registro y devuelve el objeto tipado. */
export function verifyRegistry(data: unknown, anchors: TrustAnchor[]): KeyRegistry {
  if (typeof data !== 'object' || data === null) {
    throw new RegistryError('El registro de claves no es un objeto JSON.');
  }
  const reg = data as KeyRegistry;
  if (typeof reg.root_key_id !== 'string' || typeof reg.signature !== 'string' || typeof reg.teachers !== 'object') {
    throw new RegistryError('El registro de claves no tiene la estructura esperada.');
  }
  const anchor = anchors.find((a) => a.key_id === reg.root_key_id);
  if (!anchor) {
    throw new RegistryError(`El registro está firmado por una raíz desconocida: ${reg.root_key_id}.`);
  }
  const payload = canonicalBytes(omitKey(reg, 'signature'));
  if (!UatuCryptoEngine.verifyMessage(payload, reg.signature, anchor.ed25519_public_key)) {
    throw new RegistryError('La firma raíz del registro de claves es inválida.');
  }
  return reg;
}

/** Obtiene el certificado del docente indicado, validando su vigencia. */
export function resolveTeacher(reg: KeyRegistry, keyId: string, nowMs: number): TeacherCertificate {
  const entry = reg.teachers[keyId];
  if (!entry) {
    throw new RegistryError(`El registro no contiene la clave docente "${keyId}".`);
  }
  if (!HEX32.test(entry.ed25519_verify_key) || !HEX32.test(entry.x25519_encryption_key)) {
    throw new RegistryError(`La entrada "${keyId}" del registro tiene claves mal formadas.`);
  }
  if (entry.not_before_utc && nowMs < Date.parse(entry.not_before_utc)) {
    throw new RegistryError(`La clave docente "${keyId}" aún no está vigente.`);
  }
  if (entry.not_after_utc && nowMs > Date.parse(entry.not_after_utc)) {
    throw new RegistryError(`La clave docente "${keyId}" está vencida.`);
  }
  return {
    keyId,
    verifyKeyHex: entry.ed25519_verify_key,
    encryptionKey: Buffer.from(entry.x25519_encryption_key, 'hex'),
  };
}

export interface FetchedDocument {
  body: string;
  /** Hora del servidor según la cabecera HTTP Date (ms epoch), si existe. */
  serverDateMs?: number;
  /** Instante local en el que se recibió la respuesta. */
  receivedAtMs: number;
}

export type Fetcher = (url: string) => Promise<FetchedDocument>;

/** Descarga por HTTPS (HTTP solo en localhost; file: para despliegues offline). */
export const defaultFetcher: Fetcher = async (url: string) => {
  const parsed = new URL(url);
  if (parsed.protocol === 'file:') {
    return { body: await fs.promises.readFile(parsed, 'utf-8'), receivedAtMs: Date.now() };
  }
  const isLocal = ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname);
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && isLocal)) {
    throw new RegistryError(`Esquema no permitido para el registro de claves: ${parsed.protocol}`);
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { 'cache-control': 'no-cache' } });
    if (!res.ok) {
      throw new RegistryError(`El registro respondió HTTP ${res.status}.`);
    }
    const body = await res.text();
    const receivedAtMs = Date.now();
    const dateHeader = res.headers.get('date');
    const serverDateMs = dateHeader ? Date.parse(dateHeader) : undefined;
    return { body, receivedAtMs, serverDateMs: Number.isNaN(serverDateMs) ? undefined : serverDateMs };
  } finally {
    clearTimeout(timer);
  }
};

export interface RegistryResolution {
  registry: KeyRegistry;
  fromCache: boolean;
  serverDateMs?: number;
  receivedAtMs?: number;
}

/**
 * Resuelve el registro con caché local. Como el registro está firmado por
 * la raíz institucional, la copia en disco se revalida al leerla y puede
 * usarse sin riesgo cuando la red del laboratorio no está disponible.
 */
export class RegistryResolver {
  constructor(
    private readonly anchors: TrustAnchor[],
    private readonly cacheDir: string,
    private readonly fetcher: Fetcher = defaultFetcher
  ) {}

  private cachePath(url: string): string {
    return path.join(this.cacheDir, `registry-${sha256Hex(url).slice(0, 16)}.json`);
  }

  public async resolve(url: string): Promise<RegistryResolution> {
    let networkError: unknown;
    try {
      const doc = await this.fetcher(url);
      const registry = verifyRegistry(JSON.parse(doc.body), this.anchors);
      await fs.promises.mkdir(this.cacheDir, { recursive: true });
      await fs.promises.writeFile(this.cachePath(url), doc.body, 'utf-8');
      return { registry, fromCache: false, serverDateMs: doc.serverDateMs, receivedAtMs: doc.receivedAtMs };
    } catch (e) {
      if (e instanceof RegistryError && !/HTTP|Esquema/.test(e.message)) {
        // Firma inválida o raíz desconocida: nunca degradar a la caché.
        throw e;
      }
      networkError = e;
    }
    try {
      const cached = await fs.promises.readFile(this.cachePath(url), 'utf-8');
      return { registry: verifyRegistry(JSON.parse(cached), this.anchors), fromCache: true };
    } catch {
      throw new RegistryError(
        `No se pudo obtener el registro de claves (${(networkError as Error)?.message ?? 'error desconocido'}) y no hay copia local válida.`
      );
    }
  }
}
