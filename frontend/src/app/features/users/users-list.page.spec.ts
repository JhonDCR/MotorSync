import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { of } from 'rxjs';
import type { UserAccount, UserListResponse } from '../../core/api/api.models';
import { UsersApiService } from '../../core/api/users-api.service';
import { SessionStore } from '../../core/auth/session.store';
import { UsersListPage } from './users-list.page';

const MOCK_USERS: UserAccount[] = [
  {
    id: '11111111-1111-4111-8111-111111111111',
    name: 'Admin Demo',
    email: 'admin@taller.ec',
    role: 'admin',
    status: 'active',
    mustChangePassword: false,
    temporaryPasswordExpiresAt: null,
    createdAt: '2026-10-24T12:00:00.000Z',
    updatedAt: '2026-10-24T12:00:00.000Z',
    updatedByName: 'Admin Demo',
  },
  {
    id: '22222222-2222-4222-8222-222222222222',
    name: 'Asesor Demo',
    email: 'asesor@taller.ec',
    role: 'asesor',
    status: 'inactive',
    mustChangePassword: true,
    temporaryPasswordExpiresAt: '2026-10-27T12:00:00.000Z',
    createdAt: '2026-10-24T12:00:00.000Z',
    updatedAt: '2026-10-24T12:00:00.000Z',
    updatedByName: 'Admin Demo',
  },
];

describe('UsersListPage (T058)', () => {
  let fixture: ComponentFixture<UsersListPage>;
  let usersApiMock: { list: ReturnType<typeof vi.fn> };
  let sessionStoreMock: { user: ReturnType<typeof vi.fn> };

  async function createComponent(role: 'admin' | 'asesor' = 'admin') {
    usersApiMock = {
      list: vi.fn().mockReturnValue(of({ items: MOCK_USERS } as UserListResponse)),
    };
    sessionStoreMock = {
      user: vi.fn().mockReturnValue({
        id: '11111111-1111-4111-8111-111111111111',
        name: 'Admin Demo',
        email: 'admin@taller.ec',
        role,
        mustChangePassword: false,
        temporaryPasswordExpiresAt: null,
      }),
    };

    await TestBed.configureTestingModule({
      imports: [UsersListPage],
      providers: [
        provideRouter([]),
        { provide: UsersApiService, useValue: usersApiMock },
        { provide: SessionStore, useValue: sessionStoreMock },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(UsersListPage);
    fixture.detectChanges();
  }

  function root(): HTMLElement {
    return fixture.nativeElement as HTMLElement;
  }

  describe('US4-AC1: lista de cuentas del taller', () => {
    beforeEach(async () => {
      await createComponent('admin');
    });

    it('[US4-AC1] muestra la tabla con nombre, correo, rol y estado para cada cuenta', () => {
      const rows = root().querySelectorAll('[data-testid="user-row"]');
      expect(rows.length).toBe(2);

      const firstRow = rows[0];
      expect(firstRow.querySelector('[data-testid="user-name-link"]')?.textContent?.trim()).toBe('Admin Demo');
      expect(firstRow.querySelector('[data-testid="user-email"]')?.textContent?.trim()).toBe('admin@taller.ec');
      expect(firstRow.querySelector('[data-testid="user-role-badge"]')?.textContent?.trim()).toBe('Administrador');
      expect(firstRow.querySelector('[data-testid="user-status-badge"]')?.textContent?.trim()).toBe('Activo');

      const secondRow = rows[1];
      expect(secondRow.querySelector('[data-testid="user-name-link"]')?.textContent?.trim()).toBe('Asesor Demo');
      expect(secondRow.querySelector('[data-testid="user-email"]')?.textContent?.trim()).toBe('asesor@taller.ec');
      expect(secondRow.querySelector('[data-testid="user-role-badge"]')?.textContent?.trim()).toBe('Asesor');
      expect(secondRow.querySelector('[data-testid="user-status-badge"]')?.textContent?.trim()).toBe('Inactivo');
    });

    it('[US4-AC2] tiene enlace para crear nuevo usuario (/users/new)', () => {
      const createLink = root().querySelector('[data-testid="new-user-link"]') as HTMLAnchorElement;
      expect(createLink).not.toBeNull();
      expect(createLink.getAttribute('href')).toBe('/users/new');
    });

    it('[US4-AC1] cada usuario tiene enlace a su ficha (/users/:id)', () => {
      const detailLink = root().querySelector('[data-testid="user-detail-link"]') as HTMLAnchorElement;
      expect(detailLink.getAttribute('href')).toBe('/users/11111111-1111-4111-8111-111111111111');
    });
  });

  describe('US4-AC16: asesor sin permisos', () => {
    beforeEach(async () => {
      await createComponent('asesor');
    });

    it('[US4-AC16] no llama a la API de usuarios ni muestra la tabla ni el botón crear', () => {
      expect(usersApiMock.list).not.toHaveBeenCalled();
      expect(root().querySelector('[data-testid="users-table"]')).toBeNull();
      expect(root().querySelector('[data-testid="new-user-link"]')).toBeNull();

      const errorAlert = root().querySelector('[data-testid="error-message"]');
      expect(errorAlert?.textContent).toContain('No tiene permisos para gestionar usuarios');
    });
  });
});
