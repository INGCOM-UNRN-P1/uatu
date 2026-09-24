# Especificación Técnica de Ingeniería de Software

## Sistema de Proctorización y Auditoría Criptográfica Git-Native: "uatu"

## 1. Visión General y Objetivos del Sistema

**uatu** es una extensión modular para Visual Studio Code diseñada para la supervisión y auditoría de instancias de evaluación práctica de código en entornos universitarios e industriales.

A diferencia de los sistemas de proctoring invasivos basados en video o monitoreo de kernel, **uatu** implementa un modelo **Git-Native** transparente y centrado en la evidencia:

1. **Persistencia en Rama Secundaria:** Utiliza el repositorio Git de trabajo del estudiante mediante ramas de telemetría desacopladas (`refs/heads/uatu-audit/...`), evitando alterar el árbol de código o interferir con `git merge`, `git pull` o ramas de entrega (`main`/`master`).

2. **Auditoría y Cifrado Híbrido de Portapapeles:** Monitorea operaciones de inserción masiva y buffer del portapapeles, cifrando asimétricamente el contenido con la clave pública docente (esquema ECIES sobre X25519 + AES-256-GCM) para garantizar la privacidad ante accesos indebidos.

3. **Atestamiento Criptográfico y Encadenamiento:** Construye una cadena de registros inmutable (*hash-chain*) firmada digitalmente por el par efímero del estudiante (Ed25519), impidiendo el repudio o la manipulación histórica de la telemetría.

4. **Empaquetado en Micro-Lotes (Batching):** Agrupa eventos en ventanas temporales parametrizadas para evitar la proliferación descontrolada de objetos en Git (*repository bloat*).

5. **Persistencia Offline y Resiliencia contra Concurrencia Masiva:** Cola local segura en disco (WAL) y algoritmo de sincronización con retroceso exponencial y fluctuación aleatoria (*jitter*) para tolerar fallas de red y mitigar tormentas de pushes (*thundering herd*).

6. **Autenticación e Identidad GitHub:** Correlaciona la sesión activa de VS Code con la cuenta autenticada en GitHub, notificando al estudiante mediante un modal de consentimiento explícito (*Fair Play*).

7. **Activación Declarativa y Temporal:** Su ciclo de vida es bi-condicional: depende de la presencia e integridad de un manifiesto de configuración firmado por la cátedra (`.uatu.conf`) y de la vigencia estricta de la ventana temporal delimitada por `start_utc` y `deadline_utc`.

8. **Evaluación Desacoplada en CI:** Provee un CLI de auditoría offline integrable en pipelines de CI (GitHub Actions, GitLab CI) para procesar entregas bajo demanda y descifrar evidencia selectivamente.

## 2. Arquitectura de Almacenamiento Git y Multi-Instancia

Para evitar problemas de permisos con referencias no estándar (como `refs/notes/*`) en plataformas como GitHub Classroom o GitLab, el sistema utiliza ramas de telemetría huérfanas estructuradas por instancia.

```
Repositorio del Estudiante (origin)
├── refs/heads/main                                      <-- Commits de código de la solución (estudiante)
└── refs/heads/uatu-audit/<github_user>/<session_uuid>  <-- Rama huérfana de auditoría (gestionada por uatu)
```

### 2.1. Mitigación de Colisiones y Concurrencia

Si un estudiante abre múltiples ventanas de VS Code (mismo workspace o subcarpetas), o si ocurren reintentos de red asíncronos, actualizar una única rama compartida provocaría errores de rechazo por avance no rápido (*non-fast-forward push rejection*).

* **UUID de Sesión:** Al activarse en una ventana de VS Code, la extensión genera un identificador único de sesión ($UUID_{\text{v4}}$).
* **Espacio de Nombres Aislado:** La telemetría de esa ventana se emite exclusivamente hacia:
  `refs/heads/uatu-audit/<github_user>/<session_uuid>`
* **Estructura Huérfana:** La rama se inicializa sin ancestros compartidos con `main`:
  ```bash
  git checkout --orphan uatu-audit/<github_user>/<session_uuid>
  git rm -rf .
  ```
* **Consolidación en Evaluación:** El CLI de auditoría docente descarga todas las ramas bajo el prefijo `refs/remotes/origin/uatu-audit/<github_user>/*` y las consolida en un único grafo cronológico según sus marcas de tiempo y hashes.

## 3. Activación, Manifiesto (`.uatu.conf`) e Identidad

### 3.1. Disparador Declarativo y Puerta Temporal (`start_utc` / `deadline_utc`)

La activación del motor de supervisión de **uatu** está sujeta a dos condiciones simultáneas e indispensables:

1. **Condición de Presencia Estructural:** Detección de `.uatu.conf` en la raíz del workspace abierto (`workspaceContains:.uatu.conf` en `package.json` o evento reactivo vía `vscode.workspace.createFileSystemWatcher`).
2. **Condición de Ventana Temporal (Time-Gating):** Validación estricta de que la hora actual $T_{\text{now}}$ (verificada idealmente contra fuentes de tiempo confiables o commits remotos) cumpla con la restricción de ventana:
   $$T_{\text{start}} \le T_{\text{now}} \le T_{\text{deadline}}$$

