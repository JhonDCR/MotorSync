# Quickstart: validar la feature 002 de punta a punta

Guía de validación manual y automática. Referencias: [contrato](./contracts/openapi.yaml), [data-model](./data-model.md), [research](./research.md). Los comandos base son los de `CLAUDE.md`.

## 0. Prerrequisitos

- Docker, Node 22 y el `.env` copiado de `.env.example`. Después de esta feature, `.env.example` incluye:
  - `AUTH_ALLOW_SESSIONLESS_TOKENS=true`, para que los tokens de `token:dev` y de las pruebas de la 001 sigan sirviendo en local;
  - `AUTH_COOKIE_SECURE=true`.
- Si la base ya existía antes de esta feature, **vuelve a correr `db:bootstrap`**: crea el rol `motorsync_auth`.

## 1. Base de datos

```bash
docker compose up -d
cd backend && npm run build
npm run db:bootstrap      # crea/actualiza motorsync_migrator, motorsync_app y motorsync_auth
npm run db:migrate        # aplica AddTenantRuc, CreateUsers, CreateSessions, CreateLoginAttempts, CreateAuthFunctions
npm run db:seed:dev       # talleres A y B; ahora también un admin y un asesor por taller (imprime correos y contraseña de desarrollo)
```

Comprobaciones rápidas con `psql` y `DATABASE_URL`, es decir, como `motorsync_app`:
- `SELECT count(*) FROM users;` devuelve 0 sin `app.tenant_id`: RLS con FORCE.
- `SELECT * FROM login_attempts;` da *permission denied*.
- `SELECT * FROM auth_find_user_for_login('admin@taller-a.test');` devuelve 1 fila sin datos de otro taller.

## 2. API (`npm run start:dev`)

Con `curl`, guardando cookies en un archivo (`-c`/`-b`) y usando el header `X-Requested-With: motorsync` en refresh y logout:

| Paso | Petición | Esperado |
|---|---|---|
| Registro | `POST /api/v1/auth/register` con nombre comercial, RUC válido, nombre, ` Ana@Taller.EC ` y contraseña | 201 con `accessToken` y `user.email = ana@taller.ec`; `Set-Cookie: ms_refresh=…; HttpOnly; Secure; SameSite=Strict; Path=/api/v1/auth` (US1-AC1, AC2) |
| RUC repetido | mismo RUC, otro correo | 409 `RUC_ALREADY_REGISTERED` (US1-AC4) |
| Correo repetido | otro RUC, `ANA@taller.ec` | 409 `REGISTRATION_FAILED` (US1-AC5) |
| Login | `POST /auth/login` | 200; el JWT decodificado tiene `sid` y `pwd_change: false` |
| Credenciales malas | correo inexistente, o contraseña incorrecta | ambos 401 `INVALID_CREDENTIALS` (US2-AC3) |
| Bloqueo | 5 fallos seguidos y un 6.º intento correcto | 429 `ACCOUNT_LOCKED` (US2-AC5) |
| Datos del taller | `GET /api/v1/vehicles/search?q=PB` con el token | 200, solo datos del taller propio |
| Refresh | `POST /auth/refresh` con la cookie | 200 y cookie nueva; repetir con la cookie **anterior** después de 10 s da 401 `SESSION_REVOKED` (reutilización) |
| Logout | `POST /auth/logout` | 204; el token de acceso anterior recibe 401 `SESSION_REVOKED` en la siguiente petición (US3-AC4) |
| Equipo | como admin: `POST /users` con rol asesor y temporal | 201 `mustChangePassword: true` |
| Temporal | login del asesor y luego `GET /vehicles/search?q=PB` | 403 `PASSWORD_CHANGE_REQUIRED`; `POST /auth/password` → 200 y acceso normal (US5-AC1, AC2) |
| Rol | `PUT /users/{id}/role` `{ "role": "admin" }` | 200; la siguiente petición del afectado ya tiene permisos de admin (US4-AC5) |
| Desactivar | `POST /users/{id}/deactivate` | 200; las sesiones del afectado reciben 401 `SESSION_REVOKED` (US4-AC6) |
| Último admin | desactivar al único admin | 409 `LAST_ADMIN` (US4-AC9) |
| Restablecer | `POST /users/{id}/password-reset` | 200; `GET /users/{id}/history` muestra `user.password_reset` sin contraseñas (US4-AC24) |
| Aislamiento | admin del taller B: `GET /users/{id del taller A}` | 404 `NOT_FOUND` (US4-AC17) |

Para probar la inactividad sin esperar 30 minutos: como `motorsync_migrator`, `UPDATE user_sessions SET last_activity_at = now() - interval '31 minutes' WHERE id = '<sid>'`. La siguiente petición da 401 `SESSION_EXPIRED` (US3-AC2). Las e2e usan la misma técnica, al igual que con `temp_password_expires_at` (US5-AC9) y `login_attempts.locked_until` (US2-AC6).

## 3. Pruebas automáticas

```bash
cd backend
npm run lint && npm test            # unitarias: password-hasher, cookies, guard (@Public, sid, TOKEN_EXPIRED), session-validator, servicios
npm run test:e2e                    # e2e nuevas (auth-*.e2e-spec.ts, users-*.e2e-spec.ts, db/auth-rls.e2e-spec.ts) + TODAS las de la 001 sin cambios
cd ../frontend
npm run lint && npm test -- --watch=false
```

Criterios de aceptación de la verificación:
- Todas las suites de la 001 pasan sin modificaciones (R9).
- Cada `USx-ACy` de la spec tiene al menos una prueba con su ID en el nombre.
- La prueba de tiempos (US2-AC3, SC-003) pasa en CI.
- `db/auth-rls.e2e-spec.ts` demuestra:
  - que `motorsync_app` no lee `login_attempts`;
  - que no ve `users`, `user_sessions` ni `refresh_tokens` de otro taller;
  - que las funciones `auth_*` no devuelven más columnas de las del contrato de data-model.

## 4. Frontend

```bash
cd frontend
npx ng serve --configuration mock   # sin backend: /login, /register, /change-password y /users contra el mock
npm start                            # con backend (proxy /api → localhost:3000, mismo origen)
```

Recorrido en un teléfono de 360 px (DevTools) y en una tablet:
1. `/register` → pantalla inicial con sesión.
2. Cerrar sesión desde la barra (2 toques como máximo, FR-025) → `/login`.
3. Login con una temporal → solo `/change-password`.
4. Como admin, `/users`: crear, cambiar rol, desactivar, reactivar, restablecer, ver historial.
5. Como asesor, la opción "Usuarios" no aparece y `/users` redirige.

Objetivos táctiles de al menos 44 px y sin desplazamiento horizontal.

## 5. Rendimiento

`npm run test:perf` (001) no cambia: usa tokens sin `sid`. Para estimar el sobrecosto de la validación de sesión (R6), la e2e `auth-session.e2e-spec.ts` mide el p95 de `GET /auth/me` con 200 peticiones y lo registra en el log, sin umbral obligatorio en esta feature.
