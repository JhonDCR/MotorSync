// T039 (003, PR1, US2): detalle de un ticket y acción "Descartar" (/support/tickets/:id).
//
// Contrato para el implementer-frontend (T040), archivo features/support/ticket-detail.page.ts (+ .html y .scss):
//   export class TicketDetailPage (standalone). Ruta `/support/tickets/:id` bajo SupportShellComponent.
//   Al inicializar lee `id` de ActivatedRoute y llama a SupportApiService.getTicket(id) (GET /api/v1/support/tickets/:id).
//   Selectores (data-testid):
//     back-to-inbox              <a routerLink="/support"> para volver a la bandeja
//     ticket-number              número legible del ticket (incluye `101` / `#101`)
//     ticket-status              "Abierto" (`open`), "Resuelto" (`resolved`) o "Descartado" (`discarded`)
//     ticket-created-at          fecha de creación en hora de Ecuador (`America/Guayaquil`, UTC-5, nunca ISO crudo)
//     ticket-last-requested-at   fecha de última solicitud en `America/Guayaquil`
//     ticket-request-count       número de solicitudes
//     ticket-account-email       correo de la cuenta (`account.email`)
//     ticket-account-name        nombre de la cuenta (`account.name`)
//     ticket-account-role        "Administrador" (`admin`) o "Asesor" (`asesor`)
//     ticket-account-status      "Activo" (`active`) o "Inactivo" (`inactive`)
//     ticket-workshop-name       nombre comercial del taller (`workshop.name`)
//     ticket-workshop-ruc        RUC del taller (`workshop.ruc`)
//   Cuando `ticket.status === 'open'` (US2-AC8, US2-AC12):
//     discard-form               formulario/sección para descartar el ticket
//     discard-reason             <textarea> o <input> con su <label for> para el motivo de descarte
//     discard-submit             <button> "Descartar ticket" / "Descartar" (min-height >= 44 px, FR-026)
//     error-discard-reason       mensaje de error si el motivo está vacío o solo tiene espacios ("Este campo es obligatorio");
//                                marca `discard-reason` con aria-invalid="true" y NO llama a discardTicket.
//     discard-error              alerta (role="alert") ante error del servidor al descartar (p. ej. 409 TICKET_NOT_OPEN →
//                                SUPPORT_MESSAGES.TICKET_NOT_OPEN).
//     Al enviar un motivo válido: recorta los espacios extremos (`reason.trim()`), llama a
//     SupportApiService.discardTicket(ticket.id, reason) y tras el 200 navega de vuelta a `/support`.
//   Cuando `ticket.status === 'discarded'` o `'resolved'` (US2-AC13, FR-014, FR-015):
//     - NO muestra `discard-form`, `discard-reason` ni `discard-submit` (un ticket cerrado no tiene acciones de cambio de estado).
//     - Si `status === 'discarded'`: muestra `discard-info` con `discard-reason-value` (`discard.reason`),
//       `discard-by` (`discard.discardedByName`) y `discard-at` (formateada en `America/Guayaquil`).
//     - Si `status === 'resolved'`: muestra `resolution-info` con `resolution-note` (`resolution.verificationNote`),
//       `resolution-by` (`resolution.resolvedByName`) y `resolution-at` (formateada en `America/Guayaquil`).
//   Si getTicket responde 404 NOT_FOUND: muestra `ticket-error` (role="alert").
import { Component } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap, provideRouter, Router } from '@angular/router';
import { of, throwError } from 'rxjs';
import { touchSize } from '../../../testing/auth-fixtures';
import {
  SUPPORT_MESSAGES,
  supportProblem,
  TICKET_ID,
  ticketDetailFixture,
  type TicketDetailFixture,
} from '../../../testing/support-fixtures';
import { SupportApiService } from '../../core/api/support-api.service';
import { TicketDetailPage } from './ticket-detail.page';

@Component({ template: '' })
class StubPage {}

const ISO_LIKE = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

