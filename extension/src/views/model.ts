import { AuditEvent, EventType } from '../audit/events';
import { computeEventHash } from '../audit/hashChain';
import { AuditStats } from '../session/auditSession';
import { BatchRecord, TransactionState } from '../storage/wal';

/**
 * Modelo del panel lateral de uatu, independiente de la API de VS Code.
 *
 * El controlador produce una instantánea (UatuSnapshot) y estas funciones la
 * transforman en árboles de nodos (ViewNode) que la capa de VS Code solo
 * traduce a TreeItems. Así la presentación se prueba sin el editor.
 */

export type ViewPhase = 'idle' | 'error' | 'standby' | 'active' | 'declined' | 'concluded';

export interface ExamView {
  examId: string;
  startMs: number;
  deadlineMs: number;
  teacherKeyId: string;
  registryUrl: string;
  manifestPath: string;
  clipboard: { enabled: boolean; threshold: number; encrypt: boolean };
  windowFocus: boolean;
  disallowedExtensions: string[];
  heartbeatSeconds: number;
  batchIntervalSeconds: number;
  batchMaxEvents: number;
  autoPush: boolean;
  remote: string;
  branchPrefix: string;
}

export interface SessionView {
  uuid: string;
  user: string;
  ref: string;
  studentPublicKey: string;
  genesisHash: string;
  createdMs: number;
  directory: string;
  closedReason?: string;
  stats: AuditStats;
}

export interface MonitorView {
  focused: boolean;
  unfocusedTotalMs: number;
  lastHeartbeatMs?: number;
  extensions: { id: string; state: 'installed' | 'active' | 'removed' }[];
  insertions: number;
}

export interface LoggedEvent {
  event: AuditEvent;
  state?: TransactionState;
  batch?: number;
}

export interface UatuSnapshot {
  nowMs: number;
  phase: ViewPhase;
  message?: string;
  exam?: ExamView;
  clock: { source: string; offsetMs: number };
  session?: SessionView;
  monitors?: MonitorView;
  events: LoggedEvent[];
  batches: BatchRecord[];
}

export interface ViewNode {
  id: string;
  label: string;
  description?: string;
  /** Tooltip en Markdown. */
  tooltip?: string;
  /** Nombre de codicon. */
  icon?: string;
  /** Identificador de ThemeColor para el ícono. */
  color?: string;
  children?: ViewNode[];
  expanded?: boolean;
  contextValue?: string;
  /** Evento asociado (para los comandos contextuales de la bitácora). */
  eventSeq?: number;
  sessionUuid?: string;
}

export type LogGrouping = 'batch' | 'type' | 'time';

// ---------------------------------------------------------------- formato

export function formatUtc(ms: number, withDate = false): string {
  const iso = new Date(ms).toISOString();
  const time = iso.slice(11, 19);
  return withDate ? `${iso.slice(8, 10)}/${iso.slice(5, 7)} ${iso.slice(11, 16)}` : time;
}

export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const d = Math.floor(total / 86400);
  const h = Math.floor((total % 86400) / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (d > 0) {
    return `${d} d ${h} h`;
  }
  if (h > 0) {
    return `${h} h ${m} min`;
  }
  if (m > 0) {
    return `${m} min${s ? ` ${s} s` : ''}`;
  }
  return `${s} s`;
}

function short(hex: string, n = 12): string {
  return hex.length > n ? `${hex.slice(0, n)}…` : hex;
}

const STATE_LABEL: Record<TransactionState, string> = {
  RECORDED: 'registrado',
  BATCHED: 'en lote',
  SYNCED: 'sincronizado',
};

const PHASE: Record<ViewPhase, { label: string; icon: string; color?: string }> = {
  idle: { label: 'Inactivo', icon: 'shield' },
  error: { label: 'Error de integridad', icon: 'error', color: 'charts.red' },
  standby: { label: 'Esperando inicio', icon: 'clock', color: 'charts.yellow' },
  active: { label: 'Sesión activa', icon: 'shield', color: 'charts.green' },
  declined: { label: 'Consentimiento pendiente', icon: 'circle-slash', color: 'charts.yellow' },
  concluded: { label: 'Examen concluido', icon: 'check', color: 'charts.blue' },
};

// ---------------------------------------------------------------- eventos

