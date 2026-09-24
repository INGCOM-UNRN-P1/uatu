import { EventData } from '../audit/events';
import { ClipboardSettings } from '../config/manifest';
import { sha256Hex, UatuCryptoEngine } from '../crypto/cryptoEngine';
import { DetectedInsertion, matchesClipboard } from './insertionDetector';

export interface InsertionContext {
  /** Ruta del archivo relativa al workspace (con separadores "/"). */
  targetFile: string;
  clipboardText: string;
  windowFocused: boolean;
  isActiveEditor: boolean;
}

export interface InsertionRecord {
  type: 'clipboard_paste' | 'external_insertion';
  data: EventData;
  plaintextSha256: string;
}

/**
 * Construye los metadatos del evento de inserción (RF-01): longitud, hash
 * SHA-256 del texto plano, rango, archivo relativo y sobre cifrado.
 *
 * El texto cifrado es exactamente lo que ingresó al documento. Cuando no
 * coincide con el portapapeles (inserción desde disco, autocompletado o
 * herramientas externas) se registra como `external_insertion` y del
 * portapapeles solo se guarda su hash, nunca su contenido.
 */
export function buildInsertionRecord(
  insertion: DetectedInsertion,
  ctx: InsertionContext,
  settings: ClipboardSettings,
  teacherEncryptionKey: Buffer
): InsertionRecord {
  const plaintext = insertion.texts.join('\n');
  const plaintextSha256 = sha256Hex(Buffer.from(plaintext, 'utf-8'));
  const fromClipboard = matchesClipboard(insertion.texts, ctx.clipboardText);
  const data: EventData = {
    target_file: ctx.targetFile,
    range: {
      start: [insertion.start.line, insertion.start.character],
      end: [insertion.end.line, insertion.end.character],
    },
    char_count: insertion.charCount,
    change_count: insertion.changeCount,
    sha256_plaintext: plaintextSha256,
    clipboard_match: fromClipboard,
    window_focused: ctx.windowFocused,
    active_editor: ctx.isActiveEditor,
  };
  if (!fromClipboard && ctx.clipboardText.length > 0) {
    data.clipboard_sha256 = sha256Hex(Buffer.from(ctx.clipboardText, 'utf-8'));
  }
  if (settings.encrypt_content) {
    data.encrypted_payload = { ...UatuCryptoEngine.encryptClipboard(plaintext, teacherEncryptionKey) };
  }
  return { type: fromClipboard ? 'clipboard_paste' : 'external_insertion', data, plaintextSha256 };
}
