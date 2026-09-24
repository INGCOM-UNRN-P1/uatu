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

## Estados en la barra inferior

| Indicador | Significado |
|---|---|
| `Uatu: Inactivo` | No hay examen en este workspace. |
| `Uatu: Esperando inicio (HH:mm UTC)` | El examen todavía no comenzó; no se registra nada. |
| `Uatu: @usuario (Lote: B, Eventos: N)` | Sesión activa. |
| `Uatu: Examen Concluido` | La ventana terminó y se sincronizó la telemetría. |
| `Uatu: Error de integridad` | El manifiesto fue alterado o no pudo verificarse. |

## Comandos

- **Uatu: Mostrar estado de la sesión**
- **Uatu: Iniciar / reintentar sesión de examen**
- **Uatu: Sincronizar telemetría ahora**
- **Uatu: Mostrar registro**