#### Máquina de Estados de Activación Temporal

```
                      [Apertura de Workspace / Detección .uatu.conf]
                                            │
                                            ▼
                                   ¿Existe .uatu.conf?
                                    ├── No ──► [ESTADO: INACTIVO / REPOSO]
                                    │
                                    └── Sí
                                         │
                                         ▼
                            Validar firma docente de .uatu.conf
                                    ├── Inválida ──► [ESTADO: ERROR DE INTEGRIDAD] (Bloqueo/Alerta)
                                    │
                                    └── Válida
                                         │
                                         ▼
                             Evaluar Ventana Temporal (T_now)
                                         │
             ┌───────────────────────────┼───────────────────────────┐
             ▼                           ▼                           ▼
      T_now < start_utc      start_utc <= T_now <= deadline_utc  T_now > deadline_utc
             │                           │                           │
             ▼                           ▼                           ▼
     [ESTADO: STANDBY]          [ESTADO: ACTIVO / FAIR PLAY]  [ESTADO: CONCLUIDO]
  - No inicia listeners       - Solicita Auth GitHub        - No monitorea
  - Timer hasta start_utc     - Despliega Disclaimer Modal  - Notifica examen cerrado
  - Indicador "En Espera"     - Inicia WAL y Batch Engine   - Sincroniza remanentes
```

* **Comportamiento en `PRE-EXAMEN` ($T_{\text{now}} < \text{start\_utc}$):**
  * La extensión no captura el portapapeles ni monitorea foco de ventana.
  * Muestra en la barra de estado: `$(clock) Uatu: Examen en espera (Inicia a las HH:mm UTC)`.
  * Agenda un temporizador interno (`setTimeout`) para disparar la activación y el flujo de autorización exactamente al alcanzar `start_utc`.
* **Comportamiento en `EN SESIÓN` ($\text{start\_utc} \le T_{\text{now}} \le \text{deadline\_utc}$):**
  * Se verifica la sesión de GitHub del usuario.
  * Se despliega el disclaimer modal de consentimiento obligatorio.
  * Se inicializa el canal de auditoría y se montan los observadores de eventos.
* **Comportamiento en `POST-EXAMEN` ($T_{\text{now}} > \text{deadline\_utc}$):**
  * Los observadores de telemetría se desmontan automáticamente.
  * Se realiza un volcado final forzado (*flush*) de cualquier evento pendiente en la cola local hacia el repositorio remoto.
  * La barra de estado pasa a: `$(check) Uatu: Sesión de examen finalizada`.

### 3.2. Esquema de Configuración

```json
{
  "version": "2.1",
  "exam_id": "eval-sistemas-distribuidos-2026",
  "session": {
    "start_utc": "2026-09-24T13:00:00Z",
    "deadline_utc": "2026-09-24T16:00:00Z",
    "batch_interval_seconds": 30,
    "batch_max_events": 20,
    "sync_max_backoff_seconds": 60,
    "heartbeat_interval_seconds": 120
  },
  "auth": {
    "public_key_registry_url": "https://catedras.exactas.uba.ar/so/keys/2026-c2.json",
    "require_github_auth": true
  },
  "monitoring": {
    "clipboard": {
      "enabled": true,
      "character_threshold": 15,
      "encrypt_content": true,
      "hash_algorithm": "sha256"
    },
    "window_focus": true,
    "disallowed_extensions": [
      "github.copilot",
      "github.copilot-chat",
      "continue.continue"
    ]
  },
  "crypto": {
    "teacher_key_id": "prof-lead-2026",
    "signature": "3045022100e4b7..."
  },
  "git": {
    "telemetry_branch_prefix": "uatu-audit",
    "remote_name": "origin",
    "auto_push": true
  }
}
```

### 3.3. Resolución de Llaves Docentes y Verificación de Integridad

Para facilitar la rotación de certificados sin forzar actualizaciones de la extensión en el Marketplace:

1. **Registry HTTP Público con Ancla Raíz:** La extensión consulta `auth.public_key_registry_url` para obtener el certificado docente asociado a `crypto.teacher_key_id`. Este registro expone un JSON firmado por una clave raíz institucional fija (embebida en la extensión).
2. **Estructura del Certificado Docente:**
   * Clave pública de verificación de configuración (Ed25519).
   * Clave pública de cifrado de telemetría (X25519).
3. **Validación de `.uatu.conf`:** Se serializa el contenido canónico (excluyendo el bloque `crypto`) y se valida la firma Ed25519 docente. Si diverge, la activación se aborta y se alerta al usuario.
4. **Bloque Génesis:** El hash $H_0$ sella el ancla del examen:
   $$H_0 = \text{SHA-256}(\text{Initial\_Commit\_SHA} \parallel \text{SHA-256}(.uatu.conf) \parallel \text{GitHub\_User} \parallel \text{Student\_Pubkey})$$

### 3.4. Disclaimer Modal y Verificación de Identidad GitHub

