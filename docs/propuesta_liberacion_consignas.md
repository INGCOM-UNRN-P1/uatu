# Propuesta: liberación de consignas con bloqueo de tiempo

Estado: **implementada** (21/10/26, Ola 9) con un cambio respecto del diseño
original (ver «Implementación»). Origen: decisión 1 de la remediación del
ecosistema — keymaker se retira y esta función pasa a uatu.

## Implementación (21/10/26)

El diseño de abajo liberaba la consigna con un workflow `liberar-consigna.yml`
en cada repositorio del estudiante, con la clave como secreto de la
organización. Eso no cumple el requisito 1: el estudiante tiene permiso de
escritura en su repositorio, puede editar ese workflow (o agregar otro) y hacer
que imprima `UATU_CONSIGNA_KEY` antes de `start_utc`. Por eso la liberación la
hace el docente y ningún secreto llega a los repositorios de los estudiantes:

1. `uatu-admin consigna sellar <carpeta> [--key-id ID]` cifra la consigna
   (AES-256-GCM, el hash como dato asociado), escribe `consigna.enc` y la clave
   en `consigna.enc.clave` (0600, fuera de los repositorios) y agrega
   `"consigna": {"carpeta": "consigna", "sha256": …}` al `.uatu.conf`, que se
   firma como siempre.
2. `uatu-admin consigna liberar --org ORG --prefijo PREFIJO [--esperar]`
   consulta la hora del servidor de GitHub (cabecera `Date`); antes de
   `start_utc` sale con 3 sin descifrar nada (o, con `--esperar`, espera).
   Después descifra en memoria y publica `consigna/` en cada repositorio con la
   API de Git: un commit `uatu: liberar consigna (…)` sin autor explícito, con
   la fecha del servidor. Es idempotente: volver a correrlo reintenta sólo los
   repositorios que fallaron.
3. La extensión, al pasar a EN SESIÓN, hace `git pull --ff-only` de la rama
   actual hasta que la consigna llega (cada 20 s), compara su hash con el del
   manifiesto firmado y registra `consigna_verificada`.
4. `uatu-audit` marca como error una liberación anterior a `start_utc`, un
   contenido distinto del sellado o una consigna que entró por otro commit, y
   como advertencia una consigna no liberada o un `consigna_verificada` que no
   coincide.

El hash de una carpeta es SHA-256 de las líneas `<ruta con />\n<sha256 del
archivo>\n` ordenadas por ruta: lo calculan igual uatu-admin (`consigna
hash`), uatu-audit y la extensión.

Lo que se resignó: la liberación depende de que el docente corra el comando
(con `--esperar` puede lanzarlo antes y queda esperando la hora); no hay
liberación automática por cron.

## Problema

La consigna de un examen práctico no debe poder leerse antes de `start_utc`.
Hoy la cátedra la reparte a mano o confía en el Time-Lock de keymaker, que es
solo disuasivo: compara la hora con el reloj de la máquina que abre el paquete
y quien tiene la frase de paso lo abre antes (N-KEYMAKER-01). uatu ya conoce la
ventana del examen (`start_utc`/`deadline_utc` en el `.uatu.conf` firmado) y el
mismo problema de reloj, que resuelve en la auditoría contrastando con los
commits remotos (SPEC §3.1). Falta que la consigna misma respete esa ventana.

## Requisitos

1. Antes de `start_utc` ningún estudiante tiene en su máquina nada que permita
   leer la consigna (ni texto ni clave).
2. La hora que manda es la de un servidor (GitHub), no la del estudiante.
3. El estudiante puede verificar que la consigna es la de la cátedra
   (firma) y que es la misma para todos (hash en el `.uatu.conf` firmado).
4. La auditoría (`uatu-audit`) puede comprobar a posteriori cuándo se liberó.
5. Funciona con GitHub Classroom (un repositorio por estudiante) y sin
   servicios propios.

## Diseño propuesto

