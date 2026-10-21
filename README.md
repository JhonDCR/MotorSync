# MotorSync

SaaS multi-tenant para la gestión operativa y presupuestaria de talleres automotrices: check-in con inspección 360°, presupuestos aprobables por enlace, órdenes de trabajo, inventario de repuestos e historial por placa.

## Stack

| Capa | Tecnología |
|---|---|
| Frontend | Angular (PWA, responsive para tablets en bahía) |
| Backend | NestJS (TypeScript strict) |
| Base de datos | PostgreSQL 16 con Row-Level Security por `tenant_id` |
| Metodología | Spec-Driven Development con [Spec Kit](https://github.com/github/spec-kit) |
| Agentes | Claude Code (subagentes + hooks) y GitHub Copilot |
| CI/CD | GitHub Actions |

## Estructura

```
motorsync/
├── .claude/          # arnés de agentes: subagentes, hooks, comandos Spec Kit
├── .github/workflows # pipeline CI
├── .specify/         # Spec Kit: constitución, plantillas, scripts
├── specs/            # una carpeta por feature (spec, plan, tasks, contratos)
├── backend/          # NestJS
├── frontend/         # Angular
└── docker-compose.yml
```

## Levantar el entorno local

Requisitos: Node 22+, Docker, uv (para Spec Kit).

```bash
cp .env.example .env
docker compose up -d
docker compose ps   # postgres debe aparecer "healthy"
```

Backend y frontend: ver la sección de comandos en [CLAUDE.md](CLAUDE.md) (se completan cuando existan los scaffolds).

## Flujo de trabajo

- `main` protegida: todo entra por Pull Request con 1 aprobación y CI en verde.
- Ramas cortas: `feat/…`, `fix/…`, `chore/…`, `ci/…`, `docs/…`.
- Commits con [Conventional Commits](https://www.conventionalcommits.org/es/).
- Cada feature sigue el ciclo SDD: `spec → plan → tasks → issue → test rojo → código → PR → review → merge`.

Las reglas no negociables del proyecto están en [.specify/memory/constitution.md](.specify/memory/constitution.md).