Al inicializar la sesión durante el período activo del examen:

1. La extensión invoca `vscode.authentication.getSession('github', ['read:user'], { createIfNone: true })`.
2. Se obtiene el usuario activo (`session.account.label`).
3. Se despliega un diálogo modal bloqueante de términos (*Fair Play*):

   > **Sesión de Examen Activa - UATU**
   > 
   > Usuario detectado: **@octocat**  
   > Examen: **eval-sistemas-distribuidos-2026**  
   > Ventana: **13:00 UTC - 16:00 UTC**
   > 
   > Esta sesión registrará operaciones de portapapeles y foco de ventana hacia la rama `uatu-audit/octocat/...`. El contenido del portapapeles será cifrado para uso exclusivo del cuerpo docente.
   > 
   > `[Aceptar y Comenzar Examen]` `[Cancelar / Salir]`

## 4. Requisitos Funcionales (RF)

### RF-01: Monitoreo y Cifrado del Portapapeles
* **Detección de inserciones:** Escuchar eventos `vscode.workspace.onDidChangeTextDocument`. Si un cambio introduce una cantidad de caracteres superior al umbral (`character_threshold`) en un intervalo temporal delta $< 50\text{ ms}$, se clasifica como inserción externa o pegado.
* **Captura del buffer:** La extensión recupera el texto pegado mediante `vscode.env.clipboard.readText()`.
* **Cifrado híbrido asimétrico:** Aplicar el protocolo criptográfico detallado en la Sección 5.
* **Metadatos registrados:** Longitud del texto, hash SHA-256 del texto plano, timestamp UTC, coordenadas del cursor (`line`, `character`), ruta del archivo relativo al workspace y el payload cifrado en Base64.

### RF-02: Interfaz Transparente y Fair Play
* **Barra de estado:** Indicador visual dinámico en la barra inferior de VS Code:
  * Reposo: `$(shield) Uatu: Inactivo`
  * Standby: `$(clock) Uatu: Esperando inicio (HH:mm UTC)`
  * Activo: `$(shield) Uatu: @usuario (Lote: B, Eventos: N)`
  * Expirado: `$(check) Uatu: Examen Concluido`
* **Feedback de captura:** Mensaje breve no bloqueante (`setStatusBarMessage`) al registrar una inserción: `[Uatu] Portapapeles registrado y cifrado (Hash: 9f8a...)`.

### RF-03: Telemetría Complementaria del Entorno
* **Pérdida de foco:** Monitoreo vía `vscode.window.onDidChangeWindowState` registrando transiciones de foco con timestamps para computar el tiempo acumulado fuera del editor.
* **Auditoría de extensiones no autorizadas:** Detección activa frente a `vscode.extensions.all`. La activación de extensiones bloqueadas dispara un evento prioritario.
* **Dinámica de tipeo (Keystroke Dynamics):** Postergada para fases futuras bajo entornos no presenciales.

## 5. Diseño Criptográfico y Esquema Híbrido

Para cumplir con el requerimiento de privacidad del estudiante y auditoría docente sin comprometer rendimiento:

```
[Portapapeles en Texto Plano (M)]
                 │
                 ▼
  Generar par efímero X25519 (sk_eph, pk_eph)
                 │
                 ├──────────────────────────────┐
                 ▼                              ▼
  X25519(sk_eph, pk_teacher_x25519)      Serializar pk_eph
                 │
                 ▼
       Shared Secret (SS)
                 │
                 ▼
       HKDF-SHA256(SS, salt, info="uatu-hybrid-key")
                 │
                 ▼
       Clave Simétrica K_sym (AES-256)
                 │
                 ▼
   AES-256-GCM Encrypt(M, K_sym, IV) ──► Payload Cifrado: { pk_eph, iv, auth_tag, ciphertext }
                 │
                 ▼
       Cálculo de Hash del Evento: H_i = SHA-256(H_{i-1} || T_i || Payload)
                 │
                 ▼
       Firma Ed25519: Sig_i = Sign(StudentPrivKey, H_i)
```

### 5.1. Algoritmo de Cifrado Híbrido (Portapapeles)

1. **Entradas:**
   * Texto en plano del portapapeles $M$.
   * Clave pública docente para cifrado $PK_{\text{teacher\_x25519}}$ (32 bytes).
2. **Generación Efímera:**
   * La extensión genera un par de claves efímero $X25519$: $(SK_{\text{eph}}, PK_{\text{eph}})$.
3. **Acuerdo de Claves (Diffie-Hellman):**
   * Se computa el secreto compartido escalar:
     $$SS = \text{X25519}(SK_{\text{eph}}, PK_{\text{teacher\_x25519}})$$
4. **Derivación de Clave (HKDF):**
   * Se deriva una clave simétrica de 256 bits mediante HKDF-SHA256:
     $$K_{\text{sym}} = \text{HKDF-Expand}(\text{HKDF-Extract}(\text{salt}=\text{None}, SS), \text{info}=\text{"uatu-clipboard-envelope-v2"}, L=32)$$
