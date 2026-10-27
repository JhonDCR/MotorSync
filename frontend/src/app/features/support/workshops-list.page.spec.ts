// T066 (003, PR3, US4): lista y búsqueda de talleres (/support/workshops).
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { of, throwError } from 'rxjs';
import { touchSize } from '../../../testing/auth-fixtures';
import {
  OTHER_WORKSHOP_ID,
  supportProblem,
  WORKSHOP_ID,
  workshopSummaryFixture,
  type WorkshopSummaryFixture,
} from '../../../testing/support-fixtures';
import { SupportApiService } from '../../core/api/support-api.service';
import { WorkshopsListPage } from './workshops-list.page';

const WORKSHOP_A: WorkshopSummaryFixture = workshopSummaryFixture({
  id: WORKSHOP_ID,
  name: 'Taller Andrade',
  ruc: '1790012345001',
  createdAt: '2026-10-25T02:15:00.000Z', // 24/10/2026 21:15 en America/Guayaquil
});

const WORKSHOP_B: WorkshopSummaryFixture = workshopSummaryFixture({
  id: OTHER_WORKSHOP_ID,
  name: 'Taller Benítez',
  ruc: null,
  createdAt: '2026-10-25T16:30:00.000Z', // 25/10/2026 11:30 en America/Guayaquil
});

describe('WorkshopsListPage (T066)', () => {
  let fixture: ComponentFixture<WorkshopsListPage>;
  let api: { listWorkshops: ReturnType<typeof vi.fn<SupportApiService['listWorkshops']>> };

  async function renderWith(
    items: WorkshopSummaryFixture[] = [WORKSHOP_A, WORKSHOP_B],
    total = items.length,
    page = 1,
    pageSize = 50,
    error?: unknown,
  ): Promise<void> {
    api = {
      listWorkshops: vi.fn<SupportApiService['listWorkshops']>(() =>
        error !== undefined ? throwError(() => error) : of({ items, total, page, pageSize }),
      ),
    };
    await TestBed.configureTestingModule({
      imports: [WorkshopsListPage],
      providers: [provideRouter([]), { provide: SupportApiService, useValue: api }],
    }).compileComponents();
    fixture = TestBed.createComponent(WorkshopsListPage);
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

  it('[US4-AC1] muestra la lista de talleres con nombre, RUC y fecha de alta en hora de Ecuador', async () => {
    await renderWith();

    expect(query('workshops-table')).toBeTruthy();
    const rows = getAll('workshop-row');
    expect(rows).toHaveLength(2);

    const first = rows[0];
    expect(first.querySelector('[data-testid="workshop-name"]')?.textContent?.trim()).toBe('Taller Andrade');
    expect(first.querySelector('[data-testid="workshop-ruc"]')?.textContent?.trim()).toBe('1790012345001');
    expect(first.querySelector('[data-testid="workshop-created-at"]')?.textContent?.trim()).toBe('24/10/2026 21:15');

    const link = first.querySelector<HTMLAnchorElement>('[data-testid="workshop-accounts-link"]');
    expect(link?.getAttribute('href')).toBe(`/support/workshops/${WORKSHOP_ID}`);

    const second = rows[1];
    expect(second.querySelector('[data-testid="workshop-name"]')?.textContent?.trim()).toBe('Taller Benítez');
    expect(second.querySelector('[data-testid="workshop-ruc"]')?.textContent?.trim()).toBe('—');
    expect(second.querySelector('[data-testid="workshop-created-at"]')?.textContent?.trim()).toBe('25/10/2026 11:30');
  });

  it('[US4-AC2] el buscador ejecuta listWorkshops con el término y vuelve a la página 1', async () => {
    await renderWith();

    const input = get<HTMLInputElement>('workshops-search-input');
    const button = get<HTMLButtonElement>('workshops-search-button');

    input.value = 'andrade';
    input.dispatchEvent(new Event('input'));
    button.click();
    await fixture.whenStable();

    expect(api.listWorkshops).toHaveBeenLastCalledWith('andrade', 1);
  });

  it('[US4-AC1] paginación: muestra botones y permite navegar entre páginas', async () => {
    await renderWith([WORKSHOP_A], 52, 1, 50);

    const prev = get<HTMLButtonElement>('pagination-prev');
    const next = get<HTMLButtonElement>('pagination-next');
    const info = get('pagination-info');

    expect(prev.disabled).toBe(true);
    expect(next.disabled).toBe(false);
    expect(info.textContent).toContain('1');

    next.click();
    await fixture.whenStable();

    expect(api.listWorkshops).toHaveBeenLastCalledWith(undefined, 2);
  });

  it('[US4-AC1] muestra estado vacío cuando no hay talleres', async () => {
    await renderWith([], 0);

    expect(query('workshops-table')).toBeNull();
    expect(query('workshops-empty')).toBeTruthy();
  });

  it('[US4-AC1] muestra mensaje de error si la API falla', async () => {
    await renderWith([], 0, 1, 50, supportProblem(500, 'INTERNAL_ERROR'));

    expect(query('workshops-table')).toBeNull();
    expect(query('workshops-error')).toBeTruthy();
  });

  it('[FR-026] controles interactivos cumplen con el tamaño táctil de al menos 44 px', async () => {
    await renderWith([WORKSHOP_A], 52, 1, 50);

    expect(touchSize(get('workshops-search-button'))).toBeGreaterThanOrEqual(44);
    expect(touchSize(get('workshops-search-input'))).toBeGreaterThanOrEqual(44);
    expect(touchSize(get('pagination-next'))).toBeGreaterThanOrEqual(44);
    expect(touchSize(get('workshop-accounts-link'))).toBeGreaterThanOrEqual(44);
  });
});
