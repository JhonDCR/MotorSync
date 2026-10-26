// T055 (003, PR2, US3-AC6): visualización del restablecimiento de contraseña por soporte en el historial de
// una cuenta del taller (features/users/user-detail.page.ts + .html).
// Archivo nuevo: user-detail.page.spec.ts de la 002 NO se modifica.
//
// Contrato para el implementer-frontend (T056), archivos features/users/user-detail.page.ts (+ .html) y
// core/api/api.models.ts:
//   - Un registro `UserAuditEntry` con `action === 'user.password_reset_by_support'`,
//     `actorRole === 'platform_support'`, `actorName === 'Pedro Soporte'` y `after.supportTicketNumber === 123`:
//     - En `[data-testid="entry-actor"]` se muestra `"Soporte MotorSync (Pedro Soporte)"` (spec, Assumptions y
//       research R11/R13), sin mostrar ningún correo del agente.
//     - En `[data-testid="entry-action"]` se muestra `"Restablecimiento de contraseña por soporte (ticket #123)"`.
//     - En `[data-testid="entry-date"]` la fecha `occurredAt` (UTC) se formatea en la zona horaria local de Ecuador
//       (`America/Guayaquil`, UTC-5, p. ej. `24/10/2026 21:30` para `2026-10-25T02:30:00.000Z`, nunca ISO crudo).
//   - Los registros existentes de la 002 (`admin`, `asesor`, `user.password_reset`, etc.) mantienen su formato.
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ActivatedRoute, provideRouter } from '@angular/router';
import { of } from 'rxjs';
import { SUPPORT_EMAIL } from '../../../testing/support-fixtures';
import type { AuditActorRole, UserAccount, UserHistoryResponse } from '../../core/api/api.models';
import { UsersApiService } from '../../core/api/users-api.service';
import { SessionStore } from '../../core/auth/session.store';
import { UserDetailPage } from './user-detail.page';

const TARGET_USER_ID = '22222222-2222-4222-8222-222222222222';
const LOGGED_ADMIN_ID = '11111111-1111-4111-8111-111111111111';
const ISO_LIKE = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

interface SupportAuditEntryFixture {
  id: string;
  action: 'user.password_reset_by_support' | 'user.password_reset';
  actorName: string;
  actorRole: AuditActorRole;
  occurredAt: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  ip: string | null;
  channel: string;
}

const MOCK_TARGET_USER: UserAccount = {
  id: TARGET_USER_ID,
  name: 'Ana Pérez',
  email: 'ana.perez@taller.ec',
  role: 'admin',
  status: 'active',
  mustChangePassword: true,
  temporaryPasswordExpiresAt: '2026-10-28T02:30:00.000Z',
  createdAt: '2026-10-20T10:00:00.000Z',
  updatedAt: '2026-10-25T02:30:00.000Z',
  updatedByName: 'Soporte MotorSync (Pedro Soporte)',
};

/**
 * `2026-10-25T02:30:00.000Z` es día 25 a las 02:30 en UTC,
 * pero en `America/Guayaquil` (UTC-5) es el día 24/10/2026 a las 21:30.
 */
const MOCK_SUPPORT_HISTORY: SupportAuditEntryFixture[] = [
  {
    id: 'h-support-1',
    action: 'user.password_reset_by_support',
    actorName: 'Pedro Soporte',
    actorRole: 'platform_support',
    occurredAt: '2026-10-25T02:30:00.000Z',
    before: { mustChangePassword: false },
    after: {
      mustChangePassword: true,
      temporaryPasswordExpiresAt: '2026-10-28T02:30:00.000Z',
      sessionsClosed: 2,
      supportTicketNumber: 123,
    },
    ip: '127.0.0.1',
    channel: 'support_panel',
  },
  {
    id: 'h-admin-1',
    action: 'user.password_reset',
    actorName: 'Admin Principal',
    actorRole: 'admin',
    occurredAt: '2026-10-24T15:00:00.000Z',
    before: { mustChangePassword: false },
    after: { mustChangePassword: true, sessionsClosed: 1 },
    ip: '127.0.0.1',
    channel: 'web',
  },
];

describe('UserDetailPage: historial con restablecimiento por soporte (T055)', () => {
  let fixture: ComponentFixture<UserDetailPage>;

  beforeEach(async () => {
    const usersApiMock = {
      getById: vi.fn().mockReturnValue(of(MOCK_TARGET_USER)),
      getHistory: vi.fn().mockReturnValue(of({ items: MOCK_SUPPORT_HISTORY } as unknown as UserHistoryResponse)),
      changeRole: vi.fn(),
      deactivate: vi.fn(),
      reactivate: vi.fn(),
      resetPassword: vi.fn(),
    };

    const sessionStoreMock = {
      user: vi.fn().mockReturnValue({
        id: LOGGED_ADMIN_ID,
        name: 'Admin Principal',
        email: 'admin@taller.ec',
        role: 'admin',
        mustChangePassword: false,
        temporaryPasswordExpiresAt: null,
      }),
    };

    await TestBed.configureTestingModule({
      imports: [UserDetailPage],
      providers: [
        provideRouter([]),
        { provide: UsersApiService, useValue: usersApiMock },
        { provide: SessionStore, useValue: sessionStoreMock },
        {
          provide: ActivatedRoute,
          useValue: { snapshot: { paramMap: { get: () => TARGET_USER_ID } } },
        },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(UserDetailPage);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  });

  function root(): HTMLElement {
    return fixture.nativeElement as HTMLElement;
  }

  it('[US3-AC6][FR-020] muestra un registro user.password_reset_by_support con el actor "Soporte MotorSync (Pedro Soporte)" (sin correo), la acción "Restablecimiento de contraseña por soporte (ticket #123)" y la fecha en hora de Ecuador (America/Guayaquil)', () => {
    const entries = root().querySelectorAll('[data-testid="history-entry"]');
    expect(entries).toHaveLength(2);

    const supportRow = entries[0];
    const actorText = supportRow.querySelector('[data-testid="entry-actor"]')?.textContent?.trim() ?? '';
    const actionText = supportRow.querySelector('[data-testid="entry-action"]')?.textContent?.trim() ?? '';
    const dateText = supportRow.querySelector('[data-testid="entry-date"]')?.textContent?.trim() ?? '';

    expect(actorText).toBe('Soporte MotorSync (Pedro Soporte)');
    expect(actorText).not.toContain('Asesor');
    expect(actorText).not.toContain(SUPPORT_EMAIL);
    expect(actorText).not.toContain('@');

    expect(actionText).toBe('Restablecimiento de contraseña por soporte (ticket #123)');

    // 2026-10-25T02:30:00.000Z → 24/10/2026 21:30 en America/Guayaquil (UTC-5)
    expect(dateText).not.toMatch(ISO_LIKE);
    expect(dateText).toContain('24/10/2026');
    expect(dateText).toContain('21:30');

    // El registro de administrador de la 002 conserva su formato habitual.
    const adminRow = entries[1];
    expect(adminRow.querySelector('[data-testid="entry-actor"]')?.textContent?.trim()).toBe(
      'Admin Principal (Administrador)',
    );
    expect(adminRow.querySelector('[data-testid="entry-action"]')?.textContent?.trim()).toBe(
      'Restablecimiento de contraseña',
    );
  });
});
