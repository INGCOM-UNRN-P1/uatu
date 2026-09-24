# Protocolo de telemetría uatu v2.1

Este documento fija los formatos que comparten la extensión (`extension/`) y el
validador forense (`scripts/uatu_audit.py`). Cualquier cambio acá rompe la
verificación cruzada y exige subir la versión del formato.

## 1. Serialización canónica

`Serialize(x)` es el JSON de `x` con:

- claves de objetos ordenadas por punto de código Unicode;
- separadores compactos (`,` y `:`), sin espacios;
- UTF-8 sin escapar caracteres no ASCII (`ensure_ascii=False`);
- solo enteros en el rango seguro de JavaScript (±2^53−1). Los flotantes se
  rechazan porque su representación textual difiere entre lenguajes.

Equivale exactamente a
`json.dumps(x, sort_keys=True, separators=(",", ":"), ensure_ascii=False)`.

## 2. Manifiesto `.uatu.conf`

- Esquema: sección 3.2 de la especificación (`templates/exam-repo/uatu.conf.example`).
- **Firma docente:** `crypto.signature = hex(Ed25519_Sign(sk_docente, Serialize(manifiesto sin "crypto")))`.
- **Hash del manifiesto:** `SHA-256(Serialize(manifiesto completo))`, en hex.
  Se usa el JSON canónico y no los bytes del archivo para que el hash no
  cambie por reformateos o conversiones CRLF de Git.

## 3. Registro de claves docentes

```json
{
  "version": "1",
  "issued_at_utc": "2026-08-01T00:00:00Z",
  "root_key_id": "uba-root-2026",
  "teachers": {
    "prof-lead-2026": {
      "ed25519_verify_key": "<hex 32 bytes>",
      "x25519_encryption_key": "<hex 32 bytes>",
      "not_before_utc": "opcional",
      "not_after_utc": "opcional"
    }
  },
  "signature": "<hex Ed25519 raíz sobre Serialize(registro sin 'signature')>"
}
```

Las claves raíz confiables se embeben en `extension/resources/trust-anchors.json`:

```json
{ "anchors": [ { "key_id": "uba-root-2026", "ed25519_public_key": "<hex>" } ] }
```

La extensión guarda en caché el último registro válido; como está firmado por
la raíz, la copia se revalida al leerla y sirve cuando no hay red. Una firma
inválida nunca cae a la caché.

## 4. Bloque génesis

```
H_0 = SHA-256( UTF-8( initial_commit_sha || config_sha256 || github_user || student_pubkey_hex ) )
```

- `initial_commit_sha`: commit raíz más antiguo de `HEAD` (40 hex), o 40 ceros
  si el repositorio no tiene commits.
- `config_sha256`: hash canónico del manifiesto (64 hex).
- `student_pubkey_hex`: clave pública Ed25519 cruda del estudiante (64 hex).

Los componentes hex tienen longitud fija, por lo que la concatenación no es
ambigua. El primer evento de toda sesión es `session_start`, su `prev_hash` es
`H_0` y su `data` declara los cuatro componentes para que el validador pueda
recalcularlo.

## 5. Eventos y cadena

```json
{
  "sequence_id": 18,
  "prev_hash": "<H_{i-1}>",
  "timestamp_utc": "2026-09-24T14:15:30.120Z",
  "student_public_key": "ed25519:<hex>",
  "event_type": "clipboard_paste",
  "data": { },
  "signature": "<hex>"
}
```

```
H_i   = SHA-256( Serialize(evento_i sin "signature") )
Sig_i = Ed25519_Sign( StudentPrivKey, bytes(H_i) )      # sobre los 32 bytes
```

Como el evento contiene `prev_hash` y `timestamp_utc`, `H_i` instancia
`SHA-256(H_{i-1} || T_i || Serialize(EventData_i))` de forma canónica.

| `event_type` | `data` |
|---|---|
| `session_start` | `exam_id`, `session_uuid`, `github_user`, `initial_commit_sha`, `config_sha256`, `teacher_key_id`, `extension_version`, `vscode_version`, `platform`, `clock_source`, `clock_offset_ms` |
| `clipboard_paste` / `external_insertion` | `target_file`, `range {start:[l,c], end:[l,c]}`, `char_count`, `change_count`, `sha256_plaintext`, `clipboard_match`, `window_focused`, `active_editor`, `encrypted_payload?`, `clipboard_sha256?` |
| `window_focus` | `focused`, `unfocused_total_ms`, `unfocused_ms?` |
| `disallowed_extension` | `extension_id`, `version`, `state` (`installed`/`active`/`removed`) |
| `heartbeat` | `uptime_seconds`, `window_focused`, `unfocused_total_ms` |
| `clock_skew` | `offset_ms`, `source` |
| `config_changed` | `deleted?`, `config_sha256?`, `signature_valid?`, `parse_error?` |
| `session_end` | `reason` (`deadline`, `shutdown`, `recovered`, `recovered_without_key`) |

`clipboard_paste` se usa cuando lo insertado coincide con el portapapeles
(ignorando espacios); si no coincide se registra `external_insertion` y del
portapapeles solo se guarda su hash.

