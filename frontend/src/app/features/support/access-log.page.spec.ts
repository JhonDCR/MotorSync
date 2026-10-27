// T066 (003, PR3, US4): bitácora de soporte (/support/access-log).
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap, provideRouter, Router } from '@angular/router';
import { of, throwError } from 'rxjs';
import { touchSize } from '../../../testing/auth-fixtures';
import {
  accessLogEntryFixture,
  ACCESS_LOG_ID,
  OTHER_SUPPORT_AGENT_ID,
  OTHER_WORKSHOP_ID,
  SUPPORT_AGENT_ID,
  WORKSHOP_ID,
  type AccessLogEntryFixture,
} from '../../../testing/support-fixtures';
import { SupportApiService } from '../../core/api/support-api.service';
import { AccessLogPage } from './access-log.page';

const ENTRY_A: AccessLogEntryFixture = accessLogEntryFixture({
  id: ACCESS_LOG_ID,
  occurredAt: '2026-10-25T14:05:00.000Z', // 25/10/2026 09:05 en America/Guayaquil
  agent: { id: SUPPORT_AGENT_ID, name: 'Pedro Soporte' },
  workshop: { id: WORKSHOP_ID, name: 'Taller Andrade', ruc: '1790012345001' },
  ip: '192.168.1.10',
  channel: 'support_panel',
});

const ENTRY_B: AccessLogEntryFixture = accessLogEntryFixture({
  id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  occurredAt: '2026-10-25T16:30:00.000Z', // 25/10/2026 11:30 en America/Guayaquil
  agent: { id: OTHER_SUPPORT_AGENT_ID, name: 'Marta Soporte' },
  workshop: { id: OTHER_WORKSHOP_ID, name: 'Taller Benítez', ruc: null },
  ip: null,
  channel: 'support_panel',
});

