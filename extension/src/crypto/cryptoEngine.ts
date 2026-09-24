import * as crypto from 'crypto';

/**
 * Motor criptográfico de uatu (Sección 5).
 *
 *  - Cifrado híbrido ECIES: X25519 + HKDF-SHA256 + AES-256-GCM.
 *  - Firmas Ed25519 sobre hashes de la cadena y sobre mensajes canónicos.
 *
 * Todas las claves públicas se intercambian en formato crudo (32 bytes) y
 * se convierten internamente a SubjectPublicKeyInfo DER, que es lo que
 * exige la API de Node.
 */

export const ENVELOPE_ALGORITHM = 'X25519-AES-256-GCM';
export const HKDF_INFO = 'uatu-clipboard-envelope-v2';
export const STUDENT_KEY_PREFIX = 'ed25519:';

export interface EncryptedPayload {
  algorithm: string;
  ephemeral_public_key: string;
  iv: string;
  auth_tag: string;
  ciphertext_base64: string;
}

// Prefijos DER fijos para claves de 32 bytes (RFC 8410).
const X25519_SPKI_PREFIX = Buffer.from('302a300506032b656e032100', 'hex');
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const X25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b656e04220420', 'hex');

export type KeyKind = 'x25519' | 'ed25519';

function spkiPrefix(kind: KeyKind): Buffer {
  return kind === 'x25519' ? X25519_SPKI_PREFIX : ED25519_SPKI_PREFIX;
}

/** Convierte una clave pública cruda de 32 bytes a SPKI DER. */
export function rawPublicKeyToDer(raw: Buffer, kind: KeyKind): Buffer {
  if (raw.length !== 32) {
    throw new Error(`Clave pública ${kind} inválida: se esperaban 32 bytes y se recibieron ${raw.length}.`);
  }
  return Buffer.concat([spkiPrefix(kind), raw]);
}

/** Acepta una clave pública cruda (32 bytes) o SPKI DER y devuelve un KeyObject. */
export function importPublicKey(material: Buffer, kind: KeyKind): crypto.KeyObject {
  const der = material.length === 32 ? rawPublicKeyToDer(material, kind) : material;
  const key = crypto.createPublicKey({ key: der, format: 'der', type: 'spki' });
  if (key.asymmetricKeyType !== kind) {
    throw new Error(`Tipo de clave inesperado: ${key.asymmetricKeyType} (se esperaba ${kind}).`);
  }
  return key;
}

/** Exporta una clave pública a sus 32 bytes crudos. */
export function exportRawPublicKey(key: crypto.KeyObject): Buffer {
  const der = key.export({ format: 'der', type: 'spki' });
  return Buffer.from(der.subarray(der.length - 32));
}

export function sha256(data: Buffer | string): Buffer {
  return crypto.createHash('sha256').update(data).digest();
}

export function sha256Hex(data: Buffer | string): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}

/** Sobrescribe con ceros un buffer con material secreto. */
export function zeroize(...buffers: Array<Buffer | Uint8Array | undefined>): void {
  for (const b of buffers) {
    if (b) {
      b.fill(0);
    }
  }
}

export interface StudentKeyPair {
  /** Clave privada Ed25519 en PKCS#8 DER. */
  privateKeyDer: Buffer;
  /** Clave pública Ed25519 cruda en hexadecimal (64 caracteres). */
  publicKeyHex: string;
}

export class UatuCryptoEngine {
  /** Genera el par Ed25519 del estudiante para la sesión. */
  public static generateStudentKeyPair(): StudentKeyPair {
    const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
    return {
      privateKeyDer: privateKey.export({ format: 'der', type: 'pkcs8' }) as Buffer,
      publicKeyHex: exportRawPublicKey(publicKey).toString('hex'),
    };
  }

  /** Deriva la clave pública cruda (hex) a partir de la privada PKCS#8. */
  public static studentPublicKeyHex(privateKeyDer: Buffer): string {
    const priv = crypto.createPrivateKey({ key: privateKeyDer, format: 'der', type: 'pkcs8' });
    return exportRawPublicKey(crypto.createPublicKey(priv)).toString('hex');
  }