```
antes del examen                         en start_utc                         durante
────────────────                         ────────────                         ───────
uatu-admin consigna sellar               uatu-admin consigna liberar          extensión
  consigna/ → consigna.enc (AES-256-GCM)   (o el cron del workflow)             PRE-EXAMEN → EN SESIÓN:
  clave → secreto UATU_CONSIGNA_KEY        workflow `liberar-consigna`          git pull, verifica firma
  hash + firma → .uatu.conf                  en cada repo: descifra con el      y hash, abre consigna/
                                             secreto y commitea consigna/
```

1. **Sellado** (`uatu-admin consigna sellar <carpeta>`): cifra la consigna
   con una clave aleatoria (AES-256-GCM), agrega `consigna.enc` a la plantilla
   del examen y guarda la clave como secreto de la organización
   (`UATU_CONSIGNA_KEY`, con el mismo mecanismo que `uatu-admin` ya usa para los
   secretos de GitHub). En `.uatu.conf` se agregan `consigna_sha256` (del texto
   plano) y se firma como hoy. La clave nunca está en un repositorio ni en la
   máquina del estudiante.
2. **Liberación**: un workflow `liberar-consigna.yml` de la plantilla descifra
   `consigna.enc` con el secreto y commitea `consigna/` en la rama principal.
   Se dispara por `workflow_dispatch` desde `uatu-admin consigna liberar
   --organizacion … --prefijo …` en `start_utc` (preciso), con un `schedule`
   de respaldo (el cron de GitHub puede demorarse minutos). El workflow se
   niega a correr antes de `start_utc` usando la hora del runner.
3. **Lectura**: en `PRE-EXAMEN` la extensión ya agenda la activación para
   `start_utc`; al pasar a `EN SESIÓN` hace `git pull`, verifica que el hash de
   `consigna/` coincida con `consigna_sha256` del `.uatu.conf` firmado y la abre.
   Si todavía no llegó, reintenta con el backoff que ya usa para sincronizar.
4. **Auditoría**: `uatu-audit` comprueba que el commit de liberación sea del
   workflow (autor `github-actions`), con fecha de servidor ≥ `start_utc`, y
   que el contenido coincida con el hash firmado. Un evento de la extensión
   anterior a ese commit que toque `consigna/` es una alerta.

## Qué se reutiliza

- De **uatu**: firma Ed25519 del `.uatu.conf`, `start_utc`, la máquina de
  estados de la extensión, el backoff de sincronización y `uatu-admin` para
  secretos de GitHub.
- De **keymaker** (antes de archivarlo): el cifrado AES-256-GCM de paquetes y
  sus pruebas. Shamir, el almacén de confianza propio y el Time-Lock por reloj
  local no se portan.

## Alternativas descartadas

| Alternativa                                   | Por qué no                                                                                               |
| :-------------------------------------------- | :------------------------------------------------------------------------------------------------------- |
| Time-Lock por reloj local (keymaker)          | Disuasivo: el estudiante adelanta el reloj o descifra con otra herramienta.                               |
| Repartir la frase de paso a la hora de inicio | Funciona, pero es manual y no deja rastro auditable de cuándo se liberó.                                  |
| Cifrado temporal con drand (`tlock`)          | No necesita servidor propio, pero agrega una dependencia externa y una red de terceros en el examen.      |
| Crear los repositorios recién en `start_utc`  | Classroom tarda en crear decenas de repositorios y el estudiante pierde tiempo de examen clonando.        |

## Preguntas abiertas

1. ¿La consigna va en la rama principal o en una rama `consigna` de solo
   lectura (protección de ramas con `uatu-admin`)?
2. ¿Tiempo extendido (accesibilidad): una segunda liberación por repositorio
   con su propio `start_utc`, o la misma consigna con `deadline_utc` propio?
3. ¿Qué pasa si el workflow falla en algunos repositorios? Propuesta:
   `uatu-admin consigna liberar` informa cuáles fallaron y permite reintentar.

## Fases

1. `uatu-admin consigna sellar` y el workflow `liberar-consigna.yml` en
   `templates/exam-repo/`, con pruebas de que no corre antes de hora.
2. Verificación del hash en la extensión al entrar en sesión.
3. Reglas de auditoría en `uatu-audit`.