Eventos prioritarios (vuelcan el lote de inmediato): `session_start`,
`disallowed_extension`, `clock_skew`, `config_changed`, `session_end`.

## 6. Sobre cifrado (ECIES)

```
(sk_eph, pk_eph) <- X25519
SS    = X25519(sk_eph, pk_docente)
K_sym = HKDF-SHA256(ikm=SS, salt=vacío, info="uatu-clipboard-envelope-v2", L=32)
(C, tag) = AES-256-GCM(K_sym, IV aleatorio de 12 bytes, M, AAD=None)
```

```json
{
  "algorithm": "X25519-AES-256-GCM",
  "ephemeral_public_key": "<base64 de los 32 bytes crudos>",
  "iv": "<base64 12 bytes>",
  "auth_tag": "<base64 16 bytes>",
  "ciphertext_base64": "<base64>"
}
```

El validador acepta la clave efímera cruda o en SPKI DER (toma los últimos 32
bytes). `M` es el texto insertado en el documento; en pegados multicursor, los
fragmentos unidos con `\n`.

## 7. Micro-lotes

Archivo `batches/batch-<seq con 6 dígitos>.json` en la rama de telemetría:

- `batch_start_hash` = `prev_hash` del primer evento (= `batch_end_hash` del
  lote anterior);
- `batch_end_hash` = `H` del último evento;
- `batch_signature` = `hex(Ed25519_Sign(sk_estudiante, SHA-256(Serialize(lote sin "batch_signature"))))`.
  Vacía solo en sesiones recuperadas sin la clave (el validador lo advierte).

## 8. Rama de telemetría

- Referencia: `refs/heads/<telemetry_branch_prefix>/<github_user>/<session_uuid>`.
- El primer commit no tiene padres; cada commit posterior agrega exactamente un
  archivo de lote nuevo al árbol del anterior. Modificar o eliminar un lote se
  detecta como historia reescrita.
- Los commits se crean con plomería (`read-tree`, `hash-object`,
  `update-index`, `write-tree`, `commit-tree`, `update-ref`) sobre un índice
  privado: el working tree, el index y `HEAD` del estudiante no se tocan.
- `git push --no-verify <remoto> <ref>:<ref>`, nunca forzado.

## 9. WAL local

`${globalStorageUri}/sessions/<uuid>/events.wal`, JSON Lines de solo anexado,
con `fsync` en cada registro:

```
{"type":"event","state":"RECORDED","event":{...}}
{"type":"batch","state":"BATCHED","batch_sequence_id":4,"first_seq":18,"last_seq":20,"file":"batch-000004.json"}
{"type":"sync","state":"SYNCED","batch_sequence_id":4,"commit":"<sha>"}
{"type":"close","reason":"deadline"}
```

Junto al WAL: `session.json` (metadatos), `owner.lock` (pid y hostname del
extension host dueño), `batches/` y `git-index`. Una sesión cuyo dueño murió se
recupera en la siguiente activación.

## 10. Decisiones respecto de la especificación

La especificación tiene algunas ambigüedades e inconsistencias internas. Estas
son las resoluciones adoptadas:

1. **Serialización canónica.** El validador de referencia usaba
   `json.dumps(..., sort_keys=True)`, que agrega espacios y escapa no ASCII,
   contradiciendo "sin espacios redundantes" (5.2). Se adoptó la forma compacta
   UTF-8 en ambos lados.
2. **Qué se firma.** 5.2 y la implementación TypeScript firman `H_i`; el
   validador de referencia verificaba la firma sobre el payload crudo. Se firma
   `H_i` (32 bytes) en todos lados.
3. **Verificación del génesis.** El validador de referencia no verificaba el
   `prev_hash` del primer evento. Se agregó `session_start` como bloque génesis
   verificable.
4. **Hash del manifiesto.** Se usa el hash del JSON canónico en lugar de los
   bytes del archivo, para ser robusto frente a CRLF y reformateos.
5. **Rama huérfana.** `git checkout --orphan` + `git rm -rf .` (2.1) alteraría
   el working tree; se usa exclusivamente plomería con índice privado (6.3).
6. **Lectura de lotes.** Como cada commit acumula los lotes anteriores en su
   árbol, recorrer todos los commits (validador de referencia) duplicaba lotes.
   Se leen los lotes de la punta y la historia se audita aparte.
7. **Formato de firma del manifiesto.** El ejemplo `"3045022100..."` parece una
   firma ECDSA DER; las firmas Ed25519 ocupan 64 bytes (128 hex).
8. **Textos de la barra de estado.** 3.1 y RF-02 difieren levemente; se usan los
   de RF-02 y los de 3.1 quedan en el tooltip.
9. **`target_user` del workflow.** El input no se pasaba al script; ahora se
   usa `--user`.
10. **Deadline.** El cierre por deadline ocurre un instante después de
    `deadline_utc`; el validador aplica una tolerancia configurable
    (`--grace-seconds`, 60 s por omisión) y no advierte sobre cierres por
    recuperación de sesiones huérfanas.
11. **Tiempo confiable.** El reloj se calibra con la cabecera HTTP `Date` del
    registro de claves; desfases ≥ 30 s se registran como `clock_skew`.
