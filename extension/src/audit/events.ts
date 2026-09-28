import { CanonicalValue } from '../core/canonicalJson';

/**
 * Tipos de eventos de telemetría registrados en la cadena.
 */
export type EventType =
  /** Primer evento de toda sesión: fija los datos del bloque génesis. */
  | 'session_start'
  /** Inserción masiva cuyo contenido coincide con el portapapeles. */
  | 'clipboard_paste'
  /** Inserción masiva que NO proviene del portapapeles (disco, autocompletado, IA...). */
  | 'external_insertion'
  | 'window_focus'
  | 'disallowed_extension'
  /** Configuración del editor que viola una regla del manifiesto (o que vuelve a cumplirla). */
  | 'disallowed_setting'
  | 'heartbeat'
  /** Desfase significativo entre el reloj local y la fuente confiable. */
  | 'clock_skew'
  /** El manifiesto cambió o desapareció durante la sesión. */
  | 'config_changed'
  | 'session_end';

/** Eventos que fuerzan un volcado inmediato del lote (sección 4, RF-03). */
export const PRIORITY_EVENTS: ReadonlySet<EventType> = new Set<EventType>([
  'session_start',
  'disallowed_extension',
  'disallowed_setting',
  'clock_skew',
  'config_changed',
  'session_end',
]);

export type EventData = { [key: string]: CanonicalValue };

export interface UnsignedAuditEvent {
  sequence_id: number;
  prev_hash: string;
  timestamp_utc: string;
  student_public_key: string;
  event_type: EventType;
  data: EventData;
}

export interface AuditEvent extends UnsignedAuditEvent {
  signature: string;
}
