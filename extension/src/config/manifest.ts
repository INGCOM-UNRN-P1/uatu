import { canonicalBytes, omitKey } from '../core/canonicalJson';
import { parseUtc } from '../core/time';
import { sha256Hex, UatuCryptoEngine } from '../crypto/cryptoEngine';

/**
 * Manifiesto declarativo `.uatu.conf` (Sección 3.2).
 */

export const MANIFEST_FILENAME = '.uatu.conf';
export const SUPPORTED_MANIFEST_VERSIONS = ['2.1'];

export interface SessionSettings {
  start_utc: string;
  deadline_utc: string;
  batch_interval_seconds: number;
  batch_max_events: number;
  sync_max_backoff_seconds: number;
  heartbeat_interval_seconds: number;
}

export interface AuthSettings {
  public_key_registry_url: string;
  require_github_auth: boolean;
}

export interface ClipboardSettings {
  enabled: boolean;
  character_threshold: number;
  encrypt_content: boolean;
  hash_algorithm: 'sha256';
}

export interface MonitoringSettings {
  clipboard: ClipboardSettings;
  window_focus: boolean;
  disallowed_extensions: string[];
}

export interface CryptoSettings {
  teacher_key_id: string;
  signature: string;
}

export interface GitSettings {
  telemetry_branch_prefix: string;
  remote_name: string;
  auto_push: boolean;
}

export interface UatuManifest {
  version: string;
  exam_id: string;
  session: SessionSettings;
  auth: AuthSettings;
  monitoring: MonitoringSettings;
  crypto: CryptoSettings;
  git: GitSettings;
}

/** Manifiesto validado junto con los valores derivados que usa el motor. */
export interface ParsedManifest {
  /** Objeto tal cual fue leído (base para la firma y el hash). */
  raw: Record<string, unknown>;
  /** Vista tipada con valores por omisión aplicados. */
  manifest: UatuManifest;
  startMs: number;
  deadlineMs: number;
  /** SHA-256 de la serialización canónica completa (incluye el bloque crypto). */
  sha256: string;
}

export class ManifestError extends Error {}

const REF_COMPONENT = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/;

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function section(raw: Record<string, unknown>, name: string, required: boolean): Record<string, unknown> {
  const value = raw[name];
  if (value === undefined && !required) {
    return {};
  }
  if (!isObject(value)) {
    throw new ManifestError(`La sección "${name}" es obligatoria y debe ser un objeto.`);
  }
  return value;
}

function str(obj: Record<string, unknown>, key: string, path: string, fallback?: string): string {
  const v = obj[key];
  if (v === undefined && fallback !== undefined) {
    return fallback;
  }
  if (typeof v !== 'string' || v.length === 0) {
    throw new ManifestError(`El campo ${path}.${key} debe ser una cadena no vacía.`);
  }
  return v;
}

function bool(obj: Record<string, unknown>, key: string, path: string, fallback: boolean): boolean {
  const v = obj[key];
  if (v === undefined) {
    return fallback;
  }
  if (typeof v !== 'boolean') {
    throw new ManifestError(`El campo ${path}.${key} debe ser booleano.`);
  }
  return v;
}

function int(
  obj: Record<string, unknown>,
  key: string,
  path: string,
  fallback: number,
  min: number,
  max: number
): number {
  const v = obj[key];
  if (v === undefined) {
    return fallback;
  }
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) {
    throw new ManifestError(`El campo ${path}.${key} debe ser un entero entre ${min} y ${max}.`);
  }
  return v;
}

function isRefPath(value: string): boolean {
  return value.split('/').every((part) => REF_COMPONENT.test(part) && !part.includes('..') && !part.endsWith('.lock'));
}

