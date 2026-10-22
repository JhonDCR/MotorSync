// Cierre del PR1 (001-clientes-vehiculos): la plantilla de ejemplo de Angular se reemplaza por una shell mínima.
// Cambio de prueba aprobado por el leader (constitución, principio II): la versión anterior exigía
// "Hello, frontend" de la plantilla; ahora se exige la shell de MotorSync.
//
// Contrato para el implementer (app.ts / app.html / app.routes.ts):
//   <header> con <h1>MotorSync</h1>.
//   <nav aria-label="Principal"> con dos enlaces routerLink:
//     "Clientes"          -> /clients      (routerLinkActive con [routerLinkActiveOptions]="{ exact: true }",
//                                           si no, también queda activo en /clients/new)
//     "Registrar cliente" -> /clients/new
//   Ambos con ariaCurrentWhenActive="page" (solo el enlace activo lleva aria-current="page").
//   <router-outlet /> para las páginas.
//   app.routes.ts: { path: '', pathMatch: 'full', redirectTo: 'clients' }.
import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { of } from 'rxjs';
import { App } from './app';
import { routes } from './app.routes';
import { ClientsApiService } from './core/api/clients-api.service';
import { ClientSearchPage } from './features/clients/client-search.page';

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

  it('[shell] la navegación principal enlaza a /clients y /clients/new', async () => {
    const fixture = TestBed.createComponent(App);
    await fixture.whenStable();
    const root = fixture.nativeElement as HTMLElement;

    expect(root.querySelector('nav[aria-label="Principal"]')).not.toBeNull();
    const clients = linkByText(root, 'Clientes');
    const newClient = linkByText(root, 'Registrar cliente');
    expect(clients?.getAttribute('href')).toBe('/clients');
    expect(newClient?.getAttribute('href')).toBe('/clients/new');
  });

  it('[shell] solo el enlace de la ruta activa lleva aria-current="page"', async () => {
    const fixture = TestBed.createComponent(App);
    const router = TestBed.inject(Router);
    const root = fixture.nativeElement as HTMLElement;

    await router.navigateByUrl('/clients/new');
    fixture.detectChanges();
    await fixture.whenStable();
    expect(linkByText(root, 'Registrar cliente')?.getAttribute('aria-current')).toBe('page');
    expect(linkByText(root, 'Clientes')?.hasAttribute('aria-current')).toBe(false);

    await router.navigateByUrl('/clients');
    fixture.detectChanges();
    await fixture.whenStable();
    expect(linkByText(root, 'Clientes')?.getAttribute('aria-current')).toBe('page');
    expect(linkByText(root, 'Registrar cliente')?.hasAttribute('aria-current')).toBe(false);
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
      ],
    });
  });

  it('[shell] la raíz "" redirige a /clients (búsqueda de clientes)', async () => {
    const harness = await RouterTestingHarness.create();
    const page = await harness.navigateByUrl('');
    expect(TestBed.inject(Router).url).toBe('/clients');
    expect(page).toBeInstanceOf(ClientSearchPage);
  });
});