interface EventStyle {
  title: string;
  icon: string;
  color?: string;
}

export const EVENT_STYLES: Record<EventType, EventStyle> = {
  session_start: { title: 'Inicio de sesión', icon: 'debug-start', color: 'charts.green' },
  clipboard_paste: { title: 'Pegado del portapapeles', icon: 'clippy', color: 'charts.orange' },
  external_insertion: { title: 'Inserción externa', icon: 'diff-added', color: 'charts.red' },
  window_focus: { title: 'Foco de ventana', icon: 'eye' },
  disallowed_extension: { title: 'Extensión no permitida', icon: 'extensions', color: 'charts.red' },
  heartbeat: { title: 'Latido', icon: 'pulse', color: 'disabledForeground' },
  clock_skew: { title: 'Desfase de reloj', icon: 'watch', color: 'charts.yellow' },
  config_changed: { title: 'Cambio de .uatu.conf', icon: 'gear', color: 'charts.red' },
  session_end: { title: 'Fin de sesión', icon: 'debug-stop', color: 'charts.blue' },
};

function styleFor(ev: AuditEvent): EventStyle {
  const base = EVENT_STYLES[ev.event_type] ?? { title: ev.event_type, icon: 'circle' };
  if (ev.event_type === 'window_focus') {
    return ev.data.focused
      ? { title: 'Foco recuperado', icon: 'eye' }
      : { title: 'Foco perdido', icon: 'eye-closed', color: 'charts.yellow' };
  }
  return base;
}

/** Resumen de una línea de los datos del evento. */
export function summarizeEvent(ev: AuditEvent): string {
  const d = ev.data as Record<string, unknown>;
  switch (ev.event_type) {
    case 'session_start':
      return `@${d.github_user} · ${d.exam_id}`;
    case 'clipboard_paste':
    case 'external_insertion': {
      const where = d.window_focused === false ? ' · sin foco' : '';
      return `${d.target_file} · ${d.char_count} car.${where}`;
    }
    case 'window_focus':
      return d.focused
        ? `fuera ${formatDuration(Number(d.unfocused_ms ?? 0))} · total ${formatDuration(Number(d.unfocused_total_ms ?? 0))}`
        : `total fuera ${formatDuration(Number(d.unfocused_total_ms ?? 0))}`;
    case 'disallowed_extension': {
      const state = { installed: 'instalada', active: 'activa', removed: 'quitada' }[String(d.state)] ?? String(d.state);
      return `${d.extension_id} (${state})`;
    }
    case 'heartbeat':
      return `activa ${formatDuration(Number(d.uptime_seconds ?? 0) * 1000)}`;
    case 'clock_skew':
      return `${Math.round(Number(d.offset_ms ?? 0) / 1000)} s (${d.source})`;
    case 'config_changed':
      return d.deleted ? 'manifiesto eliminado' : d.signature_valid ? 'firma válida' : 'firma inválida';
    case 'session_end':
      return String(d.reason ?? '');
    default:
      return '';
  }
}

function describeValue(key: string, value: unknown): string {
  if (key === 'encrypted_payload' && value && typeof value === 'object') {
    const env = value as Record<string, string>;
    const bytes = Math.floor(((env.ciphertext_base64 ?? '').length * 3) / 4);
    return `${env.algorithm} · ${bytes} B cifrados`;
  }
  if (key === 'range' && value && typeof value === 'object') {
    const r = value as { start: number[]; end: number[] };
    return `L${r.start[0] + 1}:${r.start[1] + 1} → L${r.end[0] + 1}:${r.end[1] + 1}`;
  }
  if (typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)) {
    return short(value, 16);
  }
  return typeof value === 'object' ? JSON.stringify(value) : String(value);
}

function eventTooltip(item: LoggedEvent): string {
  const ev = item.event;
  const style = styleFor(ev);
  const rows = Object.entries(ev.data).map(([k, v]) => `| \`${k}\` | ${describeValue(k, v).replace(/\|/g, '\\|')} |`);
  return [
    `**${style.title}** · seq ${ev.sequence_id}`,
    '',
    `| | |`,
    `|---|---|`,
    `| Hora (UTC) | ${ev.timestamp_utc} |`,
    `| Estado | ${item.state ? STATE_LABEL[item.state] : '—'}${item.batch !== undefined ? ` (lote ${item.batch})` : ''} |`,
    `| Hash H_i | \`${short(computeEventHash(ev), 20)}\` |`,
    `| prev_hash | \`${short(ev.prev_hash, 20)}\` |`,
    `| Firma | \`${short(ev.signature, 20)}\` |`,
    ...rows,
  ].join('\n');
}