5. **Cifrado Autenticado (AEAD):**
   * Se genera un vector de inicialización aleatorio $IV$ de 12 bytes.
   * Se cifra $M$ utilizando $\text{AES-256-GCM}$:
     $$(C, \text{tag}) = \text{AES-GCM-Encrypt}(K_{\text{sym}}, IV, M, \text{AAD}=\text{None})$$
6. **Destrucción de Secretos:**
   * Se sobrescriben con ceros en memoria $SK_{\text{eph}}$, $SS$ y $K_{\text{sym}}$.
7. **Sobre Criptográfico Resultante:**
   ```json
   {
     "algorithm": "X25519-AES-256-GCM",
     "ephemeral_public_key": "<base64_pk_eph>",
     "iv": "<base64_iv>",
     "auth_tag": "<base64_tag>",
     "ciphertext_base64": "<base64_C>"
   }
   ```

### 5.2. Cadena de Bloques Criptográfica e Inmutabilidad

Cada evento individual $i$ se vincula estrictamente a su predecesor:
$$H_i = \text{SHA-256}(H_{i-1} \parallel T_i \parallel \text{Serialize}(\text{EventData}_i))$$

La firma digital garantiza el no repudio:
$$\text{Sig}_i = \text{Sign}_{\text{StudentPrivKey}}(H_i)$$

Donde:
* $\text{StudentPrivKey}$ es una clave Ed25519 generada al aceptar el disclaimer y retenida en memoria mediante `ExtensionContext.secrets`.
* $\text{Serialize}$ realiza una serialización canónica JSON (claves ordenadas alfabéticamente, codificación UTF-8, sin espacios redundantes).

### 5.3. Implementación de Referencia del Módulo Criptográfico (TypeScript)

```typescript
import * as crypto from 'crypto';

export interface EncryptedPayload {
  algorithm: string;
  ephemeral_public_key: string;
  iv: string;
  auth_tag: string;
  ciphertext_base64: string;
}

export class UatuCryptoEngine {
  /**
   * Cifra el contenido del portapapeles utilizando X25519 y AES-256-GCM.
   */
  public static encryptClipboard(
    plaintext: string,
    teacherPublicKeyDer: Buffer
  ): EncryptedPayload {
    // 1. Generar par efímero X25519
    const { privateKey: ephPrivKey, publicKey: ephPubKey } = crypto.generateKeyPairSync('x25519');

    // 2. Importar clave pública docente (X25519)
    const teacherPubKey = crypto.createPublicKey({
      key: teacherPublicKeyDer,
      format: 'der',
      type: 'spki'
    });

    // 3. Diffie-Hellman para secreto compartido
    const sharedSecret = crypto.diffieHellman({
      privateKey: ephPrivKey,
      publicKey: teacherPubKey
    });

    // 4. Derivar clave simétrica de 256 bits mediante HKDF
    const salt = Buffer.alloc(0);
    const info = Buffer.from('uatu-clipboard-envelope-v2', 'utf-8');
    const symmetricKey = crypto.hkdfSync('sha256', sharedSecret, salt, info, 32);

    // 5. Cifrado simétrico AES-256-GCM
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', Buffer.from(symmetricKey), iv);
    
    let encrypted = cipher.update(plaintext, 'utf-8');
    encrypted = Buffer.concat([encrypted, cipher.final()]);
    const authTag = cipher.getAuthTag();

    // 6. Exportar clave pública efímera en formato crudo
    const ephPubKeyRaw = ephPubKey.export({ format: 'der', type: 'spki' });

    return {
      algorithm: 'X25519-AES-256-GCM',
      ephemeral_public_key: Buffer.from(ephPubKeyRaw).toString('base64'),
      iv: iv.toString('base64'),
      auth_tag: authTag.toString('base64'),
      ciphertext_base64: encrypted.toString('base64')
    };
  }

  /**
   * Firma el hash acumulado con la clave Ed25519 del estudiante.
   */
  public static signHash(hashHex: string, studentPrivateKeyDer: Buffer): string {
    const privKey = crypto.createPrivateKey({
      key: studentPrivateKeyDer,
      format: 'der',
      type: 'pkcs8'
    });
    const signature = crypto.sign(null, Buffer.from(hashHex, 'hex'), privKey);
    return signature.toString('hex');
  }
}
```

## 6. Arquitectura de Batching (Micro-Lotes) y Persistencia Offline

Para evitar la saturación de commits en Git y asegurar tolerancia absoluta a cortes de conectividad, se implementa una arquitectura desacoplada en dos capas: **Motor de Ingesta Local (WAL)** y **Daemon de Sincronización Git**.

