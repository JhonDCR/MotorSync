import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ActivatedRoute, provideRouter } from '@angular/router';
import { of, throwError } from 'rxjs';
import type { Problem, UserAccount, UserAuditEntry, UserHistoryResponse } from '../../core/api/api.models';
import { UsersApiService } from '../../core/api/users-api.service';
import { SessionStore } from '../../core/auth/session.store';
import { UserDetailPage } from './user-detail.page';

const TARGET_USER_ID = '22222222-2222-4222-8222-222222222222';
const LOGGED_ADMIN_ID = '11111111-1111-4111-8111-111111111111';

const MOCK_TARGET_USER: UserAccount = {
  id: TARGET_USER_ID,
  name: 'Asesor Demo',
  email: 'asesor@taller.ec',
  role: 'asesor',
  status: 'active',
  mustChangePassword: false,
  temporaryPasswordExpiresAt: null,
  createdAt: '2026-10-24T10:00:00.000Z',
  updatedAt: '2026-10-24T11:00:00.000Z',
  updatedByName: 'Admin Principal',
};

const MOCK_HISTORY: UserAuditEntry[] = [
  {
    id: 'h2',
    action: 'user.role_changed',
    actorName: 'Admin Principal',
    actorRole: 'admin',
    occurredAt: '2026-10-24T12:00:00.000Z',
    before: { role: 'asesor' },
    after: { role: 'admin' },
    ip: '127.0.0.1',
    channel: 'web',
  },
  {
    id: 'h1',
    action: 'user.password_reset',
    actorName: 'Admin Principal',
    actorRole: 'admin',
    occurredAt: '2026-10-24T10:30:00.000Z',
    before: null,
    after: null,
    ip: '127.0.0.1',
    channel: 'web',
  },
];

