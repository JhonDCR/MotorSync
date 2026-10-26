// T039 (003, PR1, US2): bandeja de tickets abiertos (/support).
//
// Contrato para el implementer-frontend (T040), archivo features/support/tickets-inbox.page.ts (+ .html y .scss):
//   export class TicketsInboxPage (standalone). Ruta `/support` (hija por defecto de SupportShellComponent).
//   Al inicializar llama a SupportApiService.listOpenTickets() (GET /api/v1/support/tickets).
//   Selectores (data-testid):
//     tickets-table                <table> cuando hay tickets abiertos
//     ticket-row                   <tr> por cada ticket abierto, del más antiguo al más reciente (US2-AC7, FR-013)
//     Dentro de cada [data-testid="ticket-row"]:
//       ticket-created-at          fecha y hora de creación formateada en hora local de Ecuador (`America/Guayaquil`,
//                                  UTC-5, p. ej. `24/10/2026 21:15` para `2026-10-25T02:15:00.000Z`, nunca ISO crudo)
//       ticket-last-requested-at   fecha y hora de la última solicitud en `America/Guayaquil`
//       ticket-request-count       número de solicitudes (`requestCount`)
//       ticket-account-email       correo de la cuenta (`account.email`)
//       ticket-account-name        nombre de la cuenta (`account.name`)
//       ticket-account-role        "Administrador" (`admin`) o "Asesor" (`asesor`)
//       ticket-account-status      "Activo" (`active`) o "Inactivo" (`inactive`)
//       ticket-workshop-name       nombre comercial del taller (`workshop.name`)
//       ticket-workshop-ruc        RUC del taller (`workshop.ruc`, o "—" / "Sin RUC" si es null)
//       ticket-detail-link         <a [routerLink]="['/support/tickets', ticket.id]"> para abrir el detalle
//     tickets-empty                mensaje visible cuando `items` está vacío
//     tickets-error                mensaje de error (role="alert") si falla la carga
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { of, throwError } from 'rxjs';
import {
  OTHER_TICKET_ID,
  supportProblem,
  TICKET_ID,
  ticketSummaryFixture,
  type TicketSummaryFixture,
} from '../../../testing/support-fixtures';
import { SupportApiService } from '../../core/api/support-api.service';
import { TicketsInboxPage } from './tickets-inbox.page';

const ISO_LIKE = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

/**
 * Dos tickets donde `2026-10-25T02:15:00.000Z` en UTC es día 25 a las 02:15,
 * pero en `America/Guayaquil` (UTC-5) es el día 24/10/2026 a las 21:15.
 */
const OLDER_TICKET: TicketSummaryFixture = ticketSummaryFixture({
  id: TICKET_ID,
  number: 101,
  createdAt: '2026-10-25T02:15:00.000Z',
  lastRequestedAt: '2026-10-25T03:45:00.000Z',
  requestCount: 3,
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
});

const NEWER_TICKET: TicketSummaryFixture = ticketSummaryFixture({
  id: OTHER_TICKET_ID,
  number: 102,
  createdAt: '2026-10-25T16:30:00.000Z',
  lastRequestedAt: '2026-10-25T17:05:00.000Z',
  requestCount: 1,
  account: {
    email: 'luis.mora@otro.ec',
    name: 'Luis Mora',
    role: 'asesor',
    status: 'inactive',
  },
  workshop: {
    name: 'Mecánica del Sur',
    ruc: null,
  },
});