```
[Eventos del Editor] (Paste, Window Focus, Heartbeat)
         │
         ▼
 ┌────────────────────────────────────────────────────────┐
 │   Write-Ahead Log Local (WAL en SQLite / Disco)        │
 │   - Almacenamiento transaccional en globalStorageUri   │
 │   - Inmediato, duradero, firmado localmente            │
 └────────────────────────────────────────────────────────┘
         │
         ▼
 ┌────────────────────────────────────────────────────────┐
 │   Procesador de Micro-Lotes (Batch Engine)             │
 │   Criterio de Flush:                                   │
 │   - Tiempo: >= batch_interval_seconds (30s)            │
 │   - Tamaño: >= batch_max_events (20 eventos)           │
 │   - Forzado: Guardado crítico / Cierre de IDE          │
 └────────────────────────────────────────────────────────┘
         │
         ▼
 ┌────────────────────────────────────────────────────────┐
 │   Daemon de Sincronización Git con Jitter              │
 │   - Commits atómicos de archivos por lote en orphan    │
 │   - Push diferido con Exponential Backoff + Jitter     │
 └────────────────────────────────────────────────────────┘
         │
         ▼
 [Repositorio Remoto: refs/heads/uatu-audit/<user>/<uuid>]
```

### 6.1. Estructura del Write-Ahead Log (WAL) Local

Para garantizar que un apagado abrupto del sistema no pierda eventos pendientes, cada evento se escribe inmediatamente de forma síncrona en un log estructurado local (`${globalStorageUri}/sessions/${sessionId}/events.wal`):

* **Formato:** Archivo secuencial binario o JSON Lines (`.jsonl`).
* **Estados de transacción:**
  1. `RECORDED`: Asentado en disco local con firma digital y hash computado.
  2. `BATCHED`: Incluido en un lote local empaquetado.
  3. `SYNCED`: Confirmado mediante commit en la rama huérfana local y empujado al remoto con respuesta exitosa.

### 6.2. Esquema del Archivo de Lote (`batch-<seq>.json`)

En lugar de crear un commit por evento individual, el daemon agrupa los eventos acumulados y los persiste en un único archivo dentro de la rama huérfana de Git:

```json
{
  "version": "2.1",
  "batch_sequence_id": 4,
  "session_uuid": "f47ac10b-58cc-4372-a567-0e02b2c3d479",
  "github_user": "estudiante-uba",
  "created_at_utc": "2026-09-24T14:17:30.000Z",
  "head_code_commit": "7b8e1a90c4d23f1b...",
  "batch_start_hash": "e3b0c44298fc1c14...",
  "batch_end_hash": "9c1a5b884210d3e4...",
  "events_count": 3,
  "events": [
    {
      "sequence_id": 18,
      "prev_hash": "e3b0c44298fc1c14...",
      "timestamp_utc": "2026-09-24T14:15:30.120Z",
      "student_public_key": "ed25519:5a9d20c3b4...",
      "event_type": "clipboard_paste",
      "data": {
        "target_file": "src/scheduler.c",
        "range": { "start": [45, 0], "end": [60, 20] },
        "char_count": 312,
        "sha256_plaintext": "b4a8e23...",
        "encrypted_payload": {
          "algorithm": "X25519-AES-256-GCM",
          "ephemeral_public_key": "a8f902...",
          "iv": "d1c2b3a4...",
          "auth_tag": "7b8c9d...",
          "ciphertext_base64": "K8jN3h7f2m0Q..."
        }
      },
      "signature": "8a7c2b..."
    },
    {
      "sequence_id": 19,
      "prev_hash": "9f2b8...",
      "timestamp_utc": "2026-09-24T14:16:10.000Z",
      "student_public_key": "ed25519:5a9d20c3b4...",
      "event_type": "window_focus",
      "data": { "focused": false },
      "signature": "1c4d9e..."
    },
    {
      "sequence_id": 20,
      "prev_hash": "3e4a1...",
      "timestamp_utc": "2026-09-24T14:17:05.450Z",
      "student_public_key": "ed25519:5a9d20c3b4...",
      "event_type": "heartbeat",
      "data": { "uptime_seconds": 1025 },
      "signature": "5f8a2c..."
    }
  ],
  "batch_signature": "ab01cd98..."
}
```

### 6.3. Mitigación de Saturación de Red: Backoff Exponencial con Jitter

Cuando 100 estudiantes terminan un examen simultáneamente o se recupera la red del laboratorio, sincronizar inmediatamente generaría bloqueos por concurrencia y rechazos por cuota de API.

* **Fórmula de Retardo:**
  $$T_{\text{wait}} = \min(T_{\text{max}}, T_{\text{base}} \cdot 2^{\text{attempt}}) \cdot \text{Uniform}(0.8, 1.2)$$
  Donde:
  * $T_{\text{base}} = 2\text{ segundos}$.
  * $T_{\text{max}} = 60\text{ segundos}$.
  * $\text{Uniform}(0.8, 1.2)$ aplica la desincronización (*decorrelated jitter*).

* **Transaccionalidad en Git:**
  El daemon crea un árbol huérfano local utilizando comandos plomería de Git (`git write-tree` y `git commit-tree`) sin alterar el index principal del estudiante. De esta forma, el estudiante puede ejecutar libremente `git add`, `git status` o `git commit` sin interferencia cruzada.

## 7. Especificación del CLI Validador e Integración CI (`uatu-audit`)

El script forense procesa todas las ramas de telemetría de una entrega, verifica la consistencia matemática de los micro-lotes y permite descifrar payloads selectivos mediante la clave privada docente.