describe('UserDetailPage (T060)', () => {
  let fixture: ComponentFixture<UserDetailPage>;
  let usersApiMock: {
    getById: ReturnType<typeof vi.fn>;
    getHistory: ReturnType<typeof vi.fn>;
    changeRole: ReturnType<typeof vi.fn>;
    deactivate: ReturnType<typeof vi.fn>;
    reactivate: ReturnType<typeof vi.fn>;
    resetPassword: ReturnType<typeof vi.fn>;
  };
  let sessionStoreMock: { user: ReturnType<typeof vi.fn> };

  async function createComponent(targetUser = MOCK_TARGET_USER, loggedUserId = LOGGED_ADMIN_ID) {
    usersApiMock = {
      getById: vi.fn().mockReturnValue(of(targetUser)),
      getHistory: vi.fn().mockReturnValue(of({ items: MOCK_HISTORY } as UserHistoryResponse)),
      changeRole: vi.fn().mockReturnValue(of({ ...targetUser, role: 'admin' })),
      deactivate: vi.fn().mockReturnValue(of({ ...targetUser, status: 'inactive' })),
      reactivate: vi.fn().mockReturnValue(of({ ...targetUser, status: 'active' })),
      resetPassword: vi.fn().mockReturnValue(of({ ...targetUser, mustChangePassword: true })),
    };

    sessionStoreMock = {
      user: vi.fn().mockReturnValue({
        id: loggedUserId,
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
          useValue: { snapshot: { paramMap: { get: () => targetUser.id } } },
        },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(UserDetailPage);
    fixture.detectChanges();
  }

  function root(): HTMLElement {
    return fixture.nativeElement as HTMLElement;
  }

  describe('Información del usuario', () => {
    beforeEach(async () => {
      await createComponent();
    });

    it('muestra los datos completos de la cuenta', () => {
      expect(root().querySelector('[data-testid="user-name"]')?.textContent?.trim()).toBe('Asesor Demo');
      expect(root().querySelector('[data-testid="info-email"]')?.textContent?.trim()).toBe('asesor@taller.ec');
      expect(root().querySelector('[data-testid="info-role"]')?.textContent?.trim()).toBe('Asesor');
      expect(root().querySelector('[data-testid="info-status"]')?.textContent?.trim()).toBe('Activo');
      expect(root().querySelector('[data-testid="info-created-at"]')?.textContent?.trim()).toBe('2026-10-24T10:00:00.000Z');
      expect(root().querySelector('[data-testid="info-updated-at"]')?.textContent?.trim()).toBe('2026-10-24T11:00:00.000Z');
      expect(root().querySelector('[data-testid="info-updated-by"]')?.textContent?.trim()).toBe('Admin Principal');
    });
  });

  describe('Acciones de gestión de cuenta', () => {
    beforeEach(async () => {
      await createComponent();
    });

    it('permite cambiar rol con confirmación', () => {
      const changeRoleBtn = root().querySelector('[data-testid="change-role-button"]') as HTMLButtonElement;
      expect(changeRoleBtn.textContent).toContain('Cambiar a administrador');

      changeRoleBtn.click();
      fixture.detectChanges();

      const confirmBox = root().querySelector('[data-testid="confirm-role-box"]');
      expect(confirmBox).not.toBeNull();

      const confirmBtn = root().querySelector('[data-testid="confirm-change-role-button"]') as HTMLButtonElement;
      confirmBtn.click();
      fixture.detectChanges();

      expect(usersApiMock.changeRole).toHaveBeenCalledWith(TARGET_USER_ID, 'admin');
      expect(root().querySelector('[data-testid="action-success"]')?.textContent).toContain('Rol actualizado');
    });

    it('permite desactivar cuenta activa con confirmación', () => {
      const deactivateBtn = root().querySelector('[data-testid="deactivate-button"]') as HTMLButtonElement;
      deactivateBtn.click();
      fixture.detectChanges();

      const confirmBox = root().querySelector('[data-testid="confirm-deactivate-box"]');
      expect(confirmBox).not.toBeNull();

      const confirmBtn = root().querySelector('[data-testid="confirm-deactivate-button"]') as HTMLButtonElement;
      confirmBtn.click();
      fixture.detectChanges();

      expect(usersApiMock.deactivate).toHaveBeenCalledWith(TARGET_USER_ID);
      expect(root().querySelector('[data-testid="action-success"]')?.textContent).toContain('Cuenta desactivada');
    });

    it('muestra el error especificado cuando la API devuelve LAST_ADMIN', () => {
      const lastAdminProb: Problem = {
        type: 'about:blank',
        title: 'Error',
        status: 409,
        code: 'LAST_ADMIN',
      };
      usersApiMock.deactivate.mockReturnValue(throwError(() => lastAdminProb));

      const deactivateBtn = root().querySelector('[data-testid="deactivate-button"]') as HTMLButtonElement;
      deactivateBtn.click();
      fixture.detectChanges();

      const confirmBtn = root().querySelector('[data-testid="confirm-deactivate-button"]') as HTMLButtonElement;
      confirmBtn.click();
      fixture.detectChanges();

      const errorAlert = root().querySelector('[data-testid="action-error"]');
      expect(errorAlert?.textContent).toContain('El taller debe tener al menos un administrador activo');
    });
  });

  describe('Reactivar cuenta inactiva', () => {
    it('permite reactivar si el estado es inactive', async () => {
      await createComponent({ ...MOCK_TARGET_USER, status: 'inactive' });

      const reactivateBtn = root().querySelector('[data-testid="reactivate-button"]') as HTMLButtonElement;
      expect(reactivateBtn).not.toBeNull();

      reactivateBtn.click();
      fixture.detectChanges();

      const confirmBtn = root().querySelector('[data-testid="confirm-reactivate-button"]') as HTMLButtonElement;
      confirmBtn.click();
      fixture.detectChanges();

      expect(usersApiMock.reactivate).toHaveBeenCalledWith(TARGET_USER_ID);
      expect(root().querySelector('[data-testid="action-success"]')?.textContent).toContain('Cuenta reactivada');
    });
  });

  describe('Restablecer contraseña vs propia cuenta', () => {
    it('muestra botón "Restablecer contraseña" para cuentas de terceros', async () => {
      await createComponent(MOCK_TARGET_USER, LOGGED_ADMIN_ID);

      const resetBtn = root().querySelector('[data-testid="reset-password-button"]');
      expect(resetBtn).not.toBeNull();
      expect(root().querySelector('[data-testid="own-account-notice"]')).toBeNull();
    });

    it('oculta botón y muestra aviso para la propia cuenta del administrador logueado', async () => {
      await createComponent(MOCK_TARGET_USER, TARGET_USER_ID);

      const resetBtn = root().querySelector('[data-testid="reset-password-button"]');
      expect(resetBtn).toBeNull();

      const ownNotice = root().querySelector('[data-testid="own-account-notice"]');
      expect(ownNotice).not.toBeNull();
      expect(ownNotice?.textContent).toContain('Para su propia cuenta use Cambiar mi contraseña');
    });
  });

  describe('Historial de auditoría', () => {
    beforeEach(async () => {
      await createComponent();
    });

    it('lista los eventos en orden con las acciones traducidas al español', () => {
      const entries = root().querySelectorAll('[data-testid="history-entry"]');
      expect(entries.length).toBe(2);

      const firstAction = entries[0].querySelector('[data-testid="entry-action"]')?.textContent?.trim();
      expect(firstAction).toBe('Cambio de rol');

      const secondAction = entries[1].querySelector('[data-testid="entry-action"]')?.textContent?.trim();
      expect(secondAction).toBe('Restablecimiento de contraseña');
    });
  });
});