/** Parsea y valida estructuralmente el contenido de `.uatu.conf`. */
export function parseManifest(text: string): ParsedManifest {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new ManifestError(`.uatu.conf no es JSON válido: ${(e as Error).message}`);
  }
  if (!isObject(raw)) {
    throw new ManifestError('.uatu.conf debe contener un objeto JSON.');
  }

  const version = str(raw, 'version', '$');
  if (!SUPPORTED_MANIFEST_VERSIONS.includes(version)) {
    throw new ManifestError(`Versión de manifiesto no soportada: ${version}.`);
  }
  const examId = str(raw, 'exam_id', '$');
  if (!REF_COMPONENT.test(examId)) {
    throw new ManifestError('exam_id solo admite letras, dígitos, ".", "_" y "-".');
  }

  const s = section(raw, 'session', true);
  const a = section(raw, 'auth', true);
  const m = section(raw, 'monitoring', false);
  const c = section(raw, 'crypto', true);
  const g = section(raw, 'git', false);
  const clip = isObject(m.clipboard) ? m.clipboard : {};

  const session: SessionSettings = {
    start_utc: str(s, 'start_utc', 'session'),
    deadline_utc: str(s, 'deadline_utc', 'session'),
    batch_interval_seconds: int(s, 'batch_interval_seconds', 'session', 30, 1, 3600),
    batch_max_events: int(s, 'batch_max_events', 'session', 20, 1, 10000),
    sync_max_backoff_seconds: int(s, 'sync_max_backoff_seconds', 'session', 60, 2, 3600),
    heartbeat_interval_seconds: int(s, 'heartbeat_interval_seconds', 'session', 120, 5, 86400),
  };
  const startMs = parseUtc(session.start_utc, 'session.start_utc').getTime();
  const deadlineMs = parseUtc(session.deadline_utc, 'session.deadline_utc').getTime();
  if (deadlineMs <= startMs) {
    throw new ManifestError('session.deadline_utc debe ser posterior a session.start_utc.');
  }

  const auth: AuthSettings = {
    public_key_registry_url: str(a, 'public_key_registry_url', 'auth'),
    require_github_auth: bool(a, 'require_github_auth', 'auth', true),
  };

  const hashAlgorithm = str(clip, 'hash_algorithm', 'monitoring.clipboard', 'sha256');
  if (hashAlgorithm !== 'sha256') {
    throw new ManifestError(`monitoring.clipboard.hash_algorithm no soportado: ${hashAlgorithm} (solo sha256).`);
  }
  const disallowed = m.disallowed_extensions ?? [];
  if (!Array.isArray(disallowed) || !disallowed.every((x) => typeof x === 'string')) {
    throw new ManifestError('monitoring.disallowed_extensions debe ser una lista de identificadores.');
  }
  const monitoring: MonitoringSettings = {
    clipboard: {
      enabled: bool(clip, 'enabled', 'monitoring.clipboard', true),
      character_threshold: int(clip, 'character_threshold', 'monitoring.clipboard', 15, 1, 1_000_000),
      encrypt_content: bool(clip, 'encrypt_content', 'monitoring.clipboard', true),
      hash_algorithm: 'sha256',
    },
    window_focus: bool(m, 'window_focus', 'monitoring', true),
    disallowed_extensions: (disallowed as string[]).map((x) => x.toLowerCase()),
  };

  const cryptoSettings: CryptoSettings = {
    teacher_key_id: str(c, 'teacher_key_id', 'crypto'),
    signature: str(c, 'signature', 'crypto'),
  };

  const git: GitSettings = {
    telemetry_branch_prefix: str(g, 'telemetry_branch_prefix', 'git', 'uatu-audit'),
    remote_name: str(g, 'remote_name', 'git', 'origin'),
    auto_push: bool(g, 'auto_push', 'git', true),
  };
  if (!isRefPath(git.telemetry_branch_prefix)) {
    throw new ManifestError('git.telemetry_branch_prefix no es un nombre de referencia Git válido.');
  }
  if (!REF_COMPONENT.test(git.remote_name)) {
    throw new ManifestError('git.remote_name no es un nombre de remoto válido.');
  }

  let sha256: string;
  try {
    sha256 = sha256Hex(canonicalBytes(raw));
  } catch (e) {
    throw new ManifestError(`.uatu.conf contiene valores no canónicos: ${(e as Error).message}`);
  }

  return {
    raw,
    manifest: { version, exam_id: examId, session, auth, monitoring, crypto: cryptoSettings, git },
    startMs,
    deadlineMs,
    sha256,
  };
}

/** Bytes firmados por la cátedra: manifiesto canónico sin el bloque `crypto`. */
export function manifestSigningPayload(raw: Record<string, unknown>): Buffer {
  return canonicalBytes(omitKey(raw, 'crypto'));
}

/** Verifica la firma Ed25519 docente del manifiesto (Sección 3.3, punto 3). */
export function verifyManifestSignature(parsed: ParsedManifest, teacherVerifyKeyHex: string): boolean {
  return UatuCryptoEngine.verifyMessage(
    manifestSigningPayload(parsed.raw),
    parsed.manifest.crypto.signature,
    teacherVerifyKeyHex
  );
}
