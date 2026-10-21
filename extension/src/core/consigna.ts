import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Hash de la carpeta de la consigna, el mismo que calculan `uatu-admin
 * consigna sellar/hash` y `uatu-audit`: SHA-256 de las líneas
 * `<ruta relativa con />\n<sha256 del archivo>\n`, ordenadas por ruta
 * (bytes UTF-8). Devuelve undefined si la carpeta no existe o está vacía.
 */
export function consignaTreeHash(dir: string): string | undefined {
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    return undefined;
  }
  const entries: Array<[Buffer, string]> = [];
  const walk = (current: string): void => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (entry.name === '.git') {
        continue;
      }
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile()) {
        const rel = path.relative(dir, full).split(path.sep).join('/');
        entries.push([Buffer.from(rel, 'utf8'), crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex')]);
      }
    }
  };
  walk(dir);
  if (entries.length === 0) {
    return undefined;
  }
  entries.sort((a, b) => Buffer.compare(a[0], b[0]));
  const h = crypto.createHash('sha256');
  for (const [rel, digest] of entries) {
    h.update(Buffer.concat([rel, Buffer.from(`\n${digest}\n`, 'utf8')]));
  }
  return h.digest('hex');
}
