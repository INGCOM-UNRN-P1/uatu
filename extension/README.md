# Uatu — Auditoría Git-Native de Exámenes

Extensión de supervisión **transparente** para evaluaciones prácticas de código.
Solo se activa en workspaces que contienen un manifiesto `.uatu.conf` firmado por
la cátedra, y únicamente durante la ventana horaria del examen.

## Qué registra

Después de que usted acepta el modal de consentimiento *Fair Play*:

- **Inserciones masivas** de texto (pegados o cambios externos que superan el
  umbral del examen): archivo, posición, longitud y hash. El contenido se
  **cifra** con la clave pública de la cátedra: nadie más puede leerlo.
- **Foco de la ventana**: cuándo VS Code pierde y recupera el foco.
- **Extensiones no permitidas** instaladas o activas durante el examen.
- **Latidos** periódicos que acreditan que la supervisión siguió activa.

No registra pulsaciones de teclado, capturas de pantalla, cámara, micrófono ni
actividad fuera de VS Code.

## Dónde queda la información

Cada evento se firma con una clave generada para su sesión y se encadena con el
anterior. Los eventos se agrupan en lotes que se guardan en la rama
`uatu-audit/<su-usuario>/<sesión>` de su repositorio. Esa rama no comparte
historia con `main`, y la extensión nunca modifica sus archivos, su index ni sus
commits.

## Panel lateral

El ícono **Uatu** de la barra de actividad (o un clic en la barra de estado)
abre dos vistas:

- **Monitoreo**: fase del examen con cuenta regresiva, datos de la sesión, qué
  monitores están activos y su estado, sincronización con el repositorio y
  calibración del reloj.
- **Bitácora**: cada evento registrado con su hora, un resumen y su estado
  (*registrado*, *en lote* o *sincronizado*). Se puede agrupar por lote, por
  tipo o cronológicamente, ver el detalle de cada evento con su hash y su firma,
  y copiar el hash. El contenido de los pegados solo aparece cifrado.

## Estados en la barra inferior

| Indicador | Significado |
|---|---|
| `Uatu: Inactivo` | No hay examen en este workspace. |
| `Uatu: Esperando inicio (HH:mm UTC)` | El examen todavía no comenzó; no se registra nada. |
| `Uatu: @usuario (Lote: B, Eventos: N)` | Sesión activa. |
| `Uatu: Examen Concluido` | La ventana terminó y se sincronizó la telemetría. |
| `Uatu: Error de integridad` | El manifiesto fue alterado o no pudo verificarse. |

## Comandos

- **Uatu: Abrir panel de monitoreo**
- **Uatu: Mostrar estado de la sesión**
- **Uatu: Iniciar / reintentar sesión de examen**
- **Uatu: Sincronizar telemetría ahora**
- **Uatu: Mostrar registro**
- **Uatu: Abrir carpeta local de la sesión**

Manual completo: <https://github.com/INGCOM-UNRN-P1/uatu/blob/main/manual/index.md>
