// Revisión del PR3 (002, US4-AC21, FR-025, FR-028): accesibilidad del diálogo "Restablecer contraseña".
//
// Contrato para el implementer-frontend (reset-password.dialog.ts/.html):
//   - Al abrir, el foco va al campo de la temporal (data-testid="temporary-password-input").
//   - Mientras está abierto, Tab en el último elemento enfocable del [role="dialog"] lleva al primero y Shift+Tab
//     en el primero lleva al último (foco atrapado; keydown con preventDefault).
//   - Cada error del campo (obligatoria, menos de 8, más de 128) es un elemento con id cuyo id está en el
//     aria-describedby del input; con más de 128 caracteres se muestra un mensaje visible que menciona "128" y no
//     se envía la petición.
//   - La advertencia (data-testid="reset-warning") es contenido estático del diálogo: NO lleva role="alert" (puede
//     enlazarse con aria-describedby del diálogo).
//   - Devolver el foco al botón que lo abrió se prueba en user-detail.page.a11y.spec.ts.
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ResetPasswordDialog } from './reset-password.dialog';

const USER_ID = '3fa85f64-5717-4562-b3fc-2c963f66afa6';
const RESET_URL = `/api/v1/users/${USER_ID}/password-reset`;
const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

describe('ResetPasswordDialog: accesibilidad (revisión PR3)', () => {
  let fixture: ComponentFixture<ResetPasswordDialog>;
  let httpMock: HttpTestingController;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [ResetPasswordDialog],
      providers: [provideHttpClient(), provideHttpClientTesting()],
    }).compileComponents();
    httpMock = TestBed.inject(HttpTestingController);

    fixture = TestBed.createComponent(ResetPasswordDialog);
    fixture.componentRef.setInput('userId', USER_ID);
    fixture.componentRef.setInput('userName', 'Carlos Mendoza');
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  });

  afterEach(() => {
    httpMock.verify();
  });

  function root(): HTMLElement {
    return fixture.nativeElement as HTMLElement;
  }

  function dialog(): HTMLElement {
    const element = root().querySelector<HTMLElement>('[role="dialog"]');
    if (element === null) throw new Error('No existe [role="dialog"]');
    return element;
  }

  function input(): HTMLInputElement {
    return root().querySelector<HTMLInputElement>('[data-testid="temporary-password-input"]') as HTMLInputElement;
  }

  function focusables(): HTMLElement[] {
    return Array.from(dialog().querySelectorAll<HTMLElement>(FOCUSABLE));
  }

  function type(value: string): void {
    input().value = value;
    input().dispatchEvent(new Event('input'));
    fixture.detectChanges();
  }

  function submit(): void {
    (root().querySelector('[data-testid="confirm-reset-button"]') as HTMLButtonElement).click();
    fixture.detectChanges();
  }

  /** Elementos referenciados por el aria-describedby del campo. */
  function describedBy(): HTMLElement[] {
    const ids = (input().getAttribute('aria-describedby') ?? '').split(/\s+/).filter((id) => id !== '');
    return ids
      .map((id) => document.getElementById(id))
      .filter((element): element is HTMLElement => element !== null && root().contains(element));
  }

  function press(target: HTMLElement, shiftKey: boolean): KeyboardEvent {
    const event = new KeyboardEvent('keydown', { key: 'Tab', shiftKey, bubbles: true, cancelable: true });
    target.dispatchEvent(event);
    fixture.detectChanges();
    return event;
  }

  it('[US4-AC21][FR-025] al abrir, el foco está en el campo de la contraseña temporal', async () => {
    await vi.waitFor(() => expect(document.activeElement).toBe(input()));
  });

  it('[FR-025] Tab en el último elemento enfocable vuelve al primero (foco atrapado)', () => {
    const items = focusables();
    expect(items.length).toBeGreaterThan(1);
    const last = items[items.length - 1];
    last.focus();

    const event = press(last, false);

    expect(event.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(focusables()[0]);
  });

  it('[FR-025] Shift+Tab en el primer elemento enfocable va al último (foco atrapado)', () => {
    const items = focusables();
    const first = items[0];
    first.focus();

    const event = press(first, true);

    expect(event.defaultPrevented).toBe(true);
    const after = focusables();
    expect(document.activeElement).toBe(after[after.length - 1]);
  });

  it('[US4-AC21][FR-025] el error de campo obligatorio está enlazado con aria-describedby', () => {
    submit();

    expect(input().getAttribute('aria-invalid')).toBe('true');
    const texts = describedBy().map((element) => element.textContent ?? '');
    expect(texts.some((text) => text.includes('obligatoria'))).toBe(true);
  });

  it('[US4-AC21][FR-005] el error de menos de 8 caracteres está enlazado con aria-describedby', () => {
    type('12345');
    submit();

    const texts = describedBy().map((element) => element.textContent ?? '');
    expect(texts.some((text) => text.includes('8'))).toBe(true);
  });

  it('[US4-AC21][FR-005] con más de 128 caracteres muestra un mensaje visible y no envía', () => {
    type('x'.repeat(129));
    submit();

    httpMock.expectNone(RESET_URL);
    expect(input().getAttribute('aria-invalid')).toBe('true');
    const messages = describedBy().filter((element) => (element.textContent ?? '').includes('128'));
    expect(messages).toHaveLength(1);
    expect(messages[0].hidden).toBe(false);
  });

  it('[US4-AC21] con exactamente 128 caracteres sí envía', () => {
    type('x'.repeat(128));
    submit();

    const req = httpMock.expectOne(RESET_URL);
    expect(req.request.body).toEqual({ temporaryPassword: 'x'.repeat(128) });
    req.flush({});
  });

  it('[US4-AC21][FR-025] la advertencia de cierre de sesiones no usa role="alert" permanente', () => {
    const warning = root().querySelector<HTMLElement>('[data-testid="reset-warning"]');
    expect(warning).not.toBeNull();
    expect(warning?.getAttribute('role')).not.toBe('alert');
    expect(warning?.getAttribute('aria-live')).not.toBe('assertive');
    expect(warning?.closest('[role="alert"]')).toBeNull();
  });
});