  /**
   * Cifra el contenido del portapapeles utilizando X25519 y AES-256-GCM
   * (Sección 5.1). Acepta la clave pública docente cruda o en SPKI DER.
   */
  public static encryptClipboard(plaintext: string, teacherPublicKey: Buffer): EncryptedPayload {
    const teacherPubKey = importPublicKey(teacherPublicKey, 'x25519');

    // 1. Par efímero X25519 construido desde 32 bytes aleatorios para poder
    //    destruir el escalar privado al finalizar.
    const ephSecret = crypto.randomBytes(32);
    const ephPkcs8 = Buffer.concat([X25519_PKCS8_PREFIX, ephSecret]);
    const ephPrivKey = crypto.createPrivateKey({ key: ephPkcs8, format: 'der', type: 'pkcs8' });
    const ephPubRaw = exportRawPublicKey(crypto.createPublicKey(ephPrivKey));

    let sharedSecret: Buffer | undefined;
    let symmetricKey: Buffer | undefined;
    try {
      // 2. Acuerdo Diffie-Hellman.
      sharedSecret = crypto.diffieHellman({ privateKey: ephPrivKey, publicKey: teacherPubKey });

      // 3. HKDF-SHA256 (salt vacío, info de dominio) -> 256 bits.
      symmetricKey = Buffer.from(
        crypto.hkdfSync('sha256', sharedSecret, Buffer.alloc(0), Buffer.from(HKDF_INFO, 'utf-8'), 32)
      );

      // 4. AES-256-GCM con IV aleatorio de 12 bytes y sin AAD.
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv('aes-256-gcm', symmetricKey, iv);
      const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf-8'), cipher.final()]);
      const authTag = cipher.getAuthTag();

      return {
        algorithm: ENVELOPE_ALGORITHM,
        ephemeral_public_key: ephPubRaw.toString('base64'),
        iv: iv.toString('base64'),
        auth_tag: authTag.toString('base64'),
        ciphertext_base64: ciphertext.toString('base64'),
      };
    } finally {
      // 5. Destrucción de secretos (best-effort: el KeyObject interno de
      //    OpenSSL no es accesible desde JavaScript).
      zeroize(ephSecret, ephPkcs8, sharedSecret, symmetricKey);
    }
  }

  /**
   * Descifra un sobre con la clave privada X25519 docente (PKCS#8 DER o PEM).
   * La extensión no lo usa en producción; existe para pruebas y herramientas.
   */
  public static decryptClipboard(payload: EncryptedPayload, teacherPrivateKey: Buffer | string): string {
    if (payload.algorithm !== ENVELOPE_ALGORITHM) {
      throw new Error(`Algoritmo de sobre no soportado: ${payload.algorithm}.`);
    }
    const priv =
      typeof teacherPrivateKey === 'string'
        ? crypto.createPrivateKey(teacherPrivateKey)
        : crypto.createPrivateKey({ key: teacherPrivateKey, format: 'der', type: 'pkcs8' });
    const ephRaw = Buffer.from(payload.ephemeral_public_key, 'base64');
    const ephPub = importPublicKey(ephRaw.length === 32 ? ephRaw : ephRaw.subarray(ephRaw.length - 32), 'x25519');
    const shared = crypto.diffieHellman({ privateKey: priv, publicKey: ephPub });
    const key = Buffer.from(crypto.hkdfSync('sha256', shared, Buffer.alloc(0), Buffer.from(HKDF_INFO, 'utf-8'), 32));
    try {
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(payload.iv, 'base64'));
      decipher.setAuthTag(Buffer.from(payload.auth_tag, 'base64'));
      return Buffer.concat([
        decipher.update(Buffer.from(payload.ciphertext_base64, 'base64')),
        decipher.final(),
      ]).toString('utf-8');
    } finally {
      zeroize(shared, key);
    }
  }

  /** Firma el hash acumulado (32 bytes, en hex) con la clave Ed25519 del estudiante. */
  public static signHash(hashHex: string, studentPrivateKeyDer: Buffer): string {
    if (!/^[0-9a-f]{64}$/.test(hashHex)) {
      throw new Error('signHash espera un hash SHA-256 en hexadecimal.');
    }
    const privKey = crypto.createPrivateKey({ key: studentPrivateKeyDer, format: 'der', type: 'pkcs8' });
    return crypto.sign(null, Buffer.from(hashHex, 'hex'), privKey).toString('hex');
  }

  /** Verifica una firma Ed25519 sobre un hash SHA-256 en hex. */
  public static verifyHash(hashHex: string, signatureHex: string, publicKeyHex: string): boolean {
    return UatuCryptoEngine.verifyMessage(Buffer.from(hashHex, 'hex'), signatureHex, publicKeyHex);
  }

  /** Verifica una firma Ed25519 sobre un mensaje arbitrario. */
  public static verifyMessage(message: Buffer, signatureHex: string, publicKeyHex: string): boolean {
    try {
      if (!/^[0-9a-fA-F]{128}$/.test(signatureHex)) {
        return false;
      }
      const pub = importPublicKey(Buffer.from(publicKeyHex, 'hex'), 'ed25519');
      return crypto.verify(null, message, pub, Buffer.from(signatureHex, 'hex'));
    } catch {
      return false;
    }
  }

  /** Firma un mensaje arbitrario (utilidad para pruebas y herramientas docentes). */
  public static signMessage(message: Buffer, privateKey: Buffer | crypto.KeyObject): string {
    const key =
      privateKey instanceof Buffer ? crypto.createPrivateKey({ key: privateKey, format: 'der', type: 'pkcs8' }) : privateKey;
    return crypto.sign(null, message, key).toString('hex');
  }
}
