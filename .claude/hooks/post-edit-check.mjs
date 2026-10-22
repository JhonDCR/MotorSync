#!/usr/bin/env node
// PostToolUse hook (Edit|Write|MultiEdit): runs lint and related tests on the edited TypeScript file,
// so the agent gets the failure in the same loop instead of at CI time.
// It is a no-op until backend/ or frontend/ have their scaffold and node_modules installed.
// Exit code 2 sends stderr back to the agent as a warning; the edit itself is already applied.
//
// TDD red phase: when the `tester` subagent edits a test file, failing tests are the expected outcome,
// so they are reported as context (exit 0 + additionalContext) instead of as a failure. Lint errors
// are real defects for every role and still exit 2.
import { existsSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isTestFile } from './guard-paths.mjs';

const CHECKS = {
  backend: (file) => [
    { kind: 'lint', argv: ['npx', '--no-install', 'oxlint', '--type-aware', file] },
    { kind: 'test', argv: ['npx', '--no-install', 'vitest', 'related', file, '--run', '--passWithNoTests'] },
  ],
  // Angular runs Vitest through its own builder, so `vitest related` is not available: only edited specs are run.
  frontend: (file) => [
    { kind: 'lint', argv: ['npx', '--no-install', 'eslint', file] },
    ...(file.endsWith('.spec.ts')
      ? [{ kind: 'test', argv: ['npx', '--no-install', 'ng', 'test', `--include=${file}`, '--watch=false'] }]
      : []),
  ],
};

export function planChecks(pkg, fileInPkg) {
  return CHECKS[pkg] ? CHECKS[pkg](fileInPkg) : [];
}

/**
 * Decides how to report the failed checks of an edit.
 * @param {string|null} role subagent type from the hook input (`agent_type`), null in the main session
 * @param {string} rel repo-relative path of the edited file
 * @param {{kind: 'lint'|'test', report: string}[]} failures
 * @returns {{exitCode: 0|2, stderr?: string, stdout?: string}}
 */
export function decide(role, rel, failures) {
  if (failures.length === 0) return { exitCode: 0 };

  const expectedRed = role === 'tester' && isTestFile(rel);
  const blocking = expectedRed ? failures.filter((f) => f.kind === 'lint') : failures;
  const redTests = expectedRed ? failures.filter((f) => f.kind === 'test') : [];

  if (blocking.length) {
    return {
      exitCode: 2,
      stderr: `[post-edit-check] ${rel} no pasa los checks. Corrígelo antes de continuar:\n\n${blocking
        .map((f) => f.report)
        .join('\n\n')}\n`,
    };
  }
  return {
    exitCode: 0,
    stdout: JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PostToolUse',
        additionalContext:
          `[post-edit-check] ${rel}: prueba en rojo, esperado en la fase roja de TDD (no es un bloqueo). ` +
          `Confirma que falla por la razón correcta (funcionalidad ausente), no por un error de la prueba:\n\n` +
          redTests.map((f) => f.report).join('\n\n'),
      },
    }),
  };
}

function runCheck(argv, cwd) {
  // A single command string with quoted args: npx is a .cmd on Windows and needs a shell to run.
  const [cmd, ...args] = argv;
  const command = [cmd, ...args.map((arg) => `"${arg}"`)].join(' ');
  const result = spawnSync(command, { cwd, encoding: 'utf8', shell: true, timeout: 120_000 });
  if (result.status === 0) return null;
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim().split('\n').slice(-40).join('\n');
  return `$ ${argv.join(' ')}\n${output}`;
}

async function readStdin() {
  let data = '';
  for await (const chunk of process.stdin) data += chunk;
  return data ? JSON.parse(data) : {};
}

async function main() {
  const input = await readStdin();
  const filePath = input.tool_input?.file_path;
  if (!filePath || !filePath.endsWith('.ts')) return;

  const projectDir = process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd();
  const rel = path.relative(projectDir, path.resolve(projectDir, filePath)).split(path.sep).join('/');
  const pkg = rel.split('/')[0];
  const pkgDir = path.join(projectDir, pkg);
  if (!CHECKS[pkg] || !existsSync(path.join(pkgDir, 'node_modules'))) return;

  const failures = [];
  for (const { kind, argv } of planChecks(pkg, rel.slice(pkg.length + 1))) {
    const report = runCheck(argv, pkgDir);
    if (report) failures.push({ kind, report });
  }

  const { exitCode, stderr, stdout } = decide(input.agent_type || null, rel, failures);
  if (stdout) process.stdout.write(stdout);
  if (stderr) process.stderr.write(stderr);
  process.exit(exitCode);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