describe('AccessLogPage (T066)', () => {
  let fixture: ComponentFixture<AccessLogPage>;
  let router: Router;
  let api: { listAccessLog: ReturnType<typeof vi.fn<SupportApiService['listAccessLog']>> };

  async function renderWith(
    items: AccessLogEntryFixture[] = [ENTRY_B, ENTRY_A],
    total = items.length,
    page = 1,
    pageSize = 50,
    queryParams: Record<string, string> = {},
    error?: unknown,
  ): Promise<void> {
    api = {
      listAccessLog: vi.fn<SupportApiService['listAccessLog']>(() =>
        error !== undefined ? throwError(() => error) : of({ items, total, page, pageSize }),
      ),
    };
    await TestBed.configureTestingModule({
      imports: [AccessLogPage],
      providers: [
        provideRouter([]),
        { provide: SupportApiService, useValue: api },
        {
          provide: ActivatedRoute,
          useValue: {
            snapshot: { queryParamMap: convertToParamMap(queryParams) },
            queryParamMap: of(convertToParamMap(queryParams)),
          },
        },
      ],
    }).compileComponents();
    router = TestBed.inject(Router);
    vi.spyOn(router, 'navigate').mockResolvedValue(true);
    fixture = TestBed.createComponent(AccessLogPage);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  }

  function get<T extends HTMLElement = HTMLElement>(testId: string): T {
    const el = fixture.nativeElement.querySelector(`[data-testid="${testId}"]`);
    expect(el, `Elemento [data-testid="${testId}"] no encontrado`).toBeTruthy();
    return el as T;
  }

  function query<T extends HTMLElement = HTMLElement>(testId: string): T | null {
    return fixture.nativeElement.querySelector(`[data-testid="${testId}"]`);
  }

  function getAll<T extends HTMLElement = HTMLElement>(testId: string): T[] {
    return Array.from(fixture.nativeElement.querySelectorAll(`[data-testid="${testId}"]`));
  }

  it('[US4-AC8] muestra registros de la más reciente a la más antigua con fecha en hora de Ecuador, agente, taller, RUC e IP/canal', async () => {
    await renderWith();

    expect(query('access-log-table')).toBeTruthy();
    const rows = getAll('access-log-row');
    expect(rows).toHaveLength(2);

    const first = rows[0];
    expect(first.querySelector('[data-testid="log-occurred-at"]')?.textContent?.trim()).toBe('25/10/2026 11:30');
    expect(first.querySelector('[data-testid="log-agent-name"]')?.textContent?.trim()).toBe('Marta Soporte');
    expect(first.querySelector('[data-testid="log-workshop-name"]')?.textContent?.trim()).toBe('Taller Benítez');
    expect(first.querySelector('[data-testid="log-workshop-ruc"]')?.textContent?.trim()).toBe('—');
    expect(first.querySelector('[data-testid="log-ip"]')?.textContent?.trim()).toBe('Sin IP');

    const second = rows[1];
    expect(second.querySelector('[data-testid="log-occurred-at"]')?.textContent?.trim()).toBe('25/10/2026 09:05');
    expect(second.querySelector('[data-testid="log-agent-name"]')?.textContent?.trim()).toBe('Pedro Soporte');
    expect(second.querySelector('[data-testid="log-workshop-name"]')?.textContent?.trim()).toBe('Taller Andrade');
    expect(second.querySelector('[data-testid="log-workshop-ruc"]')?.textContent?.trim()).toBe('1790012345001');
    expect(second.querySelector('[data-testid="log-ip"]')?.textContent?.trim()).toBe('192.168.1.10');
  });

  it('[US4-AC8] tocar el taller o el agente agrega un filtro y actualiza la lista', async () => {
    await renderWith();

    const workshopBtn = getAll<HTMLButtonElement>('log-workshop-name')[0];
    workshopBtn.click();
    await fixture.whenStable();

    expect(router.navigate).toHaveBeenCalledWith([], expect.objectContaining({
      queryParams: expect.objectContaining({ workshopId: OTHER_WORKSHOP_ID }),
    }));
  });

  it('[US4-AC8] muestra chips de filtro activos cuando vienen en la query y permite quitarlos', async () => {
    await renderWith([ENTRY_A], 1, 1, 50, { workshopId: WORKSHOP_ID, agentId: SUPPORT_AGENT_ID });

    const workshopChip = query('filter-chip-workshop');
    const agentChip = query('filter-chip-agent');
    expect(workshopChip).toBeTruthy();
    expect(agentChip).toBeTruthy();

    const removeWorkshop = get<HTMLButtonElement>('remove-workshop-filter');
    removeWorkshop.click();
    await fixture.whenStable();

    expect(router.navigate).toHaveBeenCalledWith([], expect.objectContaining({
      queryParams: expect.objectContaining({ workshopId: null }),
    }));
  });

  it('[US4-AC9] la bitácora es de solo lectura y no ofrece acciones de edición ni borrado', async () => {
    await renderWith();

    const text = fixture.nativeElement.textContent?.toLowerCase() ?? '';
    expect(text).not.toContain('editar');
    expect(text).not.toContain('eliminar');
    expect(text).not.toContain('borrar');
    expect(text).not.toContain('nuevo registro');
    expect(fixture.nativeElement.querySelector('form button[type="submit"]')).toBeNull();
  });

  it('[US4-AC8] muestra estado vacío si no hay registros en la bitácora', async () => {
    await renderWith([], 0);

    expect(query('access-log-table')).toBeNull();
    expect(query('access-log-empty')).toBeTruthy();
  });

  it('[FR-026] controles interactivos cumplen con el tamaño táctil de al menos 44 px', async () => {
    await renderWith([ENTRY_A], 1, 1, 50, { workshopId: WORKSHOP_ID });

    expect(touchSize(get('log-agent-name'))).toBeGreaterThanOrEqual(44);
    expect(touchSize(get('log-workshop-name'))).toBeGreaterThanOrEqual(44);
    expect(touchSize(get('remove-workshop-filter'))).toBeGreaterThanOrEqual(44);
  });
});
