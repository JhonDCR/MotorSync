// Tests for the post-edit hook decision: `node --test ".claude/hooks/*.test.mjs"` (also runs in CI, job "harness").
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decide, planChecks } from './post-edit-check.mjs';

const lint = { kind: 'lint', report: '$ oxlint\nerror: no-explicit-any' };
const red = { kind: 'test', report: '$ vitest related\nCannot find module ./clients.service.js' };

const context = (result) => JSON.parse(result.stdout).hookSpecificOutput;

test('sin fallos no reporta nada', () => {
  assert.deepEqual(decide('tester', 'backend/test/clients.e2e-spec.ts', []), { exitCode: 0 });
  assert.deepEqual(decide(null, 'backend/src/main.ts', []), { exitCode: 0 });
});

test('tester con prueba en rojo: exit 0 y contexto, no bloqueo', () => {
  for (const rel of [
    'backend/src/clients/clients.service.spec.ts',
    'backend/test/clients.e2e-spec.ts',
    'frontend/src/app/features/clients/client-form.page.spec.ts',
  ]) {
    const result = decide('tester', rel, [red]);
    assert.equal(result.exitCode, 0, rel);
    assert.equal(result.stderr, undefined);
    const out = context(result);
    assert.equal(out.hookEventName, 'PostToolUse');
    assert.match(out.additionalContext, /rojo/);
    assert.match(out.additionalContext, /razón correcta/);
    assert.match(out.additionalContext, /Cannot find module/);
  }
});

test('tester con error de lint en su prueba: sigue bloqueando (exit 2) y no mezcla el rojo', () => {
  const result = decide('tester', 'backend/test/clients.e2e-spec.ts', [lint, red]);
  assert.equal(result.exitCode, 2);
  assert.match(result.stderr, /no-explicit-any/);
  assert.doesNotMatch(result.stderr, /Cannot find module/);
});

test('las pruebas que fallan por otros roles siguen siendo un fallo', () => {
  for (const role of [null, 'implementer-backend', 'implementer-frontend', 'general-purpose']) {
    const result = decide(role, 'backend/src/clients/clients.service.spec.ts', [red]);
    assert.equal(result.exitCode, 2, String(role));
    assert.match(result.stderr, /no pasa los checks/);
  }
});

test('el tester editando un archivo que no es de prueba no recibe la excepción', () => {
  const result = decide('tester', 'backend/src/clients/clients.service.ts', [red]);
  assert.equal(result.exitCode, 2);
});

test('planChecks: lint y pruebas relacionadas en backend; en frontend solo corre el spec editado', () => {
  assert.deepEqual(
    planChecks('backend', 'src/main.ts').map((c) => c.kind),
    ['lint', 'test'],
  );
  assert.deepEqual(
    planChecks('frontend', 'src/app/app.ts').map((c) => c.kind),
    ['lint'],
  );
  assert.deepEqual(
    planChecks('frontend', 'src/app/app.spec.ts').map((c) => c.kind),
    ['lint', 'test'],
  );
  assert.deepEqual(planChecks('docs', 'x.ts'), []);
});
