import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { ManifestError, parseManifest } from '../src/config/manifest';
import { checkEnvironment, EnvInputs, formatReport, overallStatus } from '../src/checks/checkEnv';
import { baseManifest } from './helpers';

const ANTES = Date.parse('2026-09-24T12:00:00Z');

function entradas(overrides: Partial<EnvInputs> = {}, manifiesto: Record<string, unknown> = {}): EnvInputs {
  return {
    manifest: parseManifest(JSON.stringify(baseManifest(manifiesto))),
    signature: { kind: 'valid' },
    nowMs: ANTES,
    clockOffsetMs: 200,
    extensions: [{ id: 'uatu.uatu', version: '2.1.0', isActive: true }],
    ownExtensionId: 'uatu.uatu',
    readSetting: () => undefined,
    workspaceTrusted: true,
    git: { available: true, version: 'git version 2.47', repoRoot: '/r', remoteUrl: 'https://github.com/x/y', userName: 'alumna' },
    tools: [{ name: 'gcc', found: true, version: 'gcc 14' }, { name: 'make', found: true }],
    ...overrides,
  };
}

const porId = (i: EnvInputs) => Object.fromEntries(checkEnvironment(i).map((c) => [c.id, c]));

test('un equipo preparado da todo ok antes de la hora', () => {
  const checks = checkEnvironment(entradas());
  assert.equal(overallStatus(checks), 'ok', formatReport(checks));
  assert.match(porId(entradas()).ventana.detail, /Empieza a las 13:00 UTC/);
});

test('extensiones y configuración prohibidas son fallas, con cómo resolverlas', () => {
  const c = porId(
    entradas(
      {
        extensions: [{ id: 'GitHub.Copilot', version: '1', isActive: true }, { id: 'uatu.uatu', version: '2', isActive: true }],
        readSetting: (k) => (k === 'github.copilot.enable' ? { '*': true } : undefined),
      },
      {
        monitoring: {
          disallowed_extensions: ['github.copilot'],
          setting_rules: [{ key: 'github.copilot.enable', forbid: true, note: 'sin asistentes' }],
        },
      }
    )
  );
  assert.equal(c.extensiones.status, 'fail');
  assert.match(c.extensiones.detail, /github\.copilot/);
  assert.ok(c.extensiones.fix);
  assert.equal(c.configuracion.status, 'fail');
  assert.match(c.configuracion.detail, /github\.copilot\.enable .*sin asistentes/);
});

test('firma, ventana, reloj, git y herramientas', () => {
  assert.equal(porId(entradas({ signature: { kind: 'invalid' } })).firma.status, 'fail');
  assert.equal(porId(entradas({ signature: { kind: 'unverified', reason: 'sin red' } })).firma.status, 'warn');
  assert.equal(porId(entradas({ nowMs: Date.parse('2026-09-24T17:00:00Z') })).ventana.status, 'fail');
  const reloj = porId(entradas({ clockOffsetMs: 90_000 })).reloj;
  assert.equal(reloj.status, 'warn');
  assert.match(reloj.detail, /90 s atrasado/);
  assert.equal(porId(entradas({ clockOffsetMs: undefined })).reloj.status, 'warn');
  assert.equal(porId(entradas({ git: { available: false } })).git.status, 'fail');
  assert.equal(porId(entradas({ git: { available: true, repoRoot: '/r' } })).git.status, 'fail');
  assert.equal(porId(entradas({ tools: [{ name: 'gcc', found: false }] }))['herramienta:gcc'].status, 'fail');
  assert.equal(porId(entradas({ workspaceTrusted: false })).confianza.status, 'fail');
});

test('sin require_github_auth, la identidad de git es obligatoria', () => {
  const sinUsuario = { available: true, repoRoot: '/r', remoteUrl: 'u' };
  const c = porId(entradas({ git: sinUsuario }, { auth: { public_key_registry_url: 'https://x', require_github_auth: false } }));
  assert.equal(c['git-usuario'].status, 'fail');
  assert.equal(porId(entradas({ git: sinUsuario }))['git-usuario'], undefined);
});

test('sin manifiesto informa cómo abrir el examen', () => {
  const c = porId(entradas({ manifest: undefined, manifestError: undefined }));
  assert.equal(c.manifiesto.status, 'fail');
  assert.equal(c.extensiones, undefined);
});

test('environment.required_tools: por omisión gcc y make; se valida', () => {
  assert.deepEqual(parseManifest(JSON.stringify(baseManifest())).manifest.environment.required_tools, ['gcc', 'make']);
  const propio = parseManifest(JSON.stringify(baseManifest({ environment: { required_tools: ['clang', 'gdb'] } })));
  assert.deepEqual(propio.manifest.environment.required_tools, ['clang', 'gdb']);
  assert.throws(
    () => parseManifest(JSON.stringify(baseManifest({ environment: { required_tools: ['gcc; rm -rf /'] } }))),
    ManifestError
  );
});

test('el reporte es local y legible', () => {
  const texto = formatReport(checkEnvironment(entradas({ tools: [{ name: 'make', found: false }] })));
  assert.match(texto, /Hay problemas que resolver/);
  assert.match(texto, /✗ Herramienta make: No está en el PATH\.\n {4}→ Instalá make/);
  assert.match(texto, /no inicia la sesión ni envía datos/);
});