describe('TicketsInboxPage (T039)', () => {
  let fixture: ComponentFixture<TicketsInboxPage>;
  let api: { listOpenTickets: ReturnType<typeof vi.fn<SupportApiService['listOpenTickets']>> };

  async function renderWith(
    items: TicketSummaryFixture[] = [OLDER_TICKET, NEWER_TICKET],
    error?: unknown,
  ): Promise<void> {
    api = {
      listOpenTickets: vi.fn<SupportApiService['listOpenTickets']>(() =>
        error !== undefined ? throwError(() => error) : of({ items }),
      ),
    };
    await TestBed.configureTestingModule({
      imports: [TicketsInboxPage],
      providers: [provideRouter([]), { provide: SupportApiService, useValue: api }],
    }).compileComponents();
    fixture = TestBed.createComponent(TicketsInboxPage);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  }

  function root(): HTMLElement {
    return fixture.nativeElement as HTMLElement;
  }

  function cellText(row: Element, testId: string): string {
    const el = row.querySelector(`[data-testid="${testId}"]`);
    if (el === null) {
      throw new Error(`No existe [data-testid="${testId}"] en la fila`);
    }
    return el.textContent?.trim() ?? '';
  }

  it('[US2-AC7][FR-013] muestra los tickets abiertos del más antiguo al más reciente con las 9 columnas requeridas y enlace al detalle', async () => {
    await renderWith([OLDER_TICKET, NEWER_TICKET]);

    expect(api.listOpenTickets).toHaveBeenCalledTimes(1);
    const rows = root().querySelectorAll('[data-testid="ticket-row"]');
    expect(rows).toHaveLength(2);

    const first = rows[0];
    expect(cellText(first, 'ticket-request-count')).toBe('3');
    expect(cellText(first, 'ticket-account-email')).toBe('ana.perez@taller.ec');
    expect(cellText(first, 'ticket-account-name')).toBe('Ana Pérez');
    expect(cellText(first, 'ticket-account-role')).toBe('Administrador');
    expect(cellText(first, 'ticket-account-status')).toBe('Activo');
    expect(cellText(first, 'ticket-workshop-name')).toBe('Taller Andrade');
    expect(cellText(first, 'ticket-workshop-ruc')).toBe('1790012345001');
    const firstLink = first.querySelector<HTMLAnchorElement>('[data-testid="ticket-detail-link"]');
    expect(firstLink?.getAttribute('href')).toBe(`/support/tickets/${TICKET_ID}`);

    const second = rows[1];
    expect(cellText(second, 'ticket-request-count')).toBe('1');
    expect(cellText(second, 'ticket-account-email')).toBe('luis.mora@otro.ec');
    expect(cellText(second, 'ticket-account-name')).toBe('Luis Mora');
    expect(cellText(second, 'ticket-account-role')).toBe('Asesor');
    expect(cellText(second, 'ticket-account-status')).toBe('Inactivo');
    expect(cellText(second, 'ticket-workshop-name')).toBe('Mecánica del Sur');
    const secondLink = second.querySelector<HTMLAnchorElement>('[data-testid="ticket-detail-link"]');
    expect(secondLink?.getAttribute('href')).toBe(`/support/tickets/${OTHER_TICKET_ID}`);
  });

  it('[US2-AC7] formatea las fechas de creación y última solicitud en la zona horaria America/Guayaquil (UTC-5), nunca en ISO crudo', async () => {
    await renderWith([OLDER_TICKET, NEWER_TICKET]);

    const rows = root().querySelectorAll('[data-testid="ticket-row"]');
    const createdFirst = cellText(rows[0], 'ticket-created-at');
    const lastReqFirst = cellText(rows[0], 'ticket-last-requested-at');
    const createdSecond = cellText(rows[1], 'ticket-created-at');

    // 2026-10-25T02:15:00.000Z → 24/10/2026 21:15 en America/Guayaquil (UTC-5)
    expect(createdFirst).not.toMatch(ISO_LIKE);
    expect(createdFirst).toContain('24');
    expect(createdFirst).toContain('21:15');

    // 2026-10-25T03:45:00.000Z → 24/10/2026 22:45 en America/Guayaquil (UTC-5)
    expect(lastReqFirst).not.toMatch(ISO_LIKE);
    expect(lastReqFirst).toContain('22:45');

    // 2026-10-25T16:30:00.000Z → 25/10/2026 11:30 en America/Guayaquil (UTC-5)
    expect(createdSecond).not.toMatch(ISO_LIKE);
    expect(createdSecond).toContain('25');
    expect(createdSecond).toContain('11:30');
  });

  it('[US2-AC7] cuando no hay tickets abiertos muestra el estado vacío y oculta la tabla', async () => {
    await renderWith([]);

    expect(root().querySelector('[data-testid="tickets-table"]')).toBeNull();
    const empty = root().querySelector('[data-testid="tickets-empty"]');
    expect(empty).not.toBeNull();
    expect(empty?.textContent?.trim().length ?? 0).toBeGreaterThan(0);
  });

  it('[US2-AC7] cuando falla la carga muestra un mensaje de error con role="alert"', async () => {
    await renderWith([], supportProblem(500, 'INTERNAL_ERROR'));

    const alert = root().querySelector('[data-testid="tickets-error"]');
    expect(alert).not.toBeNull();
    expect(alert?.getAttribute('role')).toBe('alert');
  });
});
