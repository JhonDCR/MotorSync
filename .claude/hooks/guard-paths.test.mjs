// Tests for the harness itself: `node --test .claude/hooks/` (also runs in CI, job "harness").
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkWrite, toRepoPath } from './guard-paths.mjs';

const allowed = (role, rel) => assert.equal(checkWrite(role, rel), null, `${role} debería poder escribir ${rel}`);
const blocked = (role, rel) => assert.notEqual(checkWrite(role, rel), null, `${role} no debería poder escribir ${rel}`);

test('la sesión principal (leader humano) no tiene restricciones', () => {
  allowed(null, '.github/workflows/ci.yml');
  allowed(null, 'backend/src/app.module.ts');
});

test('ningún subagente modifica el arnés ni .env', () => {
  for (const role of ['tester', 'implementer-backend', 'spec-writer', 'general-purpose']) {
    blocked(role, '.github/workflows/ci.yml');
    blocked(role, '.claude/hooks/guard-paths.mjs');
    blocked(role, '.specify/memory/constitution.md');
    blocked(role, 'CLAUDE.md');
    blocked(role, '.env');
    blocked(role, 'backend/.env.local');
    blocked(role, '../otro-repo/file.ts');
  }
});

test('tester solo escribe pruebas', () => {
  allowed('tester', 'backend/src/vehicles/vehicles.service.spec.ts');
  allowed('tester', 'backend/test/vehicles.e2e-spec.ts');
  allowed('tester', 'backend/test/utils/tenant-fixtures.ts');
  allowed('tester', 'frontend/src/app/vehicles/vehicle-search.component.spec.ts');
  blocked('tester', 'backend/src/vehicles/vehicles.service.ts');
  blocked('tester', 'specs/001-vehiculos/spec.md');
});

test('implementers no tocan pruebas y se quedan en su área', () => {
  allowed('implementer-backend', 'backend/src/vehicles/vehicles.service.ts');
  blocked('implementer-backend', 'backend/src/vehicles/vehicles.service.spec.ts');
  blocked('implementer-backend', 'backend/test/vehicles.e2e-spec.ts');
  blocked('implementer-backend', 'frontend/src/app/app.ts');
  allowed('implementer-frontend', 'frontend/src/app/vehicles/vehicle-search.component.ts');
  blocked('implementer-frontend', 'frontend/src/app/vehicles/vehicle-search.component.spec.ts');
  blocked('implementer-frontend', 'backend/src/main.ts');
});

test('spec-writer solo escribe en specs/ y reviewer en ningún lado', () => {
  allowed('spec-writer', 'specs/001-vehiculos/plan.md');
  blocked('spec-writer', 'backend/src/main.ts');
  blocked('reviewer', 'specs/001-vehiculos/spec.md');
});

test('normaliza rutas absolutas de Windows y POSIX', () => {
  const root = path.resolve('/repo');
  assert.equal(toRepoPath(path.join(root, 'backend', 'src', 'a.ts'), root), 'backend/src/a.ts');
  assert.equal(toRepoPath('backend/src/a.ts', root), 'backend/src/a.ts');
});

test('el hook bloquea con exit 2 y explica el motivo por stderr', () => {
  const script = fileURLToPath(new URL('./guard-paths.mjs', import.meta.url));
  const root = path.resolve('/repo');
  const run = (role, file) =>
    spawnSync(process.execPath, [script, role], {
      input: JSON.stringify({ tool_name: 'Edit', tool_input: { file_path: path.join(root, file) } }),
      env: { ...process.env, CLAUDE_PROJECT_DIR: root },
      encoding: 'utf8',
    });

  const denied = run('implementer-backend', 'backend/test/vehicles.e2e-spec.ts');
  assert.equal(denied.status, 2);
  assert.match(denied.stderr, /no modifican pruebas/);

  assert.equal(run('implementer-backend', 'backend/src/main.ts').status, 0);
});
