---
title: "Manual de Referencia: uatu"
subtitle: "Uatu — Proctorización Transparente y Auditoría Criptográfica Git-Native de Exámenes Prácticos"
author: "Cátedra de Algoritmos y Programación"
date: "2026-09-25"
---

(manual-uatu)=
# Uatu — Proctorización Transparente y Auditoría Criptográfica Git-Native

````{abstract}
**Rol en el ecosistema:** Supervisión de exámenes prácticos de programación en VS Code basada en evidencia verificable. La extensión registra pegados, inserciones externas, foco de ventana y extensiones prohibidas en una rama huérfana del propio repositorio del estudiante, con el contenido del portapapeles cifrado para la cátedra y cada evento firmado y encadenado. El validador `uatu-audit` verifica esa evidencia en CI y descifra lo necesario.
````

Este manual cubre el sistema completo: la extensión de VS Code
([INGCOM-UNRN-P1/uatu](https://github.com/INGCOM-UNRN-P1/uatu)) y las
herramientas de cátedra `uatu-admin` y `uatu-audit`
([INGCOM-UNRN-P1/uatu-tools](https://github.com/INGCOM-UNRN-P1/uatu-tools)).
La referencia exhaustiva de cada opción de línea de comandos está en el
[manual de uatu-tools](https://github.com/INGCOM-UNRN-P1/uatu-tools/blob/main/manual/index.md),
y los formatos de datos en [`docs/protocolo.md`](../docs/protocolo.md).

---

(manual-uatu-proposito)=
## 1. Propósito y Principios

Uatu no graba video ni vigila el sistema operativo. En cambio, produce
**evidencia técnica** sobre lo que ocurrió dentro del editor durante el
examen y la deja en el lugar donde ya vive la entrega: el repositorio Git.

1. **Transparencia**: la supervisión solo existe si el repositorio contiene un
   manifiesto `.uatu.conf` firmado por la cátedra, solo durante la ventana del
   examen y solo después de que el estudiante acepta un aviso de *Fair Play*.
   La barra de estado y el panel lateral muestran en todo momento qué se
   registra.
2. **Evidencia, no sospecha**: cada evento queda firmado con una clave de
   sesión y encadenado al anterior. Borrar, reordenar o editar un evento rompe
   la cadena y el validador lo reporta como falla crítica.
3. **Privacidad**: el texto pegado se cifra con la clave pública de la cátedra
   (X25519 + AES-256-GCM). Ni la extensión, ni la rama de telemetría, ni otros
   estudiantes pueden leerlo; solo el validador con la clave privada docente.
4. **No interferencia**: la telemetría se escribe con comandos de plomería de
   Git sobre un índice privado. El working tree, el index, los commits y
   `main` del estudiante no se tocan.
5. **Resiliencia**: los eventos se asientan primero en un log local con
   `fsync`; los cortes de red o de energía no pierden evidencia, que se
   sincroniza en cuanto es posible.

---

(manual-uatu-arquitectura)=
## 2. Arquitectura

```
 ┌──────────────────── VS Code del estudiante ─────────────────────┐
 │  .uatu.conf firmado ──► puerta temporal (start_utc/deadline_utc)│
 │                                                                 │
 │  observadores ──► evento firmado (Ed25519, hash-chain)          │
 │  (pegado, foco,        │                                        │
 │   extensiones,         ▼                                        │
 │   latido)        WAL local (JSON Lines + fsync)                 │
 │                        │                                        │
 │                        ▼                                        │
 │              micro-lotes batch-<seq>.json                       │
 │                        │                                        │
 │                        ▼                                        │
 │   commit huérfano (índice privado) ──► push con backoff+jitter  │
 └────────────────────────┼────────────────────────────────────────┘
                          ▼
   origin: refs/heads/uatu-audit/<usuario>/<sesión>
                          │
                          ▼
   GitHub Actions ──► uatu-audit (verifica, descifra, reporta)
```

| Componente | Repositorio | Función |
|---|---|---|
| Extensión VS Code | `uatu/extension` | Activación, consentimiento, observadores, cadena firmada, WAL, lotes, sincronización y panel lateral. |
| `uatu-admin` | `uatu-tools` | Almacén de claves, registro de docentes, firma de manifiestos, secretos y protección de ramas en GitHub. |
| `uatu-audit` | `uatu-tools` | Validador forense: integridad criptográfica, heurísticas y descifrado. |
| Plantilla de examen | `uatu/templates/exam-repo` | Workflow de evaluación y manifiesto de ejemplo. |
| Demo | `uatu-demo` | Repositorio de examen completo y funcional. |

### 2.1 Cadena de confianza

```
clave raíz institucional (embebida en el VSIX como ancla)
   └─ firma ─► registro de claves docentes (keys.json, publicado por HTTPS)
                  └─ contiene ─► clave docente Ed25519 ─ firma ─► .uatu.conf
                               └─ clave docente X25519 ◄─ cifra ─ pegados
```

La extensión solo acepta un manifiesto firmado por un docente que figure en un
registro firmado por una raíz que ella misma trae embebida. Por eso el registro
puede publicarse en cualquier URL, incluso dentro del repositorio del examen:
alterarlo invalida la firma raíz.

### 2.2 Ramas de telemetría

Cada ventana de VS Code que inicia una sesión genera un UUID v4 y escribe en su
propia rama huérfana:

```
refs/heads/uatu-audit/<usuario_github>/<session_uuid>
└── batches/batch-000000.json, batch-000001.json, ...
```

Varias ventanas abiertas a la vez (o reaperturas del editor) producen varias
sesiones independientes. El validador las consolida en una línea de tiempo por
usuario.

---

(manual-uatu-instalacion)=
## 3. Instalación

### 3.1 Extensión (estudiantes y laboratorios)

Requisitos: VS Code 1.90 o posterior y Git.

```bash
curl -LO https://github.com/INGCOM-UNRN-P1/uatu/releases/latest/download/uatu.vsix
code --install-extension uatu.vsix
```

Cada release publica también `uatu-X.Y.Z.vsix` y `SHA256SUMS`:

```bash
curl -LO https://github.com/INGCOM-UNRN-P1/uatu/releases/latest/download/SHA256SUMS
sha256sum -c --ignore-missing SHA256SUMS
```

### 3.2 Herramientas de cátedra

Requisitos: [uv](https://docs.astral.sh/uv/), Python 3.9+ y, para las
operaciones sobre GitHub, la CLI [`gh`](https://cli.github.com) autenticada.

```bash
uv tool install "git+https://github.com/INGCOM-UNRN-P1/uatu-tools"
uatu-admin --help
uatu-audit --help
```

Para actualizar: `uv tool upgrade uatu-tools`.

---

(manual-uatu-estudiante)=
## 4. Guía del Estudiante

### 4.1 Qué ocurre al abrir el examen

| Momento | Barra de estado | Qué hace uatu |
|---|---|---|
| Workspace sin `.uatu.conf` | `$(shield) Uatu: Inactivo` | Nada. |
| Antes de `start_utc` | `$(clock) Uatu: Esperando inicio (HH:mm UTC)` | Nada; agenda el inicio. |
| Al llegar `start_utc` | — | Pide iniciar sesión con GitHub y muestra el aviso *Fair Play*. |
| Examen en curso | `$(shield) Uatu: @usuario (Lote: B, Eventos: N)` | Registra y sincroniza la telemetría. |
| Después de `deadline_utc` | `$(check) Uatu: Examen Concluido` | Detiene los observadores y sincroniza lo pendiente. |
| Manifiesto alterado | `$(error) Uatu: Error de integridad` | No se activa. |
| Aviso rechazado | `$(circle-slash) Uatu: Consentimiento pendiente` | No registra nada. |

````{important}
Si se rechaza el aviso de *Fair Play*, uatu no registra ninguna actividad y la
entrega queda **sin telemetría**, lo que el validador reporta como falla. Para
aceptarlo más tarde: paleta de comandos → **Uatu: Iniciar / reintentar sesión
de examen**.
````

### 4.2 Qué se registra y qué no

| Se registra | No se registra |
|---|---|
| Inserciones de más de *N* caracteres de una vez (pegados, cambios desde disco, autocompletados largos): archivo, posición, longitud, hash y **contenido cifrado**. | Pulsaciones de teclado. |
| Pérdidas y recuperaciones de foco de la ventana de VS Code, con su duración. | Capturas de pantalla, cámara o micrófono. |
| Extensiones prohibidas instaladas o activas. | Actividad fuera de VS Code (otros programas, navegador). |
| Un latido periódico que acredita que la supervisión siguió activa. | El contenido del portapapeles que no se pega en el editor. |

Los deshacer/rehacer, los archivos internos de `.git/` y las vistas del editor
que no son archivos (salida, configuración) se ignoran.

### 4.3 Panel lateral

El ícono **Uatu** de la barra de actividad (o un clic en la barra de estado)
abre dos vistas.

**Monitoreo** muestra:

- la fase del examen, con cuenta regresiva hasta el inicio o el cierre;
- el examen: ventana UTC, docente, registro de claves y manifiesto;
- la sesión: usuario, identificador, rama, clave pública de la sesión y bloque
  génesis;
- los monitores: umbral y cifrado del portapapeles, foco actual y tiempo fuera
  del editor, estado de cada extensión prohibida y último latido;
- la sincronización: eventos y lotes pendientes, último push, última falla y
  próximo reintento;
- el reloj: si fue calibrado contra la hora del servidor y su desfase.

**Bitácora** lista cada evento registrado con su hora UTC, un resumen y su
estado:

| Estado | Significado |
|---|---|
| registrado | Firmado y guardado en el disco local. |
| en lote | Incluido en un lote y confirmado en la rama local. |
| sincronizado | Empujado al repositorio remoto. |

Acciones de la bitácora:

- **Agrupar bitácora…** (ícono de árbol): por lote, por tipo o cronológica.
- **Ver detalle del evento** (ícono JSON): abre el evento completo con su hash,
  `prev_hash` y firma. El contenido pegado aparece solo como sobre cifrado.
- **Copiar hash del evento**.

El badge de la vista cuenta los eventos que la cátedra va a revisar: pegados,
inserciones externas, extensiones prohibidas, cambios del manifiesto y
desfases de reloj.

### 4.4 Sin conexión, cortes y varias ventanas

- Sin red, los eventos se siguen registrando localmente y los lotes quedan
  *sin sincronizar*; la extensión reintenta con esperas crecientes (hasta
  `sync_max_backoff_seconds`). El panel muestra la última falla.
- Si el editor o el equipo se cierran de golpe, la próxima vez que se abra el
  repositorio uatu recupera la sesión interrumpida y la sincroniza.
- Cada ventana tiene su propia sesión y su propia rama; no hay conflictos.
- **Uatu: Sincronizar telemetría ahora** fuerza el volcado y el push.

### 4.5 Comandos

| Comando | Función |
|---|---|
| Uatu: Abrir panel de monitoreo | Enfoca el panel lateral. |
| Uatu: Mostrar estado de la sesión | Resumen en un diálogo. |
| Uatu: Iniciar / reintentar sesión de examen | Reintenta la activación o el consentimiento. |
| Uatu: Sincronizar telemetría ahora | Vuelca el lote actual y hace push. |
| Uatu: Mostrar registro | Canal de salida con el registro técnico. |
| Uatu: Abrir carpeta local de la sesión | WAL, lotes y metadatos locales de la sesión. |

---

(manual-uatu-catedra)=
## 5. Guía de la Cátedra

### 5.1 Almacén de claves

`uatu-admin` guarda todo el material criptográfico en
`~/.config/uatu/keys/`, un directorio por clave:

```
~/.config/uatu/keys/                 (0700)
├── inicial_unrn/                    raíz institucional
│   ├── key.json                     metadatos públicos
│   └── root.ed25519.pem             privada (0600)
└── prof-lead-2026/                  docente
    ├── key.json
    ├── signing.ed25519.pem          firma de .uatu.conf (0600)
    └── decryption.x25519.pem        descifrado de evidencia (0600)
```

La ubicación se cambia con `--keys-dir` o `UATU_KEYS_DIR` (y respeta
`XDG_CONFIG_HOME`).

```bash
uatu-admin keys list
uatu-admin keys show prof-lead-2026
uatu-admin keys import prof-lead-2026 --signing firma.pem --decryption descifrado.pem
```

````{warning}
Las claves privadas nunca deben quedar dentro de un repositorio, ni siquiera
ignoradas por `.gitignore`. La clave raíz permite habilitar a cualquier docente:
conviene guardarla fuera de línea y usarla solo para firmar el registro.
````

**Extraer una clave para usarla** — `keys export` la entrega en el formato que
necesita cada lugar:

| Formato | Contenido | Uso típico |
|---|---|---|
| `anchor` / `trust-anchors` | Ancla raíz / `{"anchors":[...]}` | `trust-anchors.json`, variable `UATU_TRUST_ANCHORS` |
| `verify-key` | Ed25519 docente (hex) | `--teacher-key`, secreto `UATU_TEACHER_PUBLIC_KEY` |
| `encrypt-key` | X25519 docente (hex) | Registro de claves |
| `registry-entry` | Entrada JSON del docente | Registros armados a mano |
| `decryption-key` | PEM X25519 privado | Secreto `UATU_TEACHER_PRIVATE_KEY` |
| `signing-key`, `root-key` | PEM privados | Respaldo |
| `*-path` | Ruta del PEM | Scripts |
| `public` | `key.json` | Inventario |

```bash
uatu-admin keys export prof-lead-2026 -f verify-key
uatu-admin keys export prof-lead-2026 -f decryption-key --out /tmp/docente.pem
uatu-admin keys export prof-lead-2026 -f decryption-key --gh-secret UATU_TEACHER_PRIVATE_KEY --repo ORG/examen
```

Las claves privadas no se muestran en una terminal sin `--show-secret` y no
pueden cargarse como variables (que son visibles); los secretos viajan a `gh`
por la entrada estándar.

### 5.2 Clave raíz y anclas de la extensión

Se crea una sola vez por institución:

```bash
uatu-admin root-keygen --key-id inicial_unrn --name "Raíz institucional UNRN"
```

La extensión solo confía en las raíces embebidas en el VSIX. El workflow
*Release* del repositorio `uatu` las toma de la variable
`UATU_TRUST_ANCHORS`:

```bash
uatu-admin keys setup-anchors inicial_unrn --repo INGCOM-UNRN-P1/uatu
git tag v2.1.1 && git push origin v2.1.1      # publica un VSIX con las anclas
```

Para un empaquetado local: `uatu-admin keys setup-anchors inicial_unrn --file
extension/resources/trust-anchors.json`. Se pueden embeber varias raíces (por
ejemplo durante una rotación) pasando varios identificadores.

### 5.3 Claves docentes y registro

```bash
uatu-admin keygen --key-id prof-lead-2026 --name "Programación I - 2026"
uatu-admin registry-add --registry keys.json --key-id prof-lead-2026 --not-after 2027-03-31T23:59:59Z
uatu-admin registry-sign --registry keys.json --root-key-id inicial_unrn
uatu-admin verify-registry --registry keys.json
```

- `registry-add` toma las claves públicas del almacén; `--not-before` y
  `--not-after` acotan la vigencia de la clave docente.
- Cualquier cambio en el registro descarta la firma: hay que volver a firmarlo.
- `keys.json` se publica en la URL HTTPS de `auth.public_key_registry_url`.
  Sirve un sitio institucional, GitHub Pages o el propio repositorio del
  examen vía `raw.githubusercontent.com`.
- La extensión guarda en caché la última copia válida para funcionar sin red,
  y usa la cabecera HTTP `Date` de esa respuesta para calibrar el reloj.

**Rotación**: generar la clave nueva, agregarla al registro junto a la vieja,
firmar y publicar; los manifiestos nuevos se firman con la clave nueva. La
vieja se retira del registro cuando ya no quedan exámenes que la usen.

### 5.4 Manifiesto `.uatu.conf`

Partir de [`templates/exam-repo/uatu.conf.example`](../templates/exam-repo/uatu.conf.example):

| Campo | Tipo / rango | Por omisión | Descripción |
|---|---|---|---|
| `version` | `"2.1"` | — | Versión del formato. |
| `exam_id` | `[A-Za-z0-9._-]` | — | Identificador del examen. |
| `session.start_utc` | ISO-8601 con zona | — | Inicio de la ventana. |
| `session.deadline_utc` | ISO-8601 con zona | — | Cierre (posterior al inicio). |
| `session.batch_interval_seconds` | 1–3600 | 30 | Tiempo máximo de un evento sin empaquetar. |
| `session.batch_max_events` | 1–10000 | 20 | Eventos por lote. |
| `session.sync_max_backoff_seconds` | 2–3600 | 60 | Espera máxima entre reintentos de push. |
| `session.heartbeat_interval_seconds` | 5–86400 | 120 | Período del latido. |
| `auth.public_key_registry_url` | URL HTTPS | — | Registro de claves docentes. |
| `auth.require_github_auth` | booleano | `true` | Exige iniciar sesión con GitHub. |
| `monitoring.clipboard.enabled` | booleano | `true` | Detección de inserciones masivas. |
| `monitoring.clipboard.character_threshold` | 1–1000000 | 15 | Inserciones de más de *N* caracteres. |
| `monitoring.clipboard.encrypt_content` | booleano | `true` | Adjunta el contenido cifrado. |
| `monitoring.clipboard.hash_algorithm` | `"sha256"` | `sha256` | Hash del texto insertado. |
| `monitoring.window_focus` | booleano | `true` | Registro de foco de ventana. |
| `monitoring.disallowed_extensions` | lista de IDs | `[]` | Extensiones prohibidas. |
| `crypto.teacher_key_id` | texto | — | Docente que firma (en el registro). |
| `crypto.signature` | hex | — | Firma Ed25519 (la escribe `sign-config`). |
| `git.telemetry_branch_prefix` | ruta de ref | `uatu-audit` | Prefijo de las ramas de telemetría. |
| `git.remote_name` | texto | `origin` | Remoto de sincronización. |
| `git.auto_push` | booleano | `true` | Push automático de los lotes. |

Firmar y verificar (la clave se toma del almacén según `teacher_key_id`):

```bash
uatu-admin sign-config --config .uatu.conf --key-id prof-lead-2026
uatu-admin verify-config --config .uatu.conf
```

````{important}
La firma cubre todo el manifiesto salvo el bloque `crypto`. Cualquier cambio
(por ejemplo, ampliar la ventana) exige volver a firmar. Un cambio durante el
examen queda registrado como evento `config_changed`, y el validador exige que
el génesis de cada sesión coincida con el `.uatu.conf` entregado.
````

### 5.5 Repositorio del examen

Estructura mínima (ver el repositorio `uatu-demo`):

```
.uatu.conf                            manifiesto firmado
keys.json                             (opcional) registro de claves
.github/workflows/uatu-audit.yml      evaluación forense
.vscode/extensions.json               recomienda uatu y desaconseja las prohibidas
```

Configuración en GitHub:

```bash
# Secretos del workflow forense
uatu-admin keys setup-audit prof-lead-2026 --repo ORG/examen

# Ramas de telemetría inmutables (sin borrado ni force-push)
uatu-admin protect-branches --repo ORG/examen
```

Con **GitHub Classroom**, los repositorios de los estudiantes se crean a partir
de la plantilla. Conviene configurar todo a nivel de organización, una sola
vez:

```bash
uatu-admin keys setup-audit prof-lead-2026 --org ORG --visibility private
uatu-admin protect-branches --org ORG --repo-pattern 'examen-parcial-1-*'
```

El ruleset bloquea el borrado y la reescritura con force-push para todos,
incluidos los administradores, sin impedir que la extensión cree ramas y haga
push normalmente. `--dry-run` muestra lo que se aplicaría.

La variable opcional `UATU_TOOLS_REF` del repositorio fija la versión de
uatu-tools que instala el workflow (por ejemplo `v2.1.0`).

### 5.6 Evaluación forense

**En GitHub Actions**: *Actions → Evaluación Forense Uatu → Run workflow*,
opcionalmente con un usuario. El reporte queda en el resumen de la ejecución y
como artefacto (`uatu_report.md`, `uatu_report.json`).

**Localmente**, con la clave en el almacén:

```bash
git fetch origin '+refs/heads/uatu-audit/*:refs/remotes/origin/uatu-audit/*'
uatu-audit --repo . --md-out reporte.md --json-out reporte.json
```

Sin `--teacher-key`, `uatu-audit` usa la clave del almacén indicada por el
`teacher_key_id` del manifiesto (o `--key-id`) para verificar y descifrar.

| Código | Resultado |
|---|---|
| `0` | Integridad verificada sin anomalías. |
| `1` | **Falla crítica** de integridad o ausencia de registros. |
| `2` | Cadena íntegra con **alertas heurísticas** a revisar. |

Opciones heurísticas: `--max-paste-chars` (50), `--grace-seconds` (60),
`--code-ref` (`HEAD`), `--user`, `--remote`.

### 5.7 Interpretación del reporte

El reporte incluye una tabla de sesiones (eventos, pegados, inserciones
externas, tiempo fuera de foco y motivo de cierre), las violaciones críticas,
las alertas y una línea de tiempo consolidada por usuario.

**Fallas críticas** (código 1): indican manipulación o falta de evidencia.

| Mensaje | Qué significa |
|---|---|
| Firma docente en .uatu.conf INVÁLIDA | El manifiesto entregado fue modificado. |
| El génesis se ancló a un .uatu.conf distinto | La sesión se hizo con otras reglas. |
| Ruptura de hash-chain / Firma digital del estudiante inválida | Eventos editados, eliminados o fabricados. |
| Lote faltante o fuera de orden / Firma del lote inválida | Lotes quitados o alterados. |
| El commit … modifica o elimina … historia reescrita | La rama de telemetría fue reescrita. |
| El génesis declara una sesión o usuario distintos | Rama renombrada o suplantación. |
| Evento registrado antes de start_utc | Reloj adelantado para activar antes de hora. |
| El manifiesto fue alterado o eliminado durante la sesión | Cambio de reglas a mitad del examen. |
| El contenido descifrado no coincide con sha256_plaintext | Sobre cifrado sustituido. |
| No se encontraron ramas de telemetría (ausencia de registros) | Extensión no instalada, consentimiento rechazado o ramas borradas. |

**Alertas** (código 2): requieren criterio docente.

| Mensaje | Qué revisar |
|---|---|
| Pegado masivo (N chars) … Snippet | El fragmento descifrado y su origen. |
| Inserción externa [con el editor sin foco] | Texto que no provino del portapapeles (disco, IA, otro editor). |
| Extensión no autorizada detectada | Qué extensión y si estuvo activa. |
| Silencio de telemetría de X | Posible desactivación de la extensión en ese lapso. |
| Commit de código fuera de todo período con telemetría activa | Trabajo hecho sin supervisión. |
| La sesión no registra session_end | Cierre abrupto o extensión deshabilitada. |
| Evento posterior al deadline_utc / El reloj retrocedió / Desfase de reloj | Manipulación del reloj o equipo mal configurado. |
| El lote no tiene firma de lote | Sesión recuperada sin su clave (los eventos siguen firmados). |

---

(manual-uatu-referencia)=
## 6. Referencia

### 6.1 Máquina de estados

```
¿.uatu.conf? ─ no ─► INACTIVO
   │ sí
¿firma docente válida (registro firmado por un ancla)? ─ no ─► ERROR DE INTEGRIDAD
   │ sí
T_now < start_utc ──────────────► EN ESPERA ── (temporizador) ──┐
start_utc ≤ T_now ≤ deadline_utc ► ACTIVO ◄───────────────────────┘
   │  GitHub + Fair Play ─ rechazo ─► CONSENTIMIENTO PENDIENTE
   ▼
T_now > deadline_utc ──────────► CONCLUIDO (volcado final)
```

La hora se calibra contra la cabecera HTTP `Date` del registro de claves; un
desfase de 30 s o más se registra como evento `clock_skew`.

### 6.2 Eventos

| Tipo | Cuándo | Datos principales |
|---|---|---|
| `session_start` | Al aceptar el aviso | examen, sesión, usuario, commit inicial, hash del manifiesto, desfase de reloj |
| `clipboard_paste` | Inserción masiva igual al portapapeles | archivo, rango, caracteres, hash, sobre cifrado |
| `external_insertion` | Inserción masiva que no vino del portapapeles | ídem, hash del portapapeles, foco |
| `window_focus` | Cambio de foco | enfocada, duración fuera, total fuera |
| `disallowed_extension` | Extensión prohibida instalada/activa/quitada | id, versión, estado |
| `heartbeat` | Cada `heartbeat_interval_seconds` | tiempo activo, foco, total fuera |
| `clock_skew` | Desfase ≥ 30 s al iniciar | desfase, fuente |
| `config_changed` | `.uatu.conf` modificado o borrado en sesión | hash nuevo, validez de firma |
| `session_end` | Deadline, cierre del IDE o recuperación | motivo |

Los eventos `session_start`, `disallowed_extension`, `clock_skew`,
`config_changed` y `session_end` fuerzan el volcado inmediato del lote.

### 6.3 Archivos locales

La extensión guarda cada sesión en su almacenamiento global
(`~/.config/Code/User/globalStorage/uatu.uatu/sessions/<uuid>/` en Linux):
`session.json`, `events.wal`, `batches/`, `owner.lock` y `git-index`. La clave
de sesión vive en el almacén de secretos del sistema y se borra al cerrar la
sesión.

### 6.4 Formatos

Serialización canónica, génesis, eventos, sobre cifrado, lotes, registro y WAL
están especificados en [`docs/protocolo.md`](../docs/protocolo.md).

---

(manual-uatu-seguridad)=
## 7. Modelo de Amenazas

| Ataque | Contramedida | Resultado en el validador |
|---|---|---|
| Adelantar el reloj para activar antes o atrasarlo para extender | Reloj calibrado con HTTP `Date`, `clock_skew`, ventana del manifiesto firmado | Falla (antes de `start_utc`) o alerta |
| Editar `.uatu.conf` para ampliar la ventana o apagar monitores | Firma docente y hash en el génesis | Falla crítica |
| Editar, borrar o reordenar telemetría | Hash-chain firmada, lotes encadenados, ruleset sin force-push | Falla crítica |
| Borrar la rama de telemetría | Ruleset sin borrado; ausencia de registros | Falla crítica |
| Usar otra cuenta de GitHub | Usuario autenticado en el génesis y en la rama | Falla si no coinciden |
| Pegar desde otro editor y recargar | Inserción externa sin foco o sin coincidencia con el portapapeles | Alerta |
| Deshabilitar la extensión | Silencios de telemetría, commits sin cobertura, sin `session_end` | Alertas |
| Varias ventanas para dividir la telemetría | Una rama por sesión, consolidación por usuario | Línea de tiempo completa |
| Usar asistentes de IA | Extensiones prohibidas; inserciones externas | Alertas |

````{note}
**Limitaciones conocidas.** Uatu produce evidencia, no impide conductas: un
estudiante puede tipear código obtenido por otro medio, o usar otro equipo.
Una persona con privilegios sobre su equipo podría leer la clave de la sesión
en curso del almacén de secretos y fabricar eventos de esa sesión; los
controles de génesis, ventana, silencios y correlación con los commits de
código siguen aplicando. Como toda heurística, las alertas requieren revisión
docente antes de cualquier decisión.
````

---

(manual-uatu-problemas)=
## 8. Solución de Problemas

| Síntoma | Causa probable | Solución |
|---|---|---|
| `Error de integridad` con "no tiene anclas raíz" | VSIX empaquetado sin `UATU_TRUST_ANCHORS` | Publicar un release con la variable definida (§5.2). |
| `Error de integridad`: firma INVÁLIDA | `.uatu.conf` editado sin volver a firmar | `uatu-admin sign-config` y commit. |
| "No se pudo obtener el registro de claves" | Sin red y sin caché; URL incorrecta; proxy | Verificar la URL con `curl`; abrir el examen con red al menos una vez. |
| Error de registro en laboratorios con proxy | El registro se descarga con `fetch` de Node, que puede no usar el proxy configurado en VS Code 1.90 | Actualizar VS Code o permitir la URL del registro en el proxy. |
| El registro "está firmado por una raíz desconocida" | El registro se firmó con otra raíz que la embebida | Firmar con la raíz correcta o publicar un VSIX con esa ancla. |
| Lotes "sin sincronizar" persistentes | Sin credenciales de Git para push, remoto inexistente | Revisar la última falla en el panel; `git push` manual debe funcionar. |
| "rechazó el push (non-fast-forward)" | La rama remota fue alterada | Reportar a la cátedra: es evidencia de manipulación. |
| La barra no cambia al llegar `start_utc` | Equipo suspendido | Se reevalúa cada 15 s; o *Uatu: Iniciar / reintentar sesión*. |
| `uatu-audit`: "ausencia de registros" | Falta el `git fetch` de las ramas | `git fetch origin '+refs/heads/uatu-audit/*:refs/remotes/origin/uatu-audit/*'` |
| `protect-branches`: 403/404 | El token no es administrador del repositorio | `gh auth login` con una cuenta administradora (scope `repo`/`admin:org`). |
| Se perdió la clave docente X25519 | — | La evidencia ya cifrada no puede descifrarse; la verificación de integridad sigue funcionando. Respaldar las claves. |

El comando **Uatu: Mostrar registro** muestra el detalle técnico de la
activación, la calibración del reloj, los lotes y la sincronización.

---

(manual-uatu-glosario)=
## 9. Glosario

| Término | Definición |
|---|---|
| Ancla raíz | Clave pública Ed25519 institucional embebida en la extensión. |
| Registro de claves | JSON firmado por la raíz con las claves de cada docente. |
| Manifiesto | `.uatu.conf`: reglas del examen firmadas por un docente. |
| Sesión | Una activación de uatu en una ventana de VS Code, con UUID, clave y rama propias. |
| Génesis (H₀) | Hash que ancla la sesión al commit inicial, al manifiesto, al usuario y a la clave de sesión. |
| Hash-chain | Cadena en la que cada evento contiene el hash del anterior. |
| WAL | *Write-ahead log*: registro local durable de los eventos antes de empaquetarlos. |
| Lote | Archivo `batch-<seq>.json` con varios eventos firmados, un commit en la rama de telemetría. |
| Sobre cifrado | Contenido pegado cifrado con X25519 + HKDF-SHA256 + AES-256-GCM para la cátedra. |
| Ruleset | Regla de GitHub que impide borrar o reescribir las ramas de telemetría. |
