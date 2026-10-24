// Revisión del PR3 (002, US4): ficha de usuario, foco del diálogo y formato de fechas.
//
// Contrato para el implementer-frontend (user-detail.page.ts/.html):
//   - Al cerrar el diálogo de restablecer (Cancelar o Escape), el foco vuelve al botón que lo abrió
//     (data-testid="reset-password-button").
//   - Las fechas (info-created-at, info-updated-at y entry-date del historial) se muestran en un formato legible de
//     fecha y hora (por ejemplo con DatePipe, "24/10/2026 05:00"), nunca como la cadena ISO del contrato.
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap, provideRouter } from '@angular/router';
import type { UserAccount, UserAuditEntry } from '../../core/api/api.models';
import { SessionStore } from '../../core/auth/session.store';
import { sessionResponse } from '../../../testing/auth-fixtures';
import { UserDetailPage } from './user-detail.page';

const TARGET_ID = '22222222-2222-4222-8222-222222222222';
const USER_URL = `/api/v1/users/${TARGET_ID}`;
const HISTORY_URL = `${USER_URL}/history`;

const CREATED_AT = '2026-10-24T10:00:00.000Z';
const UPDATED_AT = '2026-10-24T11:30:00.000Z';
const OCCURRED_AT = '2026-10-24T12:45:00.000Z';

const TARGET: UserAccount = {
  id: TARGET_ID,
  name: 'Luis Mora',
  email: 'luis.mora@taller.ec',
  role: 'asesor',
  status: 'active',
  mustChangePassword: false,
  temporaryPasswordExpiresAt: null,
  createdAt: CREATED_AT,
  updatedAt: UPDATED_AT,
  updatedByName: 'Ana Pérez',
};

const HISTORY: UserAuditEntry[] = [
  {
    id: 'h1',
    action: 'user.role_changed',
    actorName: 'Ana Pérez',
    actorRole: 'admin',
    occurredAt: OCCURRED_AT,
    before: { role: 'admin' },
    after: { role: 'asesor' },
    ip: '127.0.0.1',
    channel: 'web',
  },
];

const ISO_LIKE = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

describe('UserDetailPage: foco y fechas (revisión PR3)', () => {
  let fixture: ComponentFixture<UserDetailPage>;
  let httpMock: HttpTestingController;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [UserDetailPage],
      providers: [
        provideRouter([]),
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: ActivatedRoute, useValue: { snapshot: { paramMap: convertToParamMap({ id: TARGET_ID }) } } },
      ],
    }).compileComponents();
    httpMock = TestBed.inject(HttpTestingController);
    // La sesión es de otra cuenta (ADMIN_USER_ID): el botón "Restablecer" está disponible.
    TestBed.inject(SessionStore).setSession(sessionResponse({ role: 'admin' }));

    fixture = TestBed.createComponent(UserDetailPage);
    fixture.detectChanges();
    httpMock.expectOne(USER_URL).flush(TARGET);
    fixture.detectChanges();
    httpMock.expectOne(HISTORY_URL).flush({ items: HISTORY });
    await settle();
  });

  afterEach(() => {
    httpMock.verify();
    localStorage.clear();
  });

  async function settle(): Promise<void> {
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  }

  function root(): HTMLElement {
    return fixture.nativeElement as HTMLElement;
  }

  function byTestId(testId: string): HTMLElement {
    const element = root().querySelector<HTMLElement>(`[data-testid="${testId}"]`);
    if (element === null) throw new Error(`No existe [data-testid="${testId}"]`);
    return element;
  }

  function text(testId: string): string {
    return byTestId(testId).textContent?.trim() ?? '';
  }

  async function openDialog(): Promise<HTMLElement> {
    const opener = byTestId('reset-password-button');
    opener.focus();
    opener.click();
    await settle();
    expect(root().querySelector('[role="dialog"]')).not.toBeNull();
    return opener;
  }

  /** La persona trabaja dentro del diálogo: el foco ya no está en el botón que lo abrió. */
  function focusInsideDialog(): void {
    root().querySelector<HTMLInputElement>('[data-testid="temporary-password-input"]')?.focus();
    expect(document.activeElement).not.toBe(byTestId('reset-password-button'));
  }

  describe('foco del diálogo "Restablecer contraseña"', () => {
    it('[US4-AC21][FR-025] al abrir, el foco pasa al campo de la temporal', async () => {
      await openDialog();

      await vi.waitFor(() =>
        expect(document.activeElement).toBe(root().querySelector('[data-testid="temporary-password-input"]')),
      );
    });

    it('[FR-028][FR-025] al cancelar, el foco vuelve al botón "Restablecer contraseña"', async () => {
      const opener = await openDialog();
      focusInsideDialog();

      byTestId('cancel-reset-button').click();
      await settle();

      expect(root().querySelector('[role="dialog"]')).toBeNull();
      await vi.waitFor(() => expect(document.activeElement).toBe(opener));
    });

    it('[FR-028][FR-025] al cerrar con Escape, el foco vuelve al botón "Restablecer contraseña"', async () => {
      const opener = await openDialog();
      focusInsideDialog();

      // Desde el elemento enfocado; burbujea hasta document y window.
      (document.activeElement ?? document.body).dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
      );
      await settle();

      expect(root().querySelector('[role="dialog"]')).toBeNull();
      await vi.waitFor(() => expect(document.activeElement).toBe(opener));
    });
  });

  describe('formato de fechas', () => {
    for (const testId of ['info-created-at', 'info-updated-at']) {
      it(`[FR-020] ${testId} muestra fecha y hora legibles, no ISO crudo`, () => {
        const shown = text(testId);

        expect(shown).not.toBe('');
        expect(shown).not.toMatch(ISO_LIKE);
        expect(shown).not.toContain('.000Z');
        expect(shown).toContain('2026');
        expect(shown).toMatch(/\d{1,2}:\d{2}/);
      });
    }

    it('[US4-AC12] la fecha del historial muestra fecha y hora legibles, no ISO crudo', () => {
      const shown = text('entry-date');

      expect(shown).not.toMatch(ISO_LIKE);
      expect(shown).not.toContain('.000Z');
      expect(shown).toContain('2026');
      expect(shown).toMatch(/\d{1,2}:\d{2}/);
    });
  });
});
