import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { of, throwError } from 'rxjs';
import type { Problem, UserAccount } from '../../core/api/api.models';
import { UsersApiService } from '../../core/api/users-api.service';
import { UserFormPage } from './user-form.page';

const CREATED_USER: UserAccount = {
  id: '3fa85f64-5717-4562-b3fc-2c963f66afa6',
  name: 'Ana Pérez',
  email: 'ana.perez@taller.ec',
  role: 'asesor',
  status: 'active',
  mustChangePassword: true,
  temporaryPasswordExpiresAt: '2026-10-27T12:00:00.000Z',
  createdAt: '2026-10-24T12:00:00.000Z',
  updatedAt: '2026-10-24T12:00:00.000Z',
  updatedByName: 'Admin Demo',
};

describe('UserFormPage (T059)', () => {
  let fixture: ComponentFixture<UserFormPage>;
  let usersApiMock: { create: ReturnType<typeof vi.fn> };
  let router: Router;

  beforeEach(async () => {
    usersApiMock = {
      create: vi.fn().mockReturnValue(of(CREATED_USER)),
    };

    await TestBed.configureTestingModule({
      imports: [UserFormPage],
      providers: [
        provideRouter([]),
        { provide: UsersApiService, useValue: usersApiMock },
      ],
    }).compileComponents();

    router = TestBed.inject(Router);
    vi.spyOn(router, 'navigate').mockResolvedValue(true);

    fixture = TestBed.createComponent(UserFormPage);
    fixture.detectChanges();
  });

  function root(): HTMLElement {
    return fixture.nativeElement as HTMLElement;
  }

  function setInput(testId: string, value: string): void {
    const el = root().querySelector(`[data-testid="${testId}"]`) as HTMLInputElement | HTMLSelectElement;
    el.value = value;
    el.dispatchEvent(new Event('input'));
    el.dispatchEvent(new Event('change'));
    fixture.detectChanges();
  }

  it('muestra el aviso de contraseña temporal con vigencia de 72 horas', () => {
    const notice = root().querySelector('[data-testid="temp-password-notice"]');
    expect(notice?.textContent).toContain('contraseña asignada es temporal');
    expect(notice?.textContent).toContain('72 horas');
  });

  it('valida campos obligatorios y formatos', () => {
    const submitBtn = root().querySelector('[data-testid="submit-button"]') as HTMLButtonElement;
    submitBtn.click();
    fixture.detectChanges();

    expect(usersApiMock.create).not.toHaveBeenCalled();
    expect(root().querySelector('[data-testid="name-required-error"]')).not.toBeNull();
    expect(root().querySelector('[data-testid="email-required-error"]')).not.toBeNull();
    expect(root().querySelector('[data-testid="password-required-error"]')).not.toBeNull();

    // Fill invalid data
    setInput('name-input', 'A');
    setInput('email-input', 'invalid-email');
    setInput('temporary-password-input', '12345');

    submitBtn.click();
    fixture.detectChanges();

    expect(usersApiMock.create).not.toHaveBeenCalled();
    expect(root().querySelector('[data-testid="name-length-error"]')).not.toBeNull();
    expect(root().querySelector('[data-testid="email-format-error"]')).not.toBeNull();
    expect(root().querySelector('[data-testid="password-length-error"]')).not.toBeNull();
  });

  it('crea usuario con datos válidos y navega a /users/:id', () => {
    setInput('name-input', 'Ana Pérez');
    setInput('email-input', 'ana.perez@taller.ec');
    setInput('role-select', 'asesor');
    setInput('temporary-password-input', 'TemporaryPass123');

    const submitBtn = root().querySelector('[data-testid="submit-button"]') as HTMLButtonElement;
    submitBtn.click();
    fixture.detectChanges();

    expect(usersApiMock.create).toHaveBeenCalledWith({
      name: 'Ana Pérez',
      email: 'ana.perez@taller.ec',
      role: 'asesor',
      temporaryPassword: 'TemporaryPass123',
    });

    expect(router.navigate).toHaveBeenCalledWith(['/users', CREATED_USER.id]);
  });

  it('muestra el mensaje especificado ante error 409 EMAIL_UNAVAILABLE', () => {
    const conflictProb: Problem = {
      type: 'about:blank',
      title: 'Error',
      status: 409,
      code: 'EMAIL_UNAVAILABLE',
    };
    usersApiMock.create.mockReturnValue(throwError(() => conflictProb));

    setInput('name-input', 'Ana Pérez');
    setInput('email-input', 'ana.perez@taller.ec');
    setInput('role-select', 'asesor');
    setInput('temporary-password-input', 'TemporaryPass123');

    const submitBtn = root().querySelector('[data-testid="submit-button"]') as HTMLButtonElement;
    submitBtn.click();
    fixture.detectChanges();

    const formError = root().querySelector('[data-testid="form-error"]');
    expect(formError).not.toBeNull();
    expect(formError?.textContent).toContain(
      'No se pudo crear la cuenta con este correo. Si la persona ya tiene una cuenta en su taller, búsquela en la lista; si no, use otro correo',
    );
  });
});