describe('TicketDetailPage (T039)', () => {
  let fixture: ComponentFixture<TicketDetailPage>;
  let api: {
    getTicket: ReturnType<typeof vi.fn<SupportApiService['getTicket']>>;
    discardTicket: ReturnType<typeof vi.fn<SupportApiService['discardTicket']>>;
  };

  async function setup(ticket: TicketDetailFixture | null = ticketDetailFixture(), loadError?: unknown): Promise<void> {
    const discardedTicket = ticketDetailFixture({
      status: 'discarded',
      discard: {
        reason: 'El asesor ya fue atendido por su administrador',
        discardedByName: 'Pedro Soporte',
        discardedAt: '2026-10-25T18:00:00.000Z',
      },
    });
    api = {
      getTicket: vi.fn<SupportApiService['getTicket']>(() =>
        loadError !== undefined ? throwError(() => loadError) : of(ticket!),
      ),
      discardTicket: vi.fn<SupportApiService['discardTicket']>(() => of(discardedTicket)),
    };
    await TestBed.configureTestingModule({
      imports: [TicketDetailPage],
      providers: [
        provideRouter([
          { path: 'support', component: StubPage },
          { path: 'support/tickets/:id', component: StubPage },
        ]),
        { provide: SupportApiService, useValue: api },
        {
          provide: ActivatedRoute,
          useValue: { snapshot: { paramMap: convertToParamMap({ id: TICKET_ID }) } },
        },
      ],
    }).compileComponents();
    await TestBed.inject(Router).navigateByUrl(`/support/tickets/${TICKET_ID}`);
    fixture = TestBed.createComponent(TicketDetailPage);
    await settle();
  }

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
    if (element === null) throw new Error(`No existe [data-testid="${testId}"]`);
    return element;
  }

  function text(testId: string): string {
    return get(testId).textContent?.trim() ?? '';
  }

  async function typeReason(value: string): Promise<void> {
    const input = get<HTMLInputElement | HTMLTextAreaElement>('discard-reason');
    input.value = value;
    input.dispatchEvent(new Event('input'));
    await settle();
  }

  describe('ticket abierto (status = open)', () => {
    beforeEach(async () => {
      await setup(
        ticketDetailFixture({
          id: TICKET_ID,
          number: 101,
          status: 'open',
          createdAt: '2026-10-25T02:15:00.000Z',
          lastRequestedAt: '2026-10-25T03:45:00.000Z',
          requestCount: 2,
          account: {
            email: 'ana.perez@taller.ec',
            name: 'Ana Pérez',
            role: 'admin',
            status: 'active',
          },
          workshop: {
            name: 'Taller Andrade',
            ruc: '1790012345001',
          },
        }),
      );
    });

    it('[FR-012][US2-AC7] muestra todos los datos del ticket, de la cuenta y del taller con fechas en America/Guayaquil', () => {
      expect(api.getTicket).toHaveBeenCalledWith(TICKET_ID);
      expect(text('ticket-number')).toContain('101');
      expect(text('ticket-status')).toBe('Abierto');
      expect(text('ticket-request-count')).toBe('2');
      expect(text('ticket-account-email')).toBe('ana.perez@taller.ec');
      expect(text('ticket-account-name')).toBe('Ana Pérez');
      expect(text('ticket-account-role')).toBe('Administrador');
      expect(text('ticket-account-status')).toBe('Activo');
      expect(text('ticket-workshop-name')).toBe('Taller Andrade');
      expect(text('ticket-workshop-ruc')).toBe('1790012345001');

      // 2026-10-25T02:15:00.000Z → 24/10/2026 21:15 en America/Guayaquil (UTC-5)
      const createdAt = text('ticket-created-at');
      expect(createdAt).not.toMatch(ISO_LIKE);
      expect(createdAt).toContain('21:15');

      const lastReq = text('ticket-last-requested-at');
      expect(lastReq).not.toMatch(ISO_LIKE);
      expect(lastReq).toContain('22:45');
    });

    it('[US2-AC12] si el motivo de descarte está vacío o solo tiene espacios, marca error en el campo y NO llama a la API', async () => {
      await typeReason('   ');
      get('discard-submit').click();
      await settle();

      expect(text('error-discard-reason')).toBe('Este campo es obligatorio');
      expect(get('discard-reason').getAttribute('aria-invalid')).toBe('true');
      expect(api.discardTicket).not.toHaveBeenCalled();
      expect(TestBed.inject(Router).url).toBe(`/support/tickets/${TICKET_ID}`);
    });

    it('[US2-AC12][US2-AC8] al descartar con un motivo válido recorta espacios, llama a discardTicket y vuelve a la bandeja (/support)', async () => {
      await typeReason('  El asesor ya fue atendido por su administrador  ');
      get('discard-submit').click();
      await settle();

      expect(api.discardTicket).toHaveBeenCalledTimes(1);
      expect(api.discardTicket).toHaveBeenCalledWith(TICKET_ID, 'El asesor ya fue atendido por su administrador');
      await vi.waitFor(() => expect(TestBed.inject(Router).url).toBe('/support'));
    });

    it('[US2-AC13] si discardTicket responde 409 TICKET_NOT_OPEN muestra el mensaje de problema y no navega', async () => {
      api.discardTicket.mockReturnValueOnce(throwError(() => supportProblem(409, 'TICKET_NOT_OPEN')));

      await typeReason('Motivo válido');
      get('discard-submit').click();
      await settle();

      expect(text('discard-error')).toBe(SUPPORT_MESSAGES.TICKET_NOT_OPEN);
      expect(get('discard-error').getAttribute('role')).toBe('alert');
      expect(TestBed.inject(Router).url).toBe(`/support/tickets/${TICKET_ID}`);
    });

    it('[FR-026] el botón de descartar tiene objetivo táctil de al menos 44 px', () => {
      expect(touchSize(get('discard-submit'))).toBeGreaterThanOrEqual(44);
    });
  });

  describe('ticket cerrado (US2-AC13, FR-014, FR-015)', () => {
    it('[US2-AC13][FR-014] un ticket Descartado se muestra sin formulario de descarte y con su motivo, agente y fecha en America/Guayaquil', async () => {
      await setup(
        ticketDetailFixture({
          id: TICKET_ID,
          status: 'discarded',
          discard: {
            reason: 'Solicitud duplicada atendida por el taller',
            discardedByName: 'Pedro Soporte',
            discardedAt: '2026-10-25T19:30:00.000Z',
          },
        }),
      );

      expect(text('ticket-status')).toBe('Descartado');
      expect(query('discard-form')).toBeNull();
      expect(query('discard-reason')).toBeNull();
      expect(query('discard-submit')).toBeNull();

      expect(text('discard-reason-value')).toBe('Solicitud duplicada atendida por el taller');
      expect(text('discard-by')).toContain('Pedro Soporte');
      // 2026-10-25T19:30:00.000Z → 14:30 en America/Guayaquil (UTC-5)
      const discardAt = text('discard-at');
      expect(discardAt).not.toMatch(ISO_LIKE);
      expect(discardAt).toContain('14:30');
    });

    it('[US2-AC13][FR-014] un ticket Resuelto se muestra sin formulario de descarte y con su nota de verificación, agente y fecha en America/Guayaquil', async () => {
      await setup(
        ticketDetailFixture({
          id: TICKET_ID,
          status: 'resolved',
          resolution: {
            verificationNote: 'Videollamada con cédula en mano',
            resolvedByName: 'Pedro Soporte',
            resolvedAt: '2026-10-25T20:10:00.000Z',
          },
        }),
      );

      expect(text('ticket-status')).toBe('Resuelto');
      expect(query('discard-form')).toBeNull();
      expect(query('discard-submit')).toBeNull();

      expect(text('resolution-note')).toBe('Videollamada con cédula en mano');
      expect(text('resolution-by')).toContain('Pedro Soporte');
      // 2026-10-25T20:10:00.000Z → 15:10 en America/Guayaquil (UTC-5)
      const resolvedAt = text('resolution-at');
      expect(resolvedAt).not.toMatch(ISO_LIKE);
      expect(resolvedAt).toContain('15:10');
    });
  });

  describe('error al cargar el ticket', () => {
    it('[FR-012] si getTicket responde 404 NOT_FOUND muestra alerta de error', async () => {
      await setup(null, supportProblem(404, 'NOT_FOUND'));

      const alert = get('ticket-error');
      expect(alert.getAttribute('role')).toBe('alert');
      expect(alert.textContent?.trim().length ?? 0).toBeGreaterThan(0);
    });
  });
});
