// T053 (003, PR2, US3): generación de contraseña temporal en TicketDetailPage (/support/tickets/:id).
//
// Contrato para el implementer-frontend (T054), archivos features/support/ticket-detail.page.ts (+ .html y .scss)
// y features/support/temporary-password.dialog.ts (+ .html y .scss):
//   En TicketDetailPage, cuando `ticket.status === 'open'`:
//     generate-password-form           sección/formulario para generar la contraseña temporal
//     verification-note                <textarea> o <input> con su <label for> para la nota de verificación de identidad
//     verification-note-warning        aviso visible junto al campo con SUPPORT_MESSAGES.VERIFICATION_NOTE_WARNING:
//                                      "No escriba contraseñas en la nota"
//     generate-password-submit         <button> con el texto "Generar contraseña temporal" (min-height >= 44 px, FR-026).
//                                      Deshabilitado cuando `verificationNote().trim() === ''` o mientras se envía,
//                                      o bien si se envía el formulario vacío / con solo espacios muestra
//                                      `error-verification-note` ("Indique cómo verificó la identidad de la persona")
//                                      con `aria-invalid="true"` en `verification-note` y NO llama a la API.
//     error-verification-note          mensaje de error del campo (`SUPPORT_MESSAGES.VERIFICATION_NOTE_REQUIRED`:
//                                      "Indique cómo verificó la identidad de la persona") cuando se intenta enviar con
//                                      nota vacía o de solo espacios, o cuando el servidor responde 400 VALIDATION_ERROR
//                                      con `errors[{ field: 'verificationNote', code: 'REQUIRED' }]`.
//                                      Marca `verification-note` con `aria-invalid="true"`.
//     generate-password-error          alerta (`role="alert"`) ante errores del servidor al generar la temporal:
//                                      - 409 TICKET_NOT_OPEN → SUPPORT_MESSAGES.TICKET_NOT_OPEN
//                                        ("Solo se puede generar una contraseña temporal sobre un ticket abierto")
//                                      - 409 ACCOUNT_INACTIVE → SUPPORT_MESSAGES.ACCOUNT_INACTIVE
//                                        ("La cuenta está desactivada; el administrador de su taller debe reactivarla")
//   Al enviar con una nota válida (US3-AC1, US3-AC2, US3-AC3, US3-AC9):
//     - Recorta espacios extremos (`verificationNote.trim()`) y llama a
//       `SupportApiService.generateTemporaryPassword(ticket.id, trimmedNote)` (o `{ verificationNote: trimmedNote }`),
//       enviando en el POST únicamente `{ verificationNote }` (nunca `userId` ni `tenantId`).
//     - Con la respuesta 200 (`TemporaryPasswordResponse`):
//       - Actualiza `ticket` con `response.ticket` (`status: 'resolved'`, `resolution` con nota, agente y fecha).
//       - Abre `TemporaryPasswordDialogComponent` (`[data-testid="temporary-password-dialog"]`) mostrando
//         `response.temporaryPassword` en `[data-testid="temporary-password-value"]` (monoespaciada), el botón
//         `[data-testid="temporary-password-copy"]` ("Copiar"), `[data-testid="temporary-password-format-notice"]`
//         ("Escríbala tal cual, con los guiones y en mayúsculas") y `[data-testid="temporary-password-once-notice"]`
//         ("Esta contraseña temporal se muestra una sola vez y no se volverá a mostrar").
//     - Al cerrar el diálogo (`[data-testid="temporary-password-close"]` o tecla Escape):
//       - Limpia la contraseña temporal de la memoria del componente (`null`).
//       - El diálogo desaparece del DOM (`[data-testid="temporary-password-dialog"]` es `null`).
//       - La contraseña temporal NO queda en el DOM de la página, ni en el estado de `TicketDetailPage`,
//         ni en `SupportSessionStore`, ni en `SessionStore`, ni en `localStorage`.
//       - El ticket queda renderizado como "Resuelto" (`[data-testid="ticket-status"]`), con `[data-testid="resolution-info"]`
//         (`resolution-note`, `resolution-by`, `resolution-at` en `America/Guayaquil`) y sin los formularios de ticket
//         abierto (`generate-password-form` ni `discard-form`).
//   Cuando `ticket.status === 'resolved'` o `'discarded'`:
//     - NO muestra `generate-password-form`, `verification-note` ni `generate-password-submit`.
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { Component } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap, provideRouter, Router } from '@angular/router';
import { problemFlush, touchSize } from '../../../testing/auth-fixtures';
import {
  SUPPORT_MESSAGES,
  SUPPORT_TEMP_PASSWORD,
  SUPPORT_TICKETS_URL,
  supportProblem,
  supportSessionResponse,
  TICKET_ID,
  ticketDetailFixture,
  type TemporaryPasswordResponseFixture,
  type TicketDetailFixture,
} from '../../../testing/support-fixtures';
import { SessionStore } from '../../core/auth/session.store';
import { SupportSessionStore } from '../../core/support/support-session.store';
import { TicketDetailPage } from './ticket-detail.page';

