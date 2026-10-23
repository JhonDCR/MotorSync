// Shell de MotorSync (cierre del PR1) y pantalla inicial del asesor (PR2, FR-026 y T056).
// Cambios de prueba aprobados por el leader (constitución, principio II):
//   - PR1: la versión anterior exigía "Hello, frontend" de la plantilla; se exige la shell de MotorSync.
//   - PR2: la raíz "" ya no redirige a /clients; es la búsqueda de vehículos por placa (FR-026: accesible desde la
//     pantalla inicial en un solo toque). La navegación suma el enlace "Vehículos".
//
// Contrato para el implementer (app.ts / app.html / app.routes.ts):
//   <header> con <h1>MotorSync</h1>.
//   <nav aria-label="Principal"> con tres enlaces routerLink, en este orden:
//     "Vehículos"         -> /             (routerLinkActive con [routerLinkActiveOptions]="{ exact: true }",
//                                           si no, queda activo en todas las rutas)
//     "Clientes"          -> /clients      (también con { exact: true }, si no, queda activo en /clients/new)
//     "Registrar cliente" -> /clients/new
//   Los tres con ariaCurrentWhenActive="page" (solo el enlace activo lleva aria-current="page").
//   <router-outlet /> para las páginas.
//   app.routes.ts: { path: '', pathMatch: 'full', loadComponent: VehicleSearchPage } (sin redirectTo).
import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { of } from 'rxjs';
import { App } from './app';
import { routes } from './app.routes';
import { ClientsApiService } from './core/api/clients-api.service';
import { VehiclesApiService } from './core/api/vehicles-api.service';
import { SessionStore } from './core/auth/session.store';
import { VehicleSearchPage } from './features/vehicles/vehicle-search.page';
import { sessionResponse } from '../testing/auth-fixtures';

@Component({ template: '' })
class StubPage {}

function navLinks(root: HTMLElement): HTMLAnchorElement[] {
  return Array.from(root.querySelectorAll<HTMLAnchorElement>('nav[aria-label="Principal"] a'));
}

function linkByText(root: HTMLElement, text: string): HTMLAnchorElement | undefined {
  return navLinks(root).find((a) => a.textContent?.trim() === text);
}

describe('App (shell)', () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [App],
      providers: [
        provideRouter([
          { path: '', pathMatch: 'full', component: StubPage },
          { path: 'clients', component: StubPage },
          { path: 'clients/new', component: StubPage },
        ]),
      ],
    }).compileComponents();
  });

  it('[shell] se crea la app', () => {
    const fixture = TestBed.createComponent(App);
    expect(fixture.componentInstance).toBeTruthy();
  });

  it('[shell] el encabezado muestra el h1 "MotorSync"', async () => {
    const fixture = TestBed.createComponent(App);
    await fixture.whenStable();
    const root = fixture.nativeElement as HTMLElement;
    const h1 = root.querySelector('header h1');
    expect(h1?.textContent?.trim()).toBe('MotorSync');
  });

  it('[FR-026] la navegación principal tiene "Vehículos" (/), "Clientes" (/clients) y "Registrar cliente" (/clients/new)', async () => {
    const fixture = TestBed.createComponent(App);
    await fixture.whenStable();
    const root = fixture.nativeElement as HTMLElement;

    expect(root.querySelector('nav[aria-label="Principal"]')).not.toBeNull();
    expect(navLinks(root).map((a) => a.textContent?.trim())).toEqual(['Vehículos', 'Clientes', 'Registrar cliente']);
    expect(linkByText(root, 'Vehículos')?.getAttribute('href')).toBe('/');
    expect(linkByText(root, 'Clientes')?.getAttribute('href')).toBe('/clients');
    expect(linkByText(root, 'Registrar cliente')?.getAttribute('href')).toBe('/clients/new');
  });

  it('[FR-026] el enlace "Vehículos" lleva en un toque a la búsqueda por placa (/)', async () => {
    const fixture = TestBed.createComponent(App);
    const router = TestBed.inject(Router);
    await router.navigateByUrl('/clients');
    fixture.detectChanges();
    await fixture.whenStable();

    linkByText(fixture.nativeElement as HTMLElement, 'Vehículos')?.click();
    await fixture.whenStable();
    expect(router.url).toBe('/');
  });

  it('[shell] solo el enlace de la ruta activa lleva aria-current="page" ("Vehículos" con coincidencia exacta)', async () => {
    const fixture = TestBed.createComponent(App);
    const router = TestBed.inject(Router);
    const root = fixture.nativeElement as HTMLElement;

    const activeAt = async (url: string): Promise<string[]> => {
      await router.navigateByUrl(url);
      fixture.detectChanges();
      await fixture.whenStable();
      return navLinks(root)
        .filter((a) => a.getAttribute('aria-current') === 'page')
        .map((a) => a.textContent?.trim() ?? '');
    };

    expect(await activeAt('/')).toEqual(['Vehículos']);
    expect(await activeAt('/clients/new')).toEqual(['Registrar cliente']);
    expect(await activeAt('/clients')).toEqual(['Clientes']);
    expect(navLinks(root).filter((a) => a.hasAttribute('aria-current'))).toHaveLength(1);
  });

  it('[shell] incluye un <router-outlet>', async () => {
    const fixture = TestBed.createComponent(App);
    await fixture.whenStable();
    const root = fixture.nativeElement as HTMLElement;
    expect(root.querySelector('router-outlet')).not.toBeNull();
  });
});

describe('Rutas raíz en app.routes (shell)', () => {
  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        provideRouter(routes),
        {
          provide: ClientsApiService,
          useValue: {
            create: vi.fn(),
            getById: vi.fn(),
            search: vi.fn(() => of({ items: [], hasMore: false })),
          },
        },
        {
          provide: VehiclesApiService,
          useValue: {
            create: vi.fn(),
            getById: vi.fn(),
            search: vi.fn(() => of({ items: [], hasMore: false })),
          },
        },
      ],
    });
    // 002 (PR2, T045): las rutas del taller exigen sesión (authGuard); sin ella irían a /login.
    TestBed.inject(SessionStore).setSession(sessionResponse());
  });

  it('[FR-026] la raíz "" muestra la búsqueda de vehículos por placa, sin redirigir', async () => {
    const harness = await RouterTestingHarness.create();
    const page = await harness.navigateByUrl('');
    expect(TestBed.inject(Router).url).toBe('/');
    expect(page).toBeInstanceOf(VehicleSearchPage);
  });
});
