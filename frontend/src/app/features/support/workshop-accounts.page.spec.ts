// T066 (003, PR3, US4): cuentas de un taller (/support/workshops/:id).
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap, provideRouter } from '@angular/router';
import { of, throwError } from 'rxjs';
import { touchSize } from '../../../testing/auth-fixtures';
import {
  supportProblem,
  WORKSHOP_ID,
  workshopAccountFixture,
  workshopAccountsResponseFixture,
  type WorkshopAccountFixture,
  type WorkshopAccountsResponseFixture,
} from '../../../testing/support-fixtures';
import { SupportApiService } from '../../core/api/support-api.service';
import { WorkshopAccountsPage } from './workshop-accounts.page';

const ADMIN_ACCOUNT: WorkshopAccountFixture = workshopAccountFixture({
  name: 'Ana Pérez',
  email: 'ana.perez@taller.ec',
  role: 'admin',
  status: 'active',
  hasOpenTicket: true,
});

const ASESOR_ACCOUNT: WorkshopAccountFixture = workshopAccountFixture({
  name: 'Luis Asesor',
  email: 'luis.asesor@taller.ec',
  role: 'asesor',
  status: 'inactive',
  hasOpenTicket: false,
});

describe('WorkshopAccountsPage (T066)', () => {
  let fixture: ComponentFixture<WorkshopAccountsPage>;
  let api: { listWorkshopAccounts: ReturnType<typeof vi.fn<SupportApiService['listWorkshopAccounts']>> };

  async function renderWith(
    response?: WorkshopAccountsResponseFixture,
    error?: unknown,
    workshopId = WORKSHOP_ID,
  ): Promise<void> {
    const data = response ?? workshopAccountsResponseFixture({
      items: [ADMIN_ACCOUNT, ASESOR_ACCOUNT],
    });
    api = {
      listWorkshopAccounts: vi.fn<SupportApiService['listWorkshopAccounts']>(() =>
        error !== undefined ? throwError(() => error) : of(data),
      ),
    };
    await TestBed.configureTestingModule({
      imports: [WorkshopAccountsPage],
      providers: [
        provideRouter([]),
        { provide: SupportApiService, useValue: api },
        {
          provide: ActivatedRoute,
          useValue: {
            snapshot: { paramMap: convertToParamMap({ id: workshopId }) },
            paramMap: of(convertToParamMap({ id: workshopId })),
          },
        },
      ],
    }).compileComponents();
    fixture = TestBed.createComponent(WorkshopAccountsPage);
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

  it('[US4-AC3] muestra cabecera del taller y lista las cuentas con rol, estado y badge de ticket abierto', async () => {
    await renderWith();

    expect(get('workshop-name').textContent?.trim()).toBe('Taller Andrade');
    expect(get('workshop-ruc').textContent?.trim()).toBe('1790012345001');

    const logLink = get<HTMLAnchorElement>('workshop-access-log-link');
    expect(logLink.getAttribute('href')).toContain('/support/access-log');
    expect(logLink.search).toContain(`workshopId=${WORKSHOP_ID}`);

    const rows = getAll('account-row');
    expect(rows).toHaveLength(2);

    const first = rows[0];
    expect(first.querySelector('[data-testid="account-name"]')?.textContent?.trim()).toBe('Ana Pérez');
    expect(first.querySelector('[data-testid="account-email"]')?.textContent?.trim()).toBe('ana.perez@taller.ec');
    expect(first.querySelector('[data-testid="account-role"]')?.textContent?.trim()).toBe('Administrador');
    expect(first.querySelector('[data-testid="account-status"]')?.textContent?.trim()).toBe('Activo');
    expect(first.querySelector('[data-testid="account-open-ticket"]')).toBeTruthy();

    const second = rows[1];
    expect(second.querySelector('[data-testid="account-name"]')?.textContent?.trim()).toBe('Luis Asesor');
    expect(second.querySelector('[data-testid="account-email"]')?.textContent?.trim()).toBe('luis.asesor@taller.ec');
    expect(second.querySelector('[data-testid="account-role"]')?.textContent?.trim()).toBe('Asesor');
    expect(second.querySelector('[data-testid="account-status"]')?.textContent?.trim()).toBe('Inactivo');
    expect(second.querySelector('[data-testid="account-open-ticket"]')).toBeNull();
  });

  it('[US4-AC7] muestra mensaje de taller no encontrado ante 404 NOT_FOUND', async () => {
    await renderWith(undefined, supportProblem(404, 'NOT_FOUND'));

    expect(query('accounts-table')).toBeNull();
    expect(query('accounts-not-found')).toBeTruthy();
  });

  it('[US4-AC3] muestra estado vacío si el taller no tiene cuentas registradas', async () => {
    const emptyResponse = workshopAccountsResponseFixture({ items: [] });
    await renderWith(emptyResponse);

    expect(query('accounts-table')).toBeNull();
    expect(query('accounts-empty')).toBeTruthy();
  });

  it('[FR-026] controles interactivos cumplen con el tamaño táctil de al menos 44 px', async () => {
    await renderWith();

    expect(touchSize(get('workshop-access-log-link'))).toBeGreaterThanOrEqual(44);
    expect(touchSize(get('back-to-workshops'))).toBeGreaterThanOrEqual(44);
  });
});