### 7.1. Códigos de Salida POSIX
* `0`: **OK.** Integridad criptográfica verificada sin anomalías.
* `1`: **CRITICAL ERROR.** Falla de integridad (cadena rota, firmas no válidas, manipulación de `.uatu.conf` o ausencia de registros).
* `2`: **WARNING.** Cadena íntegra, pero se detectaron alertas heurísticas (pegados masivos que superan el umbral o extensiones no autorizadas).

### 7.2. Script Validador en Python (`uatu_audit.py`)

```python
#!/usr/bin/env python3
"""
Validador de Integridad, Forense y Descifrado Uatu v2.1.
Permite auditar ramas huérfanas con soporte para micro-lotes (batching) y descifrado ECIES.
"""

import os
import sys
import json
import base64
import hashlib
import argparse
import subprocess
from datetime import datetime, timezone
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
from cryptography.hazmat.primitives.asymmetric import x25519
from cryptography.hazmat.primitives.kdf.hkdf import HKDF
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.serialization import load_pem_private_key

class UatuAuditor:
    def __init__(self, repo_path: str, teacher_verify_key_hex: str, 
                 teacher_decrypt_key_pem: str = None, max_paste_chars: int = 50):
        self.repo = repo_path
        self.teacher_verify_key_hex = teacher_verify_key_hex
        self.teacher_decrypt_key_pem = teacher_decrypt_key_pem
        self.max_paste_chars = max_paste_chars
        self.errors = []
        self.warnings = []
        self.sessions = {}
        self.config = {}

    def _git(self, cmd: list) -> str:
        res = subprocess.run(["git", "-C", self.repo] + cmd, capture_output=True, text=True, check=True)
        return res.stdout.strip()

    def verify_config(self) -> dict:
        cfg_path = os.path.join(self.repo, ".uatu.conf")
        if not os.path.exists(cfg_path):
            self.errors.append("Falta el archivo de configuración .uatu.conf.")
            return {}

        with open(cfg_path, "r", encoding="utf-8") as f:
            cfg = json.load(f)

        sig = cfg.get("crypto", {}).get("signature")
        payload = {k: v for k, v in cfg.items() if k != "crypto"}
        canonical = json.dumps(payload, sort_keys=True).encode("utf-8")

        try:
            pub = Ed25519PublicKey.from_public_bytes(bytes.fromhex(self.teacher_verify_key_hex))
            pub.verify(bytes.fromhex(sig), canonical)
        except Exception as e:
            self.errors.append(f"Firma docente en .uatu.conf INVÁLIDA: {str(e)}")
        
        self.config = cfg
        return cfg

    def discover_telemetry_branches(self, prefix: str = "uatu-audit") -> list:
        try:
            branches_raw = self._git(["branch", "-r", "--list", f"origin/{prefix}/*"])
            branches = [b.strip().replace("origin/", "") for b in branches_raw.splitlines() if b.strip()]
            if not branches:
                self.errors.append(f"No se encontraron ramas de telemetría con prefijo '{prefix}'.")
            return branches
        except subprocess.CalledProcessError as e:
            self.errors.append(f"Fallo al listar ramas de Git: {e.stderr}")
            return []

    def load_branch_batches(self, branch: str) -> list:
        batches = []
        try:
            commits = self._git(["log", f"origin/{branch}", "--pretty=format:%H", "--reverse"]).splitlines()
            for commit_sha in commits:
                tree_files = self._git(["ls-tree", "-r", "--name-only", commit_sha]).splitlines()
                for filename in tree_files:
                    if filename.endswith(".json"):
                        content = self._git(["show", f"{commit_sha}:{filename}"])
                        parsed = json.loads(content)
                        if "events" in parsed:
                            batches.append(parsed)
                        else:
                            batches.append({"events": [parsed]})
            return batches
        except Exception as e:
            self.errors.append(f"Error procesando eventos en rama {branch}: {str(e)}")
            return []

    def decrypt_payload(self, enc_dict: dict) -> str:
        if not self.teacher_decrypt_key_pem:
            return "[Descifrado omitido: Clave privada no provista]"

        try:
            with open(self.teacher_decrypt_key_pem, "rb") as f:
                priv_key = load_pem_private_key(f.read(), password=None)

            ephemeral_bytes = base64.b64decode(enc_dict["ephemeral_public_key"])
            iv = base64.b64decode(enc_dict["iv"])
            tag = base64.b64decode(enc_dict["auth_tag"])
            ciphertext = base64.b64decode(enc_dict["ciphertext_base64"])

            peer_public_key = x25519.X25519PublicKey.from_public_bytes(ephemeral_bytes[-32:])
            shared_secret = priv_key.exchange(peer_public_key)

            derived_key = HKDF(
                algorithm=hashes.SHA256(),
                length=32,
                salt=b"",
                info=b"uatu-clipboard-envelope-v2"
            ).derive(shared_secret)

            aesgcm = AESGCM(derived_key)
            plaintext_bytes = aesgcm.decrypt(iv, ciphertext + tag, None)
            return plaintext_bytes.decode("utf-8")
        except Exception as e:
            return f"[Fallo al descifrar contenido: {str(e)}]"

    def audit_session(self, branch: str, batches: list):
        if not batches:
            return

        all_events = []
        for b in batches:
            all_events.extend(b.get("events", []))
        all_events.sort(key=lambda x: x.get("sequence_id", 0))

        if not all_events:
            return

        genesis = all_events[0]
        student_key_hex = genesis.get("student_public_key", "").replace("ed25519:", "")
        if not student_key_hex:
            self.errors.append(f"Sesión {branch} carece de student_public_key en génesis.")
            return

        student_pub = Ed25519PublicKey.from_public_bytes(bytes.fromhex(student_key_hex))
        expected_prev_hash = ""

        # Ventana temporal de configuración
        session_cfg = self.config.get("session", {})
        start_utc_str = session_cfg.get("start_utc")
        deadline_utc_str = session_cfg.get("deadline_utc")
        start_dt = datetime.fromisoformat(start_utc_str.replace("Z", "+00:00")) if start_utc_str else None
        deadline_dt = datetime.fromisoformat(deadline_utc_str.replace("Z", "+00:00")) if deadline_utc_str else None

        for idx, ev in enumerate(all_events):
            seq = ev.get("sequence_id", idx)
            prev_hash = ev.get("prev_hash")
            ev_time_str = ev.get("timestamp_utc")

            # Validación de ventana temporal
            if ev_time_str and (start_dt or deadline_dt):
                ev_dt = datetime.fromisoformat(ev_time_str.replace("Z", "+00:00"))
                if start_dt and ev_dt < start_dt:
                    self.errors.append(f"[{branch}] Evento {seq} registrado antes de start_utc ({ev_time_str} < {start_utc_str}).")
                if deadline_dt and ev_dt > deadline_dt:
                    self.warnings.append(f"[{branch}] Evento {seq} emitido con posterioridad al deadline_utc ({ev_time_str} > {deadline_utc_str}).")

            if idx > 0 and prev_hash != expected_prev_hash:
                self.errors.append(f"[{branch}] Ruptura de hash-chain en seq {seq}: {prev_hash} != {expected_prev_hash}")

            sig = ev.get("signature")
            payload = {k: v for k, v in ev.items() if k != "signature"}
            payload_bytes = json.dumps(payload, sort_keys=True).encode("utf-8")

            try:
                student_pub.verify(bytes.fromhex(sig), payload_bytes)
            except Exception:
                self.errors.append(f"[{branch}] Firma digital del estudiante inválida en seq {seq}.")

            # Reglas heurísticas
            if ev.get("event_type") == "clipboard_paste":
                data = ev.get("data", {})
                chars = data.get("char_count", 0)
                if chars > self.max_paste_chars:
                    decrypted_text = ""
                    if "encrypted_payload" in data:
                        decrypted_text = self.decrypt_payload(data["encrypted_payload"])

                    self.warnings.append(
                        f"[{ev.get('github_user')}] Pegado masivo ({chars} chars) en seq {seq} sobre '{data.get('target_file')}'. "
                        f"Snippet: {decrypted_text[:100]}..."
                    )

            expected_prev_hash = hashlib.sha256(payload_bytes).hexdigest()

    def run(self):
        cfg = self.verify_config()
        if not cfg:
            return

        prefix = cfg.get("git", {}).get("telemetry_branch_prefix", "uatu-audit")
        branches = self.discover_telemetry_branches(prefix)
        for b in branches:
            batches = self.load_branch_batches(b)
            self.sessions[b] = batches
            self.audit_session(b, batches)

    def write_summary(self, path: str):
        status = "❌ FALLO / MANIPULACIÓN" if self.errors else ("⚠️ ADVERTENCIAS" if self.warnings else "✅ AUDITORÍA LIMPIA")
        total_batches = sum(len(b) for b in self.sessions.values())
        total_events = sum(sum(len(batch.get("events", [])) for batch in b) for b in self.sessions.values())

        with open(path, "w", encoding="utf-8") as f:
            f.write(f"# Reporte de Auditoría Uatu: {status}\n\n")
            f.write(f"- **Ramas/Sesiones Auditadas:** {len(self.sessions)}\n")
            f.write(f"- **Micro-Lotes Procesados:** {total_batches}\n")
            f.write(f"- **Total de Eventos Verificados:** {total_events}\n")
            f.write(f"- **Errores Críticos:** {len(self.errors)}\n")
            f.write(f"- **Advertencias / Pegados:** {len(self.warnings)}\n\n")

            if self.errors:
                f.write("### Violaciones Críticas de Integridad\n")
                for err in self.errors:
                    f.write(f"- 🔴 {err}\n")
                f.write("\n")

            if self.warnings:
                f.write("### Evidencia de Pegado y Heurísticas\n")
                for w in self.warnings:
                    f.write(f"- 🟡 {w}\n")

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Validador Forense Uatu v2.1")
    parser.add_argument("--repo", default=".")
    parser.add_argument("--teacher-key", required=True, help="Clave pública Ed25519 docente (hex)")
    parser.add_argument("--decrypt-key", default=None, help="Clave privada docente X25519 (PEM) para descifrado")
    parser.add_argument("--md-out", default="summary.md")
    args = parser.parse_args()

    auditor = UatuAuditor(args.repo, args.teacher_key, args.decrypt_key)
    auditor.run()
    auditor.write_summary(args.md_out)

    if auditor.errors:
        sys.exit(1)
    if auditor.warnings:
        sys.exit(2)
    sys.exit(0)
```

