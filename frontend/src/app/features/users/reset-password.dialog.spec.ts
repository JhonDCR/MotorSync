import { ComponentFixture, TestBed } from '@angular/core/testing';
import { of, throwError } from 'rxjs';
import type { Problem, UserAccount } from '../../core/api/api.models';
import { UsersApiService } from '../../core/api/users-api.service';
import { ResetPasswordDialog } from './reset-password.dialog';

const USER_ID = '3fa85f64-5717-4562-b3fc-2c963f66afa6';

const MOCK_USER: UserAccount = {
  id: USER_ID,
  name: 'Carlos Mendoza',
  email: 'carlos@taller.ec',
  role: 'asesor',
  status: 'active',
  mustChangePassword: true,
  temporaryPasswordExpiresAt: '2026-10-27T12:00:00.000Z',
  createdAt: '2026-10-24T12:00:00.000Z',
  updatedAt: '2026-10-24T12:00:00.000Z',
  updatedByName: 'Admin Principal',
};

describe('ResetPasswordDialog (T060)', () => {
  let fixture: ComponentFixture<ResetPasswordDialog>;
  let component: ResetPasswordDialog;
  let usersApiMock: { resetPassword: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    usersApiMock = {
      resetPassword: vi.fn().mockReturnValue(of(MOCK_USER)),
    };

    await TestBed.configureTestingModule({
      imports: [ResetPasswordDialog],
      providers: [{ provide: UsersApiService, useValue: usersApiMock }],
    }).compileComponents();

    fixture = TestBed.createComponent(ResetPasswordDialog);
    component = fixture.componentInstance;
    fixture.componentRef.setInput('userId', USER_ID);
    fixture.componentRef.setInput('userName', 'Carlos Mendoza');
    fixture.detectChanges();
  });

  function root(): HTMLElement {
    return fixture.nativeElement as HTMLElement;
  }

  it('[US4-AC21] muestra la advertencia de que todas las sesiones se cerrarán', () => {
    const warning = root().querySelector('[data-testid="reset-warning"]');
    expect(warning?.textContent).toContain('se cerrarán todas las sesiones abiertas');
    expect(warning?.textContent).toContain('72 horas');
  });

  it('[US4-AC21][FR-005] valida que la contraseña temporal es obligatoria y tenga al menos 8 caracteres', () => {
    const submitBtn = root().querySelector('[data-testid="confirm-reset-button"]') as HTMLButtonElement;

    // Submit empty
    submitBtn.click();
    fixture.detectChanges();

    expect(usersApiMock.resetPassword).not.toHaveBeenCalled();
    expect(root().querySelector('[data-testid="password-required-error"]')).not.toBeNull();

    // Type 5 chars
    const input = root().querySelector('[data-testid="temporary-password-input"]') as HTMLInputElement;
    input.value = '12345';
    input.dispatchEvent(new Event('input'));
    fixture.detectChanges();

    submitBtn.click();
    fixture.detectChanges();

    expect(usersApiMock.resetPassword).not.toHaveBeenCalled();
    expect(root().querySelector('[data-testid="password-length-error"]')).not.toBeNull();
  });

  function submitPassword(value: string): void {
    const input = root().querySelector('[data-testid="temporary-password-input"]') as HTMLInputElement;
    input.value = value;
    input.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    (root().querySelector('[data-testid="confirm-reset-button"]') as HTMLButtonElement).click();
    fixture.detectChanges();
  }

  it('[US4-AC21][FR-005] 4 emojis (4 caracteres Unicode) → error de mínimo y no envía', () => {
    submitPassword('😀'.repeat(4));

    expect(root().querySelector('[data-testid="password-length-error"]')).not.toBeNull();
    expect(usersApiMock.resetPassword).not.toHaveBeenCalled();
  });

  it('[US4-AC21][FR-005] 8 emojis (8 caracteres Unicode) → válido y se envía', () => {
    const password = '😀'.repeat(8);
    submitPassword(password);

    expect(root().querySelector('[data-testid="password-length-error"]')).toBeNull();
    expect(root().querySelector('[data-testid="password-max-length-error"]')).toBeNull();
    expect(usersApiMock.resetPassword).toHaveBeenCalledWith(USER_ID, password);
  });

  it('[US4-AC21][FR-005] 128 emojis (128 caracteres Unicode, 256 unidades UTF-16) → válido y se envía', () => {
    const password = '😀'.repeat(128);
    submitPassword(password);

    expect(root().querySelector('[data-testid="password-max-length-error"]')).toBeNull();
    expect(usersApiMock.resetPassword).toHaveBeenCalledWith(USER_ID, password);
  });

  it('[US4-AC21][FR-005] 129 emojis (129 caracteres Unicode) → error de máximo y no envía', () => {
    submitPassword('😀'.repeat(129));

    expect(root().querySelector('[data-testid="password-max-length-error"]')).not.toBeNull();
    expect(usersApiMock.resetPassword).not.toHaveBeenCalled();
  });

  it('[US4-AC21] envía contraseña válida y emite success', () => {
    let successUser: UserAccount | undefined;
    component.success.subscribe((u) => (successUser = u));

    const input = root().querySelector('[data-testid="temporary-password-input"]') as HTMLInputElement;
    input.value = 'NewPassword123';
    input.dispatchEvent(new Event('input'));
    fixture.detectChanges();

    const submitBtn = root().querySelector('[data-testid="confirm-reset-button"]') as HTMLButtonElement;
    submitBtn.click();
    fixture.detectChanges();

    expect(usersApiMock.resetPassword).toHaveBeenCalledWith(USER_ID, 'NewPassword123');
    expect(successUser).toEqual(MOCK_USER);
  });

  it('[US4-AC23] muestra mensaje de error si falla la llamada', () => {
    const prob: Problem = {
      type: 'about:blank',
      title: 'Error',
      status: 409,
      code: 'SELF_RESET_NOT_ALLOWED',
    };
    usersApiMock.resetPassword.mockReturnValue(throwError(() => prob));

    const input = root().querySelector('[data-testid="temporary-password-input"]') as HTMLInputElement;
    input.value = 'NewPassword123';
    input.dispatchEvent(new Event('input'));
    fixture.detectChanges();

    const submitBtn = root().querySelector('[data-testid="confirm-reset-button"]') as HTMLButtonElement;
    submitBtn.click();
    fixture.detectChanges();

    const errorBox = root().querySelector('[data-testid="reset-error"]');
    expect(errorBox).not.toBeNull();
    expect(errorBox?.textContent).toContain('Para su propia cuenta use Cambiar mi contraseña');
  });

  it('[FR-028] emite closed al pulsar Cancelar', () => {
    let closed = false;
    component.closed.subscribe(() => (closed = true));

    const cancelBtn = root().querySelector('[data-testid="cancel-reset-button"]') as HTMLButtonElement;
    cancelBtn.click();

    expect(closed).toBe(true);
  });

  it('[FR-028] emite closed al presionar la tecla Escape', () => {
    let closed = false;
    component.closed.subscribe(() => (closed = true));

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    fixture.detectChanges();

    expect(closed).toBe(true);
  });
});
