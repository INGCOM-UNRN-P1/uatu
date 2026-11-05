import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { PaquetesSettings } from '../config/manifest';

/**
 * Paquete de examen por estudiante (`uatu-admin paquetes`, Ola 47). El formato
 * y los hashes son los de `uatu_tools.paquetes`.
 *
 * Lo que impide abrirlo antes de hora o abrir el de otro es del lado del
 * servidor: la clave llega al repositorio privado del estudiante recién en
 * start_utc. Los controles de acá dan evidencia para `uatu-audit`, no
 * seguridad: en su propio equipo, el estudiante puede saltearlos.
 */

export const ARCHIVO_PAQUETE = '.uatu-paquete.enc';
export const ARCHIVO_CLAVE = '.uatu-paquete.clave';
const FORMATO = 'uatu-paquete-v1';
const LARGO_ETIQUETA = 16;

export type MotivoRechazo =
  | 'usuario_sin_paquete'
  | 'paquete_de_otro'
  | 'paquete_no_sellado'
  | 'fuera_de_hora'
  | 'clave_incorrecta'
  | 'ruta_invalida';

export type ResultadoPaquete =
  /** Todavía no llegaron el paquete o la clave. */
  | { estado: 'pendiente' }
  | { estado: 'abierto'; sha256: string; escritos: string[]; conservados: string[] }
  | { estado: 'rechazado'; motivo: MotivoRechazo };

export interface AperturaPaquete {
  repoRoot: string;
  settings: PaquetesSettings;
  /** Usuario de la sesión de GitHub. */
  usuario: string;
  nowMs: number;
  startMs: number;
  deadlineMs: number;
  /** Si `nowMs` viene de un reloj calibrado contra el servidor. */
  relojCalibrado: boolean;
}

interface Paquete {
  formato: string;
  usuario: string;
  sha256: string;
  nonce: string;
  datos: string;
}

/** Mismo cálculo que `hash_archivos` de uatu-tools y `consignaTreeHash`. */
function hashArchivos(archivos: Map<string, Buffer>): string {
  const entradas = [...archivos.entries()]
    .map(([ruta, contenido]): [Buffer, string] => [
      Buffer.from(ruta, 'utf8'),
      crypto.createHash('sha256').update(contenido).digest('hex'),
    ])
    .sort((a, b) => Buffer.compare(a[0], b[0]));
  const h = crypto.createHash('sha256');
  for (const [ruta, digest] of entradas) {
    h.update(Buffer.concat([ruta, Buffer.from(`\n${digest}\n`, 'utf8')]));
  }
  return h.digest('hex');
}

export function hashPaquete(usuario: string, archivos: Map<string, Buffer>): string {
  return crypto.createHash('sha256').update(`${usuario}\n${hashArchivos(archivos)}\n`, 'utf8').digest('hex');
}

function descifrar(paquete: Paquete, clave: Buffer): Map<string, Buffer> {
  const cifrado = Buffer.from(paquete.datos, 'base64');
  const decipher = crypto.createDecipheriv('aes-256-gcm', clave, Buffer.from(paquete.nonce, 'base64'));
  decipher.setAuthTag(cifrado.subarray(cifrado.length - LARGO_ETIQUETA));
  decipher.setAAD(Buffer.from(`${FORMATO}:${paquete.usuario}:${paquete.sha256}`, 'utf8'));
  const plano = Buffer.concat([decipher.update(cifrado.subarray(0, cifrado.length - LARGO_ETIQUETA)), decipher.final()]);
  const contenido = JSON.parse(plano.toString('utf8')) as Record<string, string>;
  return new Map(Object.entries(contenido).map(([ruta, b64]) => [ruta, Buffer.from(b64, 'base64')]));
}

/** Una ruta del paquete sólo puede bajar dentro de la carpeta de destino. */
function rutaSegura(ruta: string): boolean {
  return ruta.split('/').every((parte) => parte !== '' && parte !== '.' && parte !== '..' && parte !== '.git' && !/[\\:\0]/.test(parte));
}

