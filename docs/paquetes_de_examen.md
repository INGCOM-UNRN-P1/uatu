# Paquetes de examen por estudiante

Con la consigna sellada ([propuesta](propuesta_liberacion_consignas.md)), todos reciben lo mismo. Con
un paquete, cada estudiante recibe su tema, cifrado y con anticipación, y su equipo lo descifra
cuando llega la clave. Un examen usa uno de los dos: el `.uatu.conf` no admite ambos bloques.

## Flujo

```bash
alucard build -d parcial.yaml -n 3 -o temas
alucard repartir temas --padron padron.txt -o repartidos   # repartidos/<usuario>/examen.pdf
uatu-admin paquetes sellar repartidos --key-id prof-lead-2026
uatu-admin paquetes distribuir --org ORG --prefijo parcial-1   # días antes
uatu-admin paquetes liberar --org ORG --prefijo parcial-1 --esperar
```

| Paso | Qué hace |
| :-- | :-- |
| `sellar` | Cifra cada carpeta con AES-256-GCM y una clave propia. Agrega a `.uatu.conf` un hash por usuario, bajo la firma docente. Las claves quedan en `paquetes.claves` (0600). |
| `distribuir` | Publica `.uatu-paquete.enc` en `<prefijo>-<usuario>`. Se puede hacer en cualquier momento. |
| `liberar` | Con la hora de GitHub después de `start_utc`, publica `.uatu-paquete.clave` en cada repositorio. Antes sale con 3 sin leer las claves. Es idempotente: si falla, se vuelve a correr. |
| Extensión | En sesión, trae la clave cada 20 s y descifra en `consigna/`. Nunca pisa un archivo que ya existe. |
| `uatu-audit` | Marca como error una clave anterior a `start_utc`, que entró por otro commit o que no abre el paquete, un paquete que no es el sellado y las sesiones de otro usuario. |

Los repositorios tienen que ser privados: la clave de cada estudiante viaja en el suyo.

## Qué protege y qué no

**La protección es del servidor.** Antes de `start_utc` la clave no está en el equipo del estudiante, y
después sólo llega a su repositorio. Por eso no puede abrir antes de hora ni abrir el paquete de otro,
aunque modifique la extensión o cambie el reloj.

**Los controles de la extensión son evidencia.** Compara el usuario de GitHub con el del paquete y la
hora calibrada con la ventana del examen, y registra `paquete_abierto` o `paquete_rechazado`. Quien
controla su equipo puede saltearlos, y con su propia clave descifrar a mano: es su examen, ya en
horario, y `uatu-audit` lo ve porque falta el evento.

| Control | Si falla | Motivo |
| :-- | :-- | :-- |
| Usuario de GitHub con paquete | No descifra | `usuario_sin_paquete` |
| Usuario igual al dueño del paquete | No descifra | `paquete_de_otro` |
| Hash igual al firmado | No descifra | `paquete_no_sellado` |
| Hora dentro de la ventana | No descifra | `fuera_de_hora` |
| Clave correcta | No descifra | `clave_incorrecta` |
| Rutas dentro de la carpeta | No descifra | `ruta_invalida` |

Sin reloj calibrado (no se pudo leer la hora del registro de claves), la hora local no decide: la
clave presente ya prueba que el servidor pasó `start_utc`. Se descifra, y `uatu-audit` lo avisa porque
`clock_source` no es `http-date`. Frenar a un estudiante en pleno examen no agregaría seguridad.

**No impide** que un estudiante le pase su examen a otro una vez empezado, igual que en papel.

## Formato

`.uatu-paquete.enc` es JSON: `formato` (`uatu-paquete-v1`), `algoritmo`, `usuario`, `sha256`, `nonce` y
`datos` (cifrado con la etiqueta al final, en base64). El dato asociado es
`uatu-paquete-v1:<usuario>:<sha256>`, así que ni el dueño ni el hash se cambian sin la clave. El plano
es `{ruta: contenido en base64}`.

El hash es SHA-256 de `<usuario>\n<hash de los archivos>\n`, con el hash de carpeta de la consigna.
Incluye al usuario porque el `.uatu.conf` está en todos los repositorios: con el hash del contenido
se vería quiénes comparten tema. Los usuarios van en minúsculas, porque GitHub no las distingue.
