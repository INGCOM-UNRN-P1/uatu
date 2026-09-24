import { spawnSync } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { canonicalBytes, omitKey } from '../src/core/canonicalJson';
import { exportRawPublicKey } from '../src/crypto/cryptoEngine';
import { KeyRegistry, TrustAnchor } from '../src/config/registry';

export interface TestPki {
  root: crypto.KeyObject;
  anchors: TrustAnchor[];
  teacherSign: crypto.KeyObject;
  teacherVerifyHex: string;
  teacherDecrypt: crypto.KeyObject;
  teacherEncryptHex: string;
  registry: KeyRegistry;
}

export function makePki(keyId = 'prof-lead-2026'): TestPki {
  const root = crypto.generateKeyPairSync('ed25519');
  const sign = crypto.generateKeyPairSync('ed25519');
  const enc = crypto.generateKeyPairSync('x25519');
  const anchors = [{ key_id: 'root-test', ed25519_public_key: exportRawPublicKey(root.publicKey).toString('hex') }];
  const teacherVerifyHex = exportRawPublicKey(sign.publicKey).toString('hex');
  const teacherEncryptHex = exportRawPublicKey(enc.publicKey).toString('hex');
  const unsigned = {
    version: '1',
    issued_at_utc: '2026-01-01T00:00:00Z',
    root_key_id: 'root-test',
    teachers: {
      [keyId]: { ed25519_verify_key: teacherVerifyHex, x25519_encryption_key: teacherEncryptHex },
    },
  };
  const signature = crypto.sign(null, canonicalBytes(unsigned), root.privateKey).toString('hex');
  return {
    root: root.privateKey,
    anchors,
    teacherSign: sign.privateKey,
    teacherVerifyHex,
    teacherDecrypt: enc.privateKey,
    teacherEncryptHex,
    registry: { ...unsigned, signature },
  };
}

export function baseManifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: '2.1',
    exam_id: 'eval-test',
    session: {
      start_utc: '2026-09-24T13:00:00Z',
      deadline_utc: '2026-09-24T16:00:00Z',
      batch_interval_seconds: 30,
      batch_max_events: 20,
      sync_max_backoff_seconds: 60,
      heartbeat_interval_seconds: 120,
    },
    auth: { public_key_registry_url: 'https://example.invalid/keys.json', require_github_auth: true },
    monitoring: {
      clipboard: { enabled: true, character_threshold: 15, encrypt_content: true, hash_algorithm: 'sha256' },
      window_focus: true,
      disallowed_extensions: ['github.copilot'],
    },
    crypto: { teacher_key_id: 'prof-lead-2026', signature: 'sin-firmar' },
    git: { telemetry_branch_prefix: 'uatu-audit', remote_name: 'origin', auto_push: true },
    ...overrides,
  };
}

export function signManifest(manifest: Record<string, unknown>, key: crypto.KeyObject): Record<string, unknown> {
  const sig = crypto.sign(null, canonicalBytes(omitKey(manifest, 'crypto')), key).toString('hex');
  const cryptoBlock = manifest.crypto as Record<string, unknown>;
  return { ...manifest, crypto: { ...cryptoBlock, signature: sig } };
}

export function tmpDir(prefix = 'uatu-test-'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}


const CLI_DIR = path.resolve(__dirname, '..', '..', '..', 'cli');
const AUDIT_MODULE = path.join(CLI_DIR, 'src', 'uatu_tools', 'audit.py');

/**
 * Comando para ejecutar el validador forense: `uv run --project cli uatu-audit`
 * si uv está disponible; si no, el módulo autocontenido con python3.
 * Devuelve undefined si no hay forma de ejecutarlo (la prueba se omite).
 */
export function auditCommand(): { cmd: string; args: string[] } | undefined {
  if (spawnSync('uv', ['--version']).status === 0) {
    return { cmd: 'uv', args: ['run', '--quiet', '--project', CLI_DIR, 'uatu-audit'] };
  }
  if (spawnSync('python3', ['-c', 'import cryptography']).status === 0) {
    return { cmd: 'python3', args: [AUDIT_MODULE] };
  }
  return undefined;
}