@Component({ template: '' })
class StubPage {}

const GET_TICKET_URL = `${SUPPORT_TICKETS_URL}/${TICKET_ID}`;
const TEMP_PASSWORD_URL = `${SUPPORT_TICKETS_URL}/${TICKET_ID}/temporary-password`;
const VERIFICATION_NOTE = 'Videollamada por WhatsApp con cédula en mano y confirmación del RUC 1790012345001';
const ISO_LIKE = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

function resolvedResponseFixture(note = VERIFICATION_NOTE): TemporaryPasswordResponseFixture {
  return {
    temporaryPassword: SUPPORT_TEMP_PASSWORD,
    temporaryPasswordExpiresAt: '2026-10-28T20:10:00.000Z',
    sessionsClosed: 2,
    ticket: ticketDetailFixture({
      id: TICKET_ID,
      number: 101,
      status: 'resolved',
      resolution: {
        verificationNote: note,
        resolvedByName: 'Pedro Soporte',
        resolvedAt: '2026-10-25T20:10:00.000Z',
      },
    }),
  };
}

describe('TicketDetailPage: generación de contraseña temporal (T053)', () => {
  let fixture: ComponentFixture<TicketDetailPage>;
  let httpMock: HttpTestingController;
  let supportStore: SupportSessionStore;
  let workshopStore: SessionStore;

  async function setup(initialTicket: TicketDetailFixture = ticketDetailFixture()): Promise<void> {
    TestBed.resetTestingModule();
    localStorage.clear();
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
      configurable: true,
      writable: true,
    });

    await TestBed.configureTestingModule({
      imports: [TicketDetailPage],
      providers: [
        provideRouter([
          { path: 'support', component: StubPage },
          { path: 'support/tickets/:id', component: StubPage },
        ]),
        provideHttpClient(),
        provideHttpClientTesting(),
        {
          provide: ActivatedRoute,
          useValue: { snapshot: { paramMap: convertToParamMap({ id: TICKET_ID }) } },
        },
      ],
    }).compileComponents();

    httpMock = TestBed.inject(HttpTestingController);
    supportStore = TestBed.inject(SupportSessionStore);
    workshopStore = TestBed.inject(SessionStore);
    supportStore.setSession(supportSessionResponse({ name: 'Pedro Soporte' }));

    await TestBed.inject(Router).navigateByUrl(`/support/tickets/${TICKET_ID}`);
    fixture = TestBed.createComponent(TicketDetailPage);
    fixture.detectChanges();

    httpMock.expectOne(GET_TICKET_URL).flush(initialTicket);
    await settle();
  }

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

  function query<T extends HTMLElement = HTMLElement>(testId: string): T | null {
    return root().querySelector<T>(`[data-testid="${testId}"]`);
  }

  function get<T extends HTMLElement = HTMLElement>(testId: string): T {
    const element = query<T>(testId);
    if (element === null) {
      throw new Error(`No existe [data-testid="${testId}"]`);
    }
    return element;
  }

  function text(testId: string): string {
    return get(testId).textContent?.replace(/\s+/g, ' ').trim() ?? '';
  }

  async function typeVerificationNote(value: string): Promise<void> {
    const input = get<HTMLInputElement | HTMLTextAreaElement>('verification-note');
    input.value = value;
    input.dispatchEvent(new Event('input'));
    await settle();
  }

  async function submitGenerateForm(): Promise<void> {
    const submitBtn = get<HTMLButtonElement>('generate-password-submit');
    if (!submitBtn.disabled) {
      submitBtn.click();
    } else {
      const form = submitBtn.closest('form') ?? get('generate-password-form').querySelector('form');
      form?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    }
    await settle();
  }

  describe('US3-AC3 / FR-023: nota de verificación de identidad y advertencia', () => {
    beforeEach(async () => {
      await setup();
    });

    it('[US3-AC3][FR-023][FR-026] muestra el campo de nota con la advertencia "No escriba contraseñas en la nota" y el botón "Generar contraseña temporal" (>= 44 px) deshabilitado sin nota', () => {
      expect(get('generate-password-form')).not.toBeNull();
      expect(get('verification-note')).not.toBeNull();
      expect(text('verification-note-warning')).toContain(SUPPORT_MESSAGES.VERIFICATION_NOTE_WARNING);

      const submitBtn = get<HTMLButtonElement>('generate-password-submit');
      expect(submitBtn.textContent?.trim()).toContain('Generar contraseña temporal');
      expect(touchSize(submitBtn)).toBeGreaterThanOrEqual(44);
      expect(submitBtn.disabled).toBe(true);
    });

    it('[US3-AC3][FR-023] con una nota de solo espacios, mantiene el botón deshabilitado o al enviar el formulario muestra "Indique cómo verificó la identidad de la persona" en el campo y NO llama a la API', async () => {
      await typeVerificationNote('    ');

      const submitBtn = get<HTMLButtonElement>('generate-password-submit');
      const wasDisabledWithSpaces = submitBtn.disabled;

      await submitGenerateForm();

      httpMock.expectNone(TEMP_PASSWORD_URL);
      expect(text('error-verification-note')).toBe(SUPPORT_MESSAGES.VERIFICATION_NOTE_REQUIRED);
      expect(get('verification-note').getAttribute('aria-invalid')).toBe('true');
      expect(wasDisabledWithSpaces || get('verification-note').getAttribute('aria-invalid') === 'true').toBe(true);
    });

    it('[US3-AC3][FR-023] si el servidor responde 400 VALIDATION_ERROR con REQUIRED en verificationNote, muestra "Indique cómo verificó la identidad de la persona" en el campo y marca aria-invalid="true"', async () => {
      await typeVerificationNote(VERIFICATION_NOTE);
      const submitBtn = get<HTMLButtonElement>('generate-password-submit');
      expect(submitBtn.disabled).toBe(false);

      submitBtn.click();
      await settle();

      const req = httpMock.expectOne(TEMP_PASSWORD_URL);
      req.flush(
        supportProblem(400, 'VALIDATION_ERROR', {
          errors: [{ field: 'verificationNote', code: 'REQUIRED', message: 'Campo obligatorio' }],
        }),
        problemFlush(400),
      );
      await settle();

      expect(text('error-verification-note')).toBe(SUPPORT_MESSAGES.VERIFICATION_NOTE_REQUIRED);
      expect(get('verification-note').getAttribute('aria-invalid')).toBe('true');
      expect(query('temporary-password-dialog')).toBeNull();
      expect(text('ticket-status')).toBe('Abierto');
    });
  });

  describe('US3-AC1 / US3-AC2 / US3-AC9 / FR-019: generación, diálogo de visualización única y cierre', () => {
    beforeEach(async () => {
      await setup();
    });

    it('[US3-AC1][US3-AC2][US3-AC9][FR-019] envía solo { verificationNote } recortada, muestra el diálogo con la temporal una vez y al cerrarlo la temporal no queda en el estado, store ni localStorage y el ticket se ve Resuelto', async () => {
      await typeVerificationNote(`  ${VERIFICATION_NOTE}  `);
      get<HTMLButtonElement>('generate-password-submit').click();
      await settle();

      const req = httpMock.expectOne(TEMP_PASSWORD_URL);
      expect(req.request.method).toBe('POST');
      expect(req.request.body).toEqual({ verificationNote: VERIFICATION_NOTE });
      expect(Object.keys(req.request.body as object)).toEqual(['verificationNote']);
      req.flush(resolvedResponseFixture(VERIFICATION_NOTE));
      await settle();

      // El diálogo se abre mostrando la temporal en fuente monoespaciada con Copiar y los dos avisos.
      const dialog = get('temporary-password-dialog');
      expect(dialog.getAttribute('role')).toBe('dialog');
      expect(text('temporary-password-value')).toBe(SUPPORT_TEMP_PASSWORD);
      expect(text('temporary-password-format-notice')).toContain(SUPPORT_MESSAGES.TEMPORARY_PASSWORD_FORMAT_NOTICE);
      expect(text('temporary-password-once-notice')).toContain(SUPPORT_MESSAGES.TEMPORARY_PASSWORD_ONCE_NOTICE);
      expect(get('temporary-password-copy').textContent).toContain('Copiar');

      // Al cerrar el diálogo, desaparece del DOM y la temporal no queda en ningún sitio.
      get<HTMLButtonElement>('temporary-password-close').click();
      await settle();

      expect(query('temporary-password-dialog')).toBeNull();
      expect(query('temporary-password-value')).toBeNull();
      expect(root().textContent ?? '').not.toContain(SUPPORT_TEMP_PASSWORD);
      expect(JSON.stringify(fixture.componentInstance)).not.toContain(SUPPORT_TEMP_PASSWORD);
      expect(JSON.stringify(supportStore.agent())).not.toContain(SUPPORT_TEMP_PASSWORD);
      expect(JSON.stringify(workshopStore.user())).not.toContain(SUPPORT_TEMP_PASSWORD);
      for (let i = 0; i < localStorage.length; i += 1) {
        const key = localStorage.key(i);
        if (key !== null) {
          expect(localStorage.getItem(key)).not.toContain(SUPPORT_TEMP_PASSWORD);
        }
      }

      // El ticket se ve Resuelto, con su nota, agente y fecha en America/Guayaquil, y sin formularios de abierto.
      expect(text('ticket-status')).toBe('Resuelto');
      expect(query('generate-password-form')).toBeNull();
      expect(query('generate-password-submit')).toBeNull();
      expect(query('discard-form')).toBeNull();
      expect(query('discard-submit')).toBeNull();

      expect(text('resolution-note')).toBe(VERIFICATION_NOTE);
      expect(text('resolution-by')).toContain('Pedro Soporte');
      // 2026-10-25T20:10:00.000Z → 15:10 en America/Guayaquil (UTC-5)
      const resolvedAt = text('resolution-at');
      expect(resolvedAt).not.toMatch(ISO_LIKE);
      expect(resolvedAt).toContain('15:10');
    });
  });

  describe('US3-AC5 / US3-AC8 / US2-AC13: errores 409 del servidor y tickets cerrados', () => {
    it('[US3-AC5][US3-AC12] si generateTemporaryPassword responde 409 TICKET_NOT_OPEN muestra "Solo se puede generar una contraseña temporal sobre un ticket abierto"', async () => {
      await setup();
      await typeVerificationNote(VERIFICATION_NOTE);
      get<HTMLButtonElement>('generate-password-submit').click();
      await settle();

      httpMock.expectOne(TEMP_PASSWORD_URL).flush(supportProblem(409, 'TICKET_NOT_OPEN'), problemFlush(409));
      await settle();

      const alert = get('generate-password-error');
      expect(alert.getAttribute('role')).toBe('alert');
      expect(alert.textContent?.trim()).toBe(SUPPORT_MESSAGES.TICKET_NOT_OPEN);
      expect(query('temporary-password-dialog')).toBeNull();
    });

    it('[US3-AC8] si generateTemporaryPassword responde 409 ACCOUNT_INACTIVE (o la cuenta del ticket está desactivada) muestra "La cuenta está desactivada; el administrador de su taller debe reactivarla"', async () => {
      await setup();
      await typeVerificationNote(VERIFICATION_NOTE);
      get<HTMLButtonElement>('generate-password-submit').click();
      await settle();

      httpMock.expectOne(TEMP_PASSWORD_URL).flush(supportProblem(409, 'ACCOUNT_INACTIVE'), problemFlush(409));
      await settle();

      const alert = get('generate-password-error');
      expect(alert.getAttribute('role')).toBe('alert');
      expect(alert.textContent?.trim()).toBe(SUPPORT_MESSAGES.ACCOUNT_INACTIVE);
      expect(query('temporary-password-dialog')).toBeNull();
    });

    it('[US2-AC13][US3-AC5] muestra el formulario de generar contraseña temporal solo cuando el ticket está abierto y lo oculta cuando está Resuelto o Descartado', async () => {
      await setup();
      expect(get('generate-password-form')).not.toBeNull();
      expect(get('verification-note')).not.toBeNull();
      expect(get('generate-password-submit')).not.toBeNull();

      await setup(
        ticketDetailFixture({
          id: TICKET_ID,
          status: 'resolved',
          resolution: {
            verificationNote: VERIFICATION_NOTE,
            resolvedByName: 'Pedro Soporte',
            resolvedAt: '2026-10-25T20:10:00.000Z',
          },
        }),
      );

      expect(query('generate-password-form')).toBeNull();
      expect(query('verification-note')).toBeNull();
      expect(query('generate-password-submit')).toBeNull();
    });
  });
});
