// T053 (003, PR2, US3): diálogo que muestra la contraseña temporal generada por soporte una sola vez.
//
// Contrato para el implementer-frontend (T054), archivo features/support/temporary-password.dialog.ts (+ .html y .scss):
//   export class TemporaryPasswordDialogComponent (y alias opcional `export { TemporaryPasswordDialogComponent as TemporaryPasswordDialog }`)
//     selector: 'app-temporary-password-dialog' (standalone, ChangeDetectionStrategy.OnPush)
//   Inputs (Angular signal inputs):
//     temporaryPassword = input.required<string>()         contraseña temporal p. ej. 'ABCD-EFGH-JKMN-PQRS'
//     temporaryPasswordExpiresAt = input<string | null>(null) (opcional, vencimiento ISO UTC para mostrar si aplica)
//     accountEmail = input<string>('')                     (opcional, correo de la cuenta afectada)
//     accountName = input<string>('')                      (opcional, nombre de la cuenta afectada)
//   Outputs (Angular output()):
//     closed = output<void>()                              se emite al pulsar `temp-password-close` o presionar Escape
//   Selectores (data-testid):
//     temporary-password-dialog        contenedor con role="dialog", aria-modal="true" y aria-labelledby
//     temporary-password-value         <code> (o elemento con clase/fuente monoespaciada) que muestra
//                                      exactamente `temporaryPassword()` tal cual (con guiones y en mayúsculas)
//     temporary-password-format-notice aviso literal SUPPORT_MESSAGES.TEMPORARY_PASSWORD_FORMAT_NOTICE:
//                                      "Escríbala tal cual, con los guiones y en mayúsculas"
//     temporary-password-once-notice   aviso literal SUPPORT_MESSAGES.TEMPORARY_PASSWORD_ONCE_NOTICE:
//                                      "Esta contraseña temporal se muestra una sola vez y no se volverá a mostrar"
//     temporary-password-copy          <button type="button"> que contiene "Copiar" (min-height >= 44 px, FR-026);
//                                      al pulsarlo copia `temporaryPassword()` con `navigator.clipboard.writeText(...)`
//                                      y muestra confirmación visual (`temporary-password-copied` o texto "Copiada")
//     temporary-password-close         <button type="button"> ("Cerrar" / "Entendido", min-height >= 44 px, FR-026)
//                                      que emite `closed`
import { type OutputRef, type Type } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { touchSize } from '../../../testing/auth-fixtures';
import {
  SUPPORT_MESSAGES,
  SUPPORT_TEMP_PASSWORD,
  SUPPORT_TOKEN_STORAGE_KEY,
} from '../../../testing/support-fixtures';
import { AUTH_TOKEN_STORAGE_KEY } from '../../core/auth/auth-token.interceptor';

interface TemporaryPasswordDialogInstance {
  readonly closed: OutputRef<void>;
}

interface TemporaryPasswordDialogModule {
  TemporaryPasswordDialogComponent?: Type<TemporaryPasswordDialogInstance>;
  TemporaryPasswordDialog?: Type<TemporaryPasswordDialogInstance>;
}

const DIALOG_MODULE_PATH = './temporary-password.dialog';

async function loadDialogComponent(): Promise<Type<TemporaryPasswordDialogInstance>> {
  const mod = (await import(/* @vite-ignore */ DIALOG_MODULE_PATH)) as TemporaryPasswordDialogModule;
  const DialogType = mod.TemporaryPasswordDialogComponent ?? mod.TemporaryPasswordDialog;
  if (!DialogType) {
    throw new Error(
      'temporary-password.dialog.ts debe exportar TemporaryPasswordDialogComponent (o TemporaryPasswordDialog)',
    );
  }
  return DialogType;
}

describe('TemporaryPasswordDialogComponent (T053)', () => {
  let fixture: ComponentFixture<TemporaryPasswordDialogInstance>;
  let closedCount: number;
  let writeTextSpy: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    localStorage.clear();
    closedCount = 0;
    writeTextSpy = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: writeTextSpy },
      configurable: true,
      writable: true,
    });

    const DialogComponent = await loadDialogComponent();
    await TestBed.configureTestingModule({
      imports: [DialogComponent],
    }).compileComponents();

    fixture = TestBed.createComponent(DialogComponent);
    fixture.componentRef.setInput('temporaryPassword', SUPPORT_TEMP_PASSWORD);
    fixture.componentInstance.closed.subscribe(() => {
      closedCount += 1;
    });
    await settle();
  });

  afterEach(() => {
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

  it('[US3-AC2][FR-019] muestra la contraseña temporal en fuente monoespaciada con role="dialog" y aria-modal="true"', () => {
    const dialog = get('temporary-password-dialog');
    expect(dialog.getAttribute('role')).toBe('dialog');
    expect(dialog.getAttribute('aria-modal')).toBe('true');

    const valueEl = get('temporary-password-value');
    expect(valueEl.textContent?.trim()).toBe(SUPPORT_TEMP_PASSWORD);

    const isCodeTag = valueEl.tagName.toLowerCase() === 'code' || valueEl.querySelector('code') !== null;
    const computedFont = getComputedStyle(valueEl).fontFamily.toLowerCase();
    const hasMonospaceClass = valueEl.className.toLowerCase().includes('mono');
    expect(isCodeTag || computedFont.includes('monospace') || hasMonospaceClass).toBe(true);
  });

  it('[US3-AC2][FR-019] muestra el aviso de formato ("Escríbala tal cual, con los guiones y en mayúsculas") y el de visualización única', () => {
    expect(text('temporary-password-format-notice')).toContain(SUPPORT_MESSAGES.TEMPORARY_PASSWORD_FORMAT_NOTICE);
    expect(text('temporary-password-once-notice')).toContain(SUPPORT_MESSAGES.TEMPORARY_PASSWORD_ONCE_NOTICE);
  });

  it('[US3-AC2][FR-019][FR-026] muestra el botón "Copiar" (>= 44 px) que copia la contraseña temporal exacta al portapapeles', async () => {
    const copyBtn = get<HTMLButtonElement>('temporary-password-copy');
    expect(copyBtn.textContent).toContain('Copiar');
    expect(touchSize(copyBtn)).toBeGreaterThanOrEqual(44);

    copyBtn.click();
    await settle();

    expect(writeTextSpy).toHaveBeenCalledTimes(1);
    expect(writeTextSpy).toHaveBeenCalledWith(SUPPORT_TEMP_PASSWORD);
  });

  it('[US3-AC2][FR-026] emite closed al pulsar el botón de cerrar (>= 44 px) y no persiste la contraseña en localStorage', async () => {
    const closeBtn = get<HTMLButtonElement>('temporary-password-close');
    expect(touchSize(closeBtn)).toBeGreaterThanOrEqual(44);

    closeBtn.click();
    await settle();

    expect(closedCount).toBe(1);
    expect(localStorage.getItem(SUPPORT_TOKEN_STORAGE_KEY)).toBeNull();
    expect(localStorage.getItem(AUTH_TOKEN_STORAGE_KEY)).toBeNull();
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i);
      if (key !== null) {
        expect(localStorage.getItem(key)).not.toContain(SUPPORT_TEMP_PASSWORD);
      }
    }
  });

  it('[US3-AC2] emite closed al presionar la tecla Escape', async () => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    await settle();

    expect(closedCount).toBe(1);
  });
});