## 8. Workflow en GitHub Actions (`workflow_dispatch`)

```yaml
name: "Evaluación Forense Uatu"

on:
  workflow_dispatch:
    inputs:
      target_user:
        description: 'Usuario de GitHub a auditar (vacío para auditar todos)'
        required: false
        default: ''

jobs:
  audit-session:
    runs-on: ubuntu-latest
    steps:
      - name: Clonar repositorio completo
        uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - name: Descargar ramas de auditoría
        run: |
          git fetch origin '+refs/heads/uatu-audit/*:refs/remotes/origin/uatu-audit/*'

      - name: Configurar Entorno Python
        uses: actions/setup-python@v5
        with:
          python-version: '3.11'

      - name: Instalar Dependencias Criptográficas
        run: pip install cryptography

      - name: Ejecutar Auditoría Forense
        env:
          TEACHER_VERIFY_KEY: ${{ secrets.UATU_TEACHER_PUBLIC_KEY }}
          TEACHER_DECRYPT_KEY: ${{ secrets.UATU_TEACHER_PRIVATE_KEY }}
        run: |
          echo "$TEACHER_DECRYPT_KEY" > /tmp/teacher_priv.pem
          python scripts/uatu_audit.py \
            --repo . \
            --teacher-key "$TEACHER_VERIFY_KEY" \
            --decrypt-key /tmp/teacher_priv.pem \
            --md-out uatu_report.md
          rm -f /tmp/teacher_priv.pem
          cat uatu_report.md >> $GITHUB_STEP_SUMMARY

      - name: Publicar Artefacto de Reporte
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: reporte-uatu
          path: uatu_report.md
```