function eventNode(item: LoggedEvent, sessionUuid: string | undefined, showState: boolean): ViewNode {
  const ev = item.event;
  const style = styleFor(ev);
  const summary = summarizeEvent(ev);
  const state = showState && item.state ? ` · ${STATE_LABEL[item.state]}` : '';
  const children: ViewNode[] = Object.entries(ev.data).map(([k, v]) => ({
    id: `ev-${ev.sequence_id}-${k}`,
    label: k,
    description: describeValue(k, v),
    icon: k === 'encrypted_payload' ? 'lock' : 'symbol-field',
  }));
  children.push(
    { id: `ev-${ev.sequence_id}-hash`, label: 'hash', description: short(computeEventHash(ev), 24), icon: 'key' },
    { id: `ev-${ev.sequence_id}-prev`, label: 'prev_hash', description: short(ev.prev_hash, 24), icon: 'link' },
    { id: `ev-${ev.sequence_id}-sig`, label: 'firma', description: short(ev.signature, 24), icon: 'verified' }
  );
  return {
    id: `ev-${ev.sequence_id}`,
    label: `${formatUtc(Date.parse(ev.timestamp_utc))}  ${style.title}`,
    description: summary + state,
    tooltip: eventTooltip(item),
    icon: style.icon,
    color: style.color,
    children,
    contextValue: 'uatu.event',
    eventSeq: ev.sequence_id,
    sessionUuid,
  };
}

// ---------------------------------------------------------------- bitácora

export function buildLogTree(s: UatuSnapshot, grouping: LogGrouping): ViewNode[] {
  if (s.events.length === 0) {
    return [];
  }
  const sid = s.session?.uuid;
  if (grouping === 'time') {
    return [...s.events].reverse().map((e) => eventNode(e, sid, true));
  }
  if (grouping === 'type') {
    const groups = new Map<string, LoggedEvent[]>();
    for (const e of s.events) {
      groups.set(e.event.event_type, [...(groups.get(e.event.event_type) ?? []), e]);
    }
    return [...groups.entries()]
      .sort((a, b) => b[1].length - a[1].length)
      .map(([type, items]) => {
        const style = EVENT_STYLES[type as EventType] ?? { title: type, icon: 'circle' };
        return {
          id: `type-${type}`,
          label: style.title,
          description: `${items.length}`,
          icon: style.icon,
          color: style.color,
          children: [...items].reverse().map((e) => eventNode(e, sid, true)),
        };
      });
  }
  // Por lote: primero lo pendiente, luego los lotes del más nuevo al más viejo.
  const nodes: ViewNode[] = [];
  const pending = s.events.filter((e) => e.batch === undefined);
  if (pending.length > 0) {
    nodes.push({
      id: 'batch-pending',
      label: 'Pendientes de lote',
      description: `${pending.length} evento(s) registrados`,
      tooltip: 'Eventos firmados y asentados en el WAL local que aún no se empaquetaron en un lote.',
      icon: 'circle-large-outline',
      color: 'charts.yellow',
      expanded: true,
      children: pending.map((e) => eventNode(e, sid, false)),
    });
  }
  for (const b of [...s.batches].reverse()) {
    const items = s.events.filter((e) => e.batch === b.batch_sequence_id);
    nodes.push({
      id: `batch-${b.batch_sequence_id}`,
      label: `Lote ${b.batch_sequence_id}`,
      description: `${items.length} evento(s) · ${b.synced ? 'sincronizado' : 'sin sincronizar'}`,
      tooltip: [
        `**Lote ${b.batch_sequence_id}** · \`${b.file}\``,
        '',
        `Eventos ${b.first_seq}–${b.last_seq}.`,
        b.synced ? `Sincronizado en el commit \`${short(b.commit ?? '', 12)}\`.` : 'Confirmado localmente; pendiente de push.',
      ].join('\n'),
      icon: b.synced ? 'cloud' : 'cloud-upload',
      color: b.synced ? 'charts.green' : 'charts.yellow',
      expanded: b.batch_sequence_id === s.batches.length - 1 && pending.length === 0,
      children: items.map((e) => eventNode(e, sid, false)),
    });
  }
  return nodes;
}

