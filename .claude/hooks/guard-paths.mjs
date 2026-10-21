#!/usr/bin/env node
// PreToolUse hook (Edit|Write|MultiEdit): restricts which paths each agent role may write.
// Role comes from argv[2] (subagent frontmatter hook) or from `agent_type` in the hook input
// (global hook in settings.json). The main session (no role) is the human-driven leader and is not restricted.
// Exit code 2 blocks the tool call and sends stderr back to the agent as feedback.
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TEST_FILE = /\.(spec|e2e-spec)\.ts$/;
const TEST_DIRS = ['backend/test/', 'frontend/src/testing/'];
const PROTECTED = ['.github/', '.claude/', '.specify/memory/constitution.md', 'CLAUDE.md'];

export function isTestFile(rel) {
  return TEST_FILE.test(rel) || TEST_DIRS.some((dir) => rel.startsWith(dir));
}

export function toRepoPath(filePath, projectDir) {
  const abs = path.resolve(projectDir, filePath);
  return path.relative(projectDir, abs).split(path.sep).join('/');
}

/** Returns null when allowed, or the reason the write is blocked. */
export function checkWrite(role, rel) {
  if (!role) return null;
  if (rel.startsWith('../') || path.isAbsolute(rel)) {
    return `"${rel}" está fuera del repositorio.`;
  }
  if (/(^|\/)\.env(\.|$)/.test(rel) && !rel.endsWith('.env.example')) {
    return 'los archivos .env no se editan desde agentes.';
  }
  if (PROTECTED.some((p) => rel === p || rel.startsWith(p))) {
    return `"${rel}" es parte del arnés (CI, agentes, hooks, constitución). Solo un humano lo modifica.`;
  }
  switch (role) {
    case 'reviewer':
      return 'el reviewer es de solo lectura.';
    case 'tester':
      return isTestFile(rel)
        ? null
        : `el tester solo escribe pruebas (*.spec.ts, *.e2e-spec.ts, ${TEST_DIRS.join(', ')}). Pide al leader que un implementer cree "${rel}".`;
    case 'implementer-backend':
    case 'implementer-frontend': {
      const area = role === 'implementer-backend' ? 'backend/' : 'frontend/';
      if (isTestFile(rel)) {
        return `los implementers no modifican pruebas ("${rel}"). Si la prueba está mal, repórtalo al leader con evidencia.`;
      }
      return rel.startsWith(area) ? null : `${role} solo escribe dentro de ${area}.`;
    }
    case 'spec-writer':
      return rel.startsWith('specs/') ? null : 'el spec-writer solo escribe dentro de specs/.';
    default:
      return null;
  }
}

async function readStdin() {
  let data = '';
  for await (const chunk of process.stdin) data += chunk;
  return data ? JSON.parse(data) : {};
}

async function main() {
  const input = await readStdin();
  const role = process.argv[2] || input.agent_type || null;
  const filePath = input.tool_input?.file_path;
  if (!filePath) return;
  const projectDir = process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd();
  const rel = toRepoPath(filePath, projectDir);
  const reason = checkWrite(role, rel);
  if (reason) {
    process.stderr.write(`[guard-paths] Bloqueado para ${role}: ${reason}\n`);
    process.exit(2);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    // Fail closed for subagents: an unreadable input must not become an unrestricted write.
    process.stderr.write(`[guard-paths] Error leyendo la entrada del hook: ${err.message}\n`);
    process.exit(2);
  });
}