function leerPaquete(texto: string): Paquete | undefined {
  try {
    const p = JSON.parse(texto) as Partial<Paquete>;
    if (p.formato === FORMATO && p.usuario && p.sha256 && p.nonce && p.datos) {
      return p as Paquete;
    }
  } catch {
    // Un paquete ilegible se trata igual que uno que no es el sellado.
  }
  return undefined;
}

/**
 * Descifra el paquete del estudiante en `settings.carpeta` si llegó la clave.
 * Nunca pisa un archivo que ya existe: al volver a entrar en sesión, lo que el
 * estudiante editó queda como está.
 */
export function abrirPaquete(a: AperturaPaquete): ResultadoPaquete {
  const rutaPaquete = path.join(a.repoRoot, ARCHIVO_PAQUETE);
  const rutaClave = path.join(a.repoRoot, ARCHIVO_CLAVE);
  if (!fs.existsSync(rutaPaquete) || !fs.existsSync(rutaClave)) {
    return { estado: 'pendiente' };
  }
  const usuario = a.usuario.toLowerCase();
  const esperado = a.settings.hashes[usuario];
  if (esperado === undefined) {
    return { estado: 'rechazado', motivo: 'usuario_sin_paquete' };
  }
  const paquete = leerPaquete(fs.readFileSync(rutaPaquete, 'utf8'));
  if (!paquete) {
    return { estado: 'rechazado', motivo: 'paquete_no_sellado' };
  }
  if (paquete.usuario !== usuario) {
    return { estado: 'rechazado', motivo: 'paquete_de_otro' };
  }
  if (paquete.sha256 !== esperado) {
    return { estado: 'rechazado', motivo: 'paquete_no_sellado' };
  }
  // Sin reloj calibrado no se decide por la hora local: la clave presente ya
  // prueba que el servidor pasó start_utc, y el evento deja constancia.
  if (a.relojCalibrado && (a.nowMs < a.startMs || a.nowMs > a.deadlineMs)) {
    return { estado: 'rechazado', motivo: 'fuera_de_hora' };
  }
  let archivos: Map<string, Buffer>;
  try {
    const clave = Buffer.from(fs.readFileSync(rutaClave, 'utf8').trim(), 'base64');
    archivos = descifrar(paquete, clave);
  } catch {
    return { estado: 'rechazado', motivo: 'clave_incorrecta' };
  }
  if (hashPaquete(usuario, archivos) !== esperado) {
    return { estado: 'rechazado', motivo: 'paquete_no_sellado' };
  }
  if (![...archivos.keys()].every(rutaSegura)) {
    return { estado: 'rechazado', motivo: 'ruta_invalida' };
  }
  const destino = path.join(a.repoRoot, a.settings.carpeta);
  const escritos: string[] = [];
  const conservados: string[] = [];
  for (const [ruta, contenido] of archivos) {
    const completa = path.join(destino, ...ruta.split('/'));
    if (fs.existsSync(completa)) {
      conservados.push(ruta);
      continue;
    }
    fs.mkdirSync(path.dirname(completa), { recursive: true });
    fs.writeFileSync(completa, contenido);
    escritos.push(ruta);
  }
  return { estado: 'abierto', sha256: esperado, escritos, conservados };
}

const TEXTO_RECHAZO: Record<MotivoRechazo, string> = {
  usuario_sin_paquete: 'tu usuario de GitHub no tiene un examen asignado.',
  paquete_de_otro: 'el examen de este repositorio es de otro estudiante.',
  paquete_no_sellado: 'el examen de este repositorio no es el firmado por la cátedra.',
  fuera_de_hora: 'estás fuera del horario del examen.',
  clave_incorrecta: 'la clave no abre el examen.',
  ruta_invalida: 'el examen trae archivos con rutas no permitidas.',
};

export function textoRechazo(motivo: MotivoRechazo): string {
  return TEXTO_RECHAZO[motivo];
}
