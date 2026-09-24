# uatu

Sistema de proctorización y auditoría criptográfica **Git-native** para
evaluaciones prácticas de código en VS Code. En lugar de video o monitoreo del
sistema operativo, uatu registra evidencia verificable (pegados, inserciones
externas, foco de ventana y extensiones prohibidas) en ramas huérfanas del propio
repositorio del estudiante. El contenido del portapapeles viaja cifrado para
la cátedra, y la cadena de eventos queda firmada.

La especificación completa está en [`SPEC.md`](SPEC.md) y los formatos exactos en
[`docs/protocolo.md`](docs/protocolo.md).

## Componentes

| Ruta | Descripción |
|---|---|
| `extension/` | Extensión de VS Code (TypeScript): time-gating, identidad GitHub, disclaimer Fair Play, observadores, hash-chain Ed25519, cifrado ECIES, WAL, micro-lotes y sincronización Git con backoff y jitter. |
| `templates/exam-repo/` | Workflow `workflow_dispatch` de evaluación forense y manifiesto de ejemplo para el repositorio del examen. |

Las herramientas Python viven en un repositorio aparte,
[**uatu-tools**](https://github.com/INGCOM-UNRN-P1/uatu-tools): `uatu-audit`
(validador forense para CI: firmas, cadena, lotes, génesis, heurísticas y
descifrado; códigos de salida 0/1/2) y `uatu-admin` (claves raíz y docentes,
registro de claves y firma de `.uatu.conf`).

```
Repositorio del estudiante (origin)
├── refs/heads/main                                   <- código de la solución
└── refs/heads/uatu-audit/<github_user>/<session_uuid> <- rama huérfana de telemetría
    └── batches/batch-000000.json, batch-000001.json, ...
```

## Flujo para la cátedra

Las herramientas se instalan con [uv](https://docs.astral.sh/uv/) (Python 3.9+):

```bash
uv tool install "git+https://github.com/INGCOM-UNRN-P1/uatu-tools"
```

Esto deja disponibles `uatu-admin` y `uatu-audit`. Sin instalar nada, se
puede usar `uvx --from "git+https://github.com/INGCOM-UNRN-P1/uatu-tools" uatu-admin ...`.

1. **Clave raíz institucional** (una vez):

   ```bash
   uatu-admin root-keygen --out secretos/ --key-id uba-root-2026
   ```

   Copiar el `anchor` que imprime en `extension/resources/trust-anchors.json`
   y empaquetar la extensión (`cd extension && npm ci && npm run package`).

2. **Claves del docente** y **registro público**:

   ```bash
   uatu-admin keygen --out secretos/ --key-id prof-lead-2026
   uatu-admin registry-add --registry keys.json --key-id prof-lead-2026 \
       --verify-key <ed25519_verify_key> --encrypt-key <x25519_encryption_key>
   uatu-admin registry-sign --registry keys.json \
       --root-key secretos/uba-root-2026.root.pem --root-key-id uba-root-2026
   ```

   Publicar `keys.json` en la URL de `auth.public_key_registry_url` (HTTPS).

3. **Manifiesto del examen**: partir de `templates/exam-repo/uatu.conf.example`,
   ajustar la ventana y firmarlo:

   ```bash
   uatu-admin sign-config --config .uatu.conf \
       --key secretos/prof-lead-2026.ed25519.pem --key-id prof-lead-2026
   ```

4. **Repositorio plantilla del examen** (p. ej. GitHub Classroom): incluir
   `.uatu.conf` y `templates/exam-repo/.github/workflows/uatu-audit.yml`.
   Configurar los secretos `UATU_TEACHER_PUBLIC_KEY` (Ed25519 en hex) y
   `UATU_TEACHER_PRIVATE_KEY` (PEM X25519), y una regla de protección que
   impida force-push y borrado sobre `uatu-audit/**`. El workflow clona
   uatu-tools y lo instala con `uv tool install`; la variable opcional
   `UATU_TOOLS_REF` fija una versión (p. ej. `v2.1.0`).

5. **Evaluación**: ejecutar el workflow *Evaluación Forense Uatu* (todos los
   usuarios o uno en particular) o, localmente:

   ```bash
   git fetch origin '+refs/heads/uatu-audit/*:refs/remotes/origin/uatu-audit/*'
   uatu-audit --repo . --teacher-key <hex> \
       --decrypt-key secretos/prof-lead-2026.x25519.pem --md-out reporte.md
   ```

## Qué ve y qué registra el estudiante

Con `.uatu.conf` presente y firma válida, la extensión:

- antes de `start_utc` muestra `$(clock) Uatu: Esperando inicio (HH:mm UTC)` y no registra nada;
- al iniciar la ventana pide la sesión de GitHub y muestra un modal de consentimiento;
- durante el examen registra inserciones masivas (con el contenido cifrado solo
  para la cátedra), pérdidas de foco, extensiones prohibidas y latidos, y los
  empuja a su rama de auditoría sin tocar el working tree ni el index;
- después de `deadline_utc` desmonta los observadores, vuelca lo pendiente y
  muestra `$(check) Uatu: Examen Concluido`.

Ante cortes de red o cierres abruptos, los eventos quedan en un WAL local
y se sincronizan en la siguiente apertura.

## Releases

Al empujar un tag `vX.Y.Z` (igual a la versión de `extension/package.json`), el
workflow *Release* corre las pruebas, empaqueta la extensión y publica un
GitHub Release con `uatu-X.Y.Z.vsix`, el alias estable `uatu.vsix` y
`SHA256SUMS`:

```bash
# Publicar
git tag v2.1.0 && git push origin v2.1.0

# Instalar la última versión en un laboratorio
curl -LO https://github.com/INGCOM-UNRN-P1/uatu/releases/latest/download/uatu.vsix
code --install-extension uatu.vsix
```

Las anclas raíz institucionales se embeben al empaquetar desde la variable de
repositorio `UATU_TRUST_ANCHORS` (JSON con el formato de
`extension/resources/trust-anchors.json`; son claves públicas). Sin ella, el
workflow avisa y el VSIX queda sin anclas: la extensión reporta *Error de
integridad* en cualquier examen.

## Desarrollo

```bash
# Extensión: compilación y pruebas
cd extension && npm ci && npm test
```

Las pruebas de interoperabilidad auditan la telemetría generada por la
extensión con `uatu-audit`: usan el comando instalado con `uv tool install`
o, si se define `UATU_TOOLS_DIR=../uatu-tools`, un clon local vía
`uv run --project`. Si ninguno está disponible, esas pruebas se omiten.

Para probar la extensión en VS Code: abrir `extension/` y ejecutar
*Run Extension* (F5), o instalar el VSIX generado por `npm run package`.
