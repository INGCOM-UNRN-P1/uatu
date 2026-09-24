import { canonicalBytes, omitKey } from '../core/canonicalJson';
import { isoUtc } from '../core/time';
import { sha256Hex, STUDENT_KEY_PREFIX, UatuCryptoEngine } from '../crypto/cryptoEngine';
import { AuditEvent, EventData, EventType, UnsignedAuditEvent } from './events';

/**
 * Cadena de hashes firmada (Sección 5.2).
 *
 *   H_0 = SHA-256(Initial_Commit_SHA || SHA-256(.uatu.conf) || GitHub_User || Student_Pubkey)
 *   H_i = SHA-256(Serialize(evento_i sin firma))
 *
 * Como cada evento contiene `prev_hash = H_{i-1}`, `timestamp_utc = T_i` y
 * sus datos, H_i es la instanciación canónica de
 * SHA-256(H_{i-1} || T_i || Serialize(EventData_i)).
 *
 *   Sig_i = Ed25519_Sign(StudentPrivKey, H_i)   (sobre los 32 bytes de H_i)
 */

export const EMPTY_COMMIT_SHA = '0'.repeat(40);

export interface GenesisInput {
  initialCommitSha: string;
  configSha256: string;
  githubUser: string;
  studentPublicKeyHex: string;
}

/** Concatena los componentes como texto UTF-8 (los hex tienen longitud fija). */
export function computeGenesisHash(g: GenesisInput): string {
  return sha256Hex(g.initialCommitSha + g.configSha256 + g.githubUser + g.studentPublicKeyHex);
}

export function computeEventHash(event: UnsignedAuditEvent | AuditEvent): string {
  const unsigned = 'signature' in event ? omitKey(event, 'signature') : event;
  return sha256Hex(canonicalBytes(unsigned));
}

export interface ChainState {
  nextSequence: number;
  lastHash: string;
}

export class HashChain {
  private state: ChainState;
  private readonly studentKeyTag: string;

  constructor(
    private readonly privateKeyDer: Buffer,
    publicKeyHex: string,
    initial: ChainState
  ) {
    this.studentKeyTag = STUDENT_KEY_PREFIX + publicKeyHex;
    this.state = { ...initial };
  }

  public get snapshot(): ChainState {
    return { ...this.state };
  }

  /** Crea, encadena y firma el siguiente evento. */
  public append(eventType: EventType, data: EventData, timestampMs: number): AuditEvent {
    const unsigned: UnsignedAuditEvent = {
      sequence_id: this.state.nextSequence,
      prev_hash: this.state.lastHash,
      timestamp_utc: isoUtc(timestampMs),
      student_public_key: this.studentKeyTag,
      event_type: eventType,
      data,
    };
    const hash = computeEventHash(unsigned);
    const signature = UatuCryptoEngine.signHash(hash, this.privateKeyDer);
    this.state = { nextSequence: this.state.nextSequence + 1, lastHash: hash };
    return { ...unsigned, signature };
  }
}

/** Verificación local de una secuencia de eventos (usada en pruebas y autodiagnóstico). */
export function verifyEventChain(events: AuditEvent[], expectedGenesis: string): string[] {
  const errors: string[] = [];
  let prev = expectedGenesis;
  events.forEach((ev, idx) => {
    if (ev.sequence_id !== idx) {
      errors.push(`sequence_id ${ev.sequence_id} fuera de orden (esperado ${idx}).`);
    }
    if (ev.prev_hash !== prev) {
      errors.push(`Ruptura de cadena en seq ${ev.sequence_id}.`);
    }
    const hash = computeEventHash(ev);
    const pub = ev.student_public_key.replace(STUDENT_KEY_PREFIX, '');
    if (!UatuCryptoEngine.verifyHash(hash, ev.signature, pub)) {
      errors.push(`Firma inválida en seq ${ev.sequence_id}.`);
    }
    prev = hash;
  });
  return errors;
}