// ---------------------------------------------------------------- estado

function leaf(id: string, label: string, description: string, icon: string, extra: Partial<ViewNode> = {}): ViewNode {
  return { id, label, description, icon, ...extra };
}

function countdown(s: UatuSnapshot): string | undefined {
  if (!s.exam) {
    return undefined;
  }
  if (s.phase === 'standby') {
    return `inicia en ${formatDuration(s.exam.startMs - s.nowMs)}`;
  }
  if (s.phase === 'active' || s.phase === 'declined') {
    return `cierra en ${formatDuration(s.exam.deadlineMs - s.nowMs)}`;
  }
  return undefined;
}

export function buildStatusTree(s: UatuSnapshot): ViewNode[] {
  const phase = PHASE[s.phase];
  const nodes: ViewNode[] = [
    {
      id: 'st-phase',
      label: phase.label,
      description: countdown(s) ?? (s.phase === 'error' ? s.message : undefined),
      tooltip: s.message,
      icon: phase.icon,
      color: phase.color,
    },
  ];
  const e = s.exam;
  if (e) {
    nodes.push({
      id: 'st-exam',
      label: 'Examen',
      description: e.examId,
      icon: 'mortar-board',
      expanded: true,
      children: [
        leaf('st-exam-window', 'Ventana', `${formatUtc(e.startMs, true)} → ${formatUtc(e.deadlineMs, true)} UTC`, 'calendar'),
        leaf('st-exam-teacher', 'Docente', e.teacherKeyId, 'account', { tooltip: 'crypto.teacher_key_id del manifiesto firmado' }),
        leaf('st-exam-registry', 'Registro de claves', safeHost(e.registryUrl), 'key', { tooltip: e.registryUrl }),
        leaf('st-exam-manifest', 'Manifiesto', '.uatu.conf', 'file', { tooltip: e.manifestPath }),
      ],
    });
  }
  const ses = s.session;
  if (ses) {
    nodes.push({
      id: 'st-session',
      label: 'Sesión',
      description: ses.closedReason ? `cerrada (${ses.closedReason})` : `@${ses.user}`,
      icon: 'account',
      expanded: true,
      children: [
        leaf('st-ses-user', 'Usuario GitHub', `@${ses.user}`, 'github'),
        leaf('st-ses-uuid', 'Identificador', ses.uuid, 'symbol-key'),
        leaf('st-ses-ref', 'Rama de telemetría', ses.ref.replace(/^refs\/heads\//, ''), 'git-branch', { tooltip: ses.ref }),
        leaf('st-ses-key', 'Clave del estudiante', `ed25519:${short(ses.studentPublicKey, 16)}`, 'verified', {
          tooltip: `Ed25519 ${ses.studentPublicKey}`,
        }),
        leaf('st-ses-genesis', 'Génesis H₀', short(ses.genesisHash, 16), 'link', { tooltip: ses.genesisHash }),
        leaf('st-ses-start', 'Iniciada', `${formatUtc(ses.createdMs, true)} UTC`, 'history'),
      ],
    });
  }
  if (e) {
    const m = s.monitors;
    const monitorChildren: ViewNode[] = [];
    monitorChildren.push(
      leaf(
        'st-mon-clip',
        'Portapapeles',
        e.clipboard.enabled
          ? `> ${e.clipboard.threshold} car. · ${e.clipboard.encrypt ? 'cifrado' : 'solo hash'}${m ? ` · ${m.insertions} registrada(s)` : ''}`
          : 'desactivado',
        e.clipboard.enabled ? 'clippy' : 'circle-slash'
      )
    );
    monitorChildren.push(
      leaf(
        'st-mon-focus',
        'Foco de ventana',
        !e.windowFocus
          ? 'desactivado'
          : m
            ? `${m.focused ? 'en foco' : 'fuera de foco'} · fuera ${formatDuration(m.unfocusedTotalMs)}`
            : 'activo',
        m && !m.focused ? 'eye-closed' : 'eye',
        m && !m.focused ? { color: 'charts.yellow' } : {}
      )
    );
    const detected = new Map((m?.extensions ?? []).map((x) => [x.id, x.state]));
    const flagged = [...detected.values()].filter((st) => st !== 'removed').length;
    monitorChildren.push({
      id: 'st-mon-ext',
      label: 'Extensiones prohibidas',
      description: `${e.disallowedExtensions.length} en la lista${flagged ? ` · ${flagged} detectada(s)` : ''}`,
      icon: 'extensions',
      color: flagged ? 'charts.red' : undefined,
      children: e.disallowedExtensions.map((id) => {
        const st = detected.get(id);
        const label = st === 'active' ? 'activa' : st === 'installed' ? 'instalada' : st === 'removed' ? 'quitada' : 'no instalada';
        return leaf(`st-mon-ext-${id}`, id, label, st && st !== 'removed' ? 'warning' : 'pass', {
          color: st && st !== 'removed' ? 'charts.red' : 'charts.green',
        });
      }),
    });
    monitorChildren.push(
      leaf(
        'st-mon-hb',
        'Latido',
        `cada ${e.heartbeatSeconds} s${m?.lastHeartbeatMs ? ` · último hace ${formatDuration(s.nowMs - m.lastHeartbeatMs)}` : ''}`,
        'pulse'
      )
    );
    nodes.push({
      id: 'st-monitors',
      label: 'Monitores',
      description: s.phase === 'active' && s.monitors ? 'activos' : 'detenidos',
      icon: 'radio-tower',
      expanded: s.phase === 'active',
      children: monitorChildren,
    });
  }
  if (ses) {
    const st = ses.stats;
    const sync: ViewNode[] = [
      leaf('st-sync-events', 'Eventos', `${st.events} · ${st.pendingEvents} pendiente(s) de lote`, 'list-ordered'),
      leaf('st-sync-batches', 'Lotes', `${st.batches} · ${st.sync.pendingBatches} sin sincronizar`, 'package'),
      leaf('st-sync-remote', 'Remoto', e ? `${e.remote}${e.autoPush ? ' · push automático' : ' · sin push automático'}` : '—', 'repo'),
      leaf('st-sync-last', 'Último push', st.sync.lastSyncAtMs ? `${formatUtc(st.sync.lastSyncAtMs)} UTC` : 'nunca', 'cloud'),
    ];
    if (st.sync.lastError) {
      sync.push(leaf('st-sync-error', 'Última falla', st.sync.lastError, 'warning', { color: 'charts.red', tooltip: st.sync.lastError }));
    }
    if (st.sync.nextRetryAtMs) {
      sync.push(
        leaf('st-sync-retry', 'Próximo reintento', `en ${formatDuration(st.sync.nextRetryAtMs - s.nowMs)} (intento ${st.sync.attempt})`, 'sync')
      );
    }
    nodes.push({
      id: 'st-sync',
      label: 'Sincronización',
      description: st.sync.pendingBatches === 0 ? 'al día' : `${st.sync.pendingBatches} lote(s) pendiente(s)`,
      icon: st.sync.lastError ? 'cloud-upload' : 'cloud',
      color: st.sync.lastError ? 'charts.yellow' : undefined,
      expanded: Boolean(st.sync.lastError),
      children: sync,
    });
  }
  nodes.push(
    leaf(
      'st-clock',
      'Reloj',
      `${s.clock.source === 'http-date' ? 'calibrado (HTTP Date)' : 'local'} · desfase ${Math.round(s.clock.offsetMs / 1000)} s`,
      'watch',
      Math.abs(s.clock.offsetMs) >= 30_000 ? { color: 'charts.yellow' } : {}
    )
  );
  return nodes;
}

function safeHost(url: string): string {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}

/** Documento JSON con el detalle completo de un evento (sin contenido en claro: solo el sobre cifrado). */
export function renderEventDetail(item: LoggedEvent): string {
  return (
    JSON.stringify(
      {
        _uatu: {
          estado: item.state ? STATE_LABEL[item.state] : undefined,
          lote: item.batch,
          hash: computeEventHash(item.event),
        },
        ...item.event,
      },
      null,
      2
    ) + '\n'
  );
}
