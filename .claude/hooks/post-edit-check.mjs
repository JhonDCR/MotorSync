#!/usr/bin/env node
// PostToolUse hook (Edit|Write|MultiEdit): runs lint and related tests on the edited TypeScript file,
// so the agent gets the failure in the same loop instead of at CI time.
// It is a no-op until backend/ or frontend/ have their scaffold and node_modules installed.
// Exit code 2 sends stderr back to the agent; the edit itself is already applied.
import { existsSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const PACKAGES = {
  backend: (file) => [
    ['npx', '--no-install', 'oxlint', '--type-aware', file],
    ['npx', '--no-install', 'vitest', 'related', file, '--run', '--passWithNoTests'],
  ],
  // Angular runs Vitest through its own builder, so `vitest related` is not available: only edited specs are run.
  frontend: (file) => [
    ['npx', '--no-install', 'eslint', file],
    ...(file.endsWith('.spec.ts') ? [['npx', '--no-install', 'ng', 'test', `--include=${file}`, '--watch=false']] : []),
  ],
};

async function readStdin() {
  let data = '';
  for await (const chunk of process.stdin) data += chunk;
  return data ? JSON.parse(data) : {};
}

const input = await readStdin();
const filePath = input.tool_input?.file_path;
if (!filePath || !filePath.endsWith('.ts')) process.exit(0);

const projectDir = process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd();
const rel = path.relative(projectDir, path.resolve(projectDir, filePath)).split(path.sep).join('/');
const pkg = rel.split('/')[0];
const pkgDir = path.join(projectDir, pkg);
if (!PACKAGES[pkg] || !existsSync(path.join(pkgDir, 'node_modules'))) process.exit(0);

const fileInPkg = rel.slice(pkg.length + 1);
const failures = [];
for (const argv of PACKAGES[pkg](fileInPkg)) {
  // A single quoted command string: npx is a .cmd on Windows and needs a shell to run.
  const [cmd, ...args] = argv;
  const command = [cmd, ...args.map((arg) => `"${arg}"`)].join(' ');
  const result = spawnSync(command, { cwd: pkgDir, encoding: 'utf8', shell: true, timeout: 120_000 });
  if (result.status !== 0) {
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim().split('\n').slice(-40).join('\n');
    failures.push(`$ ${argv.join(' ')}\n${output}`);
  }
}

if (failures.length) {
  process.stderr.write(`[post-edit-check] ${rel} no pasa los checks. Corrígelo antes de continuar:\n\n${failures.join('\n\n')}\n`);
  process.exit(2);
}