## 9. Matriz de Vectores de Ataque y Mitigación

| Vector de Ataque | Método del Estudiante | Contramedida Técnica en uatu |
| :--- | :--- | :--- |
| **Manipulación Temporal** | Modificar el reloj del sistema operativo para activar/desactivar la sesión antes de tiempo. | Correlación cruzada entre timestamps locales y timestamps de commits remotos de Git; la auditoría en CI valida que los eventos respeten rígidamente `start_utc` y `deadline_utc`. |
| **Tampering de la Rama** | Modificar commits de telemetría o forzar rebase (`push --force`). | Las reglas de protección de rama impiden force-push a `uatu-audit/*`. Además, la ruptura de la cadena criptográfica invalida la auditoría. |
| **Alteración de Reglas** | Modificar `.uatu.conf` para ensanchar la ventana temporal o relajar monitoreo. | La firma de cátedra falla en la extensión y en el CI; el bloque génesis $H_0$ diverge. |
| **Suplantación de Identidad** | Clonar el repositorio desde otra cuenta local de Git. | La extensión verifica la sesión activa de GitHub mediante `vscode.authentication` y ancla el handle al bloque génesis criptográfico. |
| **Pegado fuera de VS Code** | Abrir archivos en editores externos (Vim, Notepad), pegar código y guardar. | `onDidChangeTextDocument` detecta un cambio masivo proveniente de disco sin eventos previos de tipeo ni foco activo en el editor. |
| **Desactivación de Extensión** | Desinstalar o deshabilitar la extensión durante el examen. | El repositorio remoto deja de recibir lotes en su rama de auditoría. El validador detecta lapsos de silencio incompatibles con los commits de código en `main`. |
| **Ataque de Repetición / Colisión Concurrente** | Abrir múltiples pestañas para bifurcar la telemetría. | Cada instancia posee un $UUID_{\text{v4}}$ independiente que crea su propia rama huérfana aislada; el validador consolida ambos grafos cronológicamente. |

## 10. Aspectos Técnicos Refinados en Esta Versión

1. **Condicionalidad Temporal de Activación (Time-Gating):** Especificada la máquina de estados completa en la Sección 3.1 para gobernar las transiciones entre `STANDBY` ($T < \text{start\_utc}$), `ACTIVO` ($\text{start\_utc} \le T \le \text{deadline\_utc}$) y `CONCLUIDO` ($T > \text{deadline\_utc}$).
2. **Validación Forense de Marcas Temporales:** Incorporada en el validador Python (`uatu_audit.py`) la verificación contra la ventana temporal declarada en el manifiesto firmado.
3. **Cifrado Híbrido Asimétrico Operativo:** Esquema ECIES formal (X25519 + HKDF-SHA256 + AES-256-GCM) en TypeScript y script de descifrado en Python.
4. **Estrategia de Micro-Lotes (Batching) y Persistencia:** Definido el formato `batch-<seq>.json`, la cola WAL y el algoritmo de sincronización con backoff y *jitter*.