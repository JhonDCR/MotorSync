import { ChangeDetectionStrategy, Component, DestroyRef, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Router, RouterLink } from '@angular/router';
import type { RegisterRequest, SessionResponse } from '../../core/api/api.models';
import { AuthApiService } from '../../core/api/auth-api.service';
import { fieldErrorMessage, fieldErrorMessages, isProblem, problemMessage } from '../../core/api/problem';
import { SessionStore } from '../../core/auth/session.store';
import { isValidRuc } from '../../shared/identifiers/ec-document';
import { isValidEmail, normalizeEmail } from '../../shared/identifiers/email';
import { normalizeDocument } from '../../shared/identifiers/normalize';
import { NETWORK_ERROR_MESSAGE, PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH, unicodeLength } from './auth-form';

/** Contract field names of RegisterRequest. */
export type RegisterField = keyof RegisterRequest;

const REGISTER_FIELDS: readonly RegisterField[] = ['workshopName', 'ruc', 'name', 'email', 'password'];
const NAME_MIN_LENGTH = 2;
const NAME_MAX_LENGTH = 120;
const NAME_LENGTH_MESSAGE = `Escriba entre ${NAME_MIN_LENGTH} y ${NAME_MAX_LENGTH} caracteres`;

function message(code: string): string {
  return fieldErrorMessage({ field: '', code, message: '' });
}

function isRegisterField(field: string): field is RegisterField {
  return (REGISTER_FIELDS as readonly string[]).includes(field);
}

function nameError(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed === '') return message('REQUIRED');
  if (trimmed.length < NAME_MIN_LENGTH || trimmed.length > NAME_MAX_LENGTH) return NAME_LENGTH_MESSAGE;
  return null;
}

/**
 * Public registration of a workshop and its first administrator (US1). On success the access token is stored
 * and the user goes to the start screen already signed in.
 */
@Component({
  selector: 'app-register-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink],
  templateUrl: './register.page.html',
  styleUrl: './register.page.scss',
})
export class RegisterPage {
  private readonly api = inject(AuthApiService);
  private readonly router = inject(Router);
  private readonly session = inject(SessionStore);
  private readonly destroyRef = inject(DestroyRef);

  /** Typed values. The password is kept only here and never rendered back (FR-006). */
  private readonly values: Record<RegisterField, string> = {
    workshopName: '',
    ruc: '',
    name: '',
    email: '',
    password: '',
  };

  protected readonly errors = signal<Partial<Record<RegisterField, string>>>({});
  protected readonly formError = signal<string | null>(null);
  protected readonly submitting = signal(false);
  protected readonly passwordMinLength = PASSWORD_MIN_LENGTH;

  protected update(field: RegisterField, event: Event): void {
    this.values[field] = (event.target as HTMLInputElement).value;
    // Editing a field clears its message; the rest stay until the next submit.
    if (this.errors()[field] !== undefined) {
      this.errors.update((current) => {
        const next = { ...current };
        delete next[field];
        return next;
      });
    }
  }

  protected submit(event: Event): void {
    event.preventDefault();
    if (this.submitting()) return;
    this.formError.set(null);

    const errors = this.validate();
    this.errors.set(errors);
    if (Object.keys(errors).length > 0) return;

    this.submitting.set(true);
    this.api
      .register(this.body())
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (session) => this.signedIn(session),
        error: (error: unknown) => this.failed(error),
      });
  }

  private validate(): Partial<Record<RegisterField, string>> {
    const errors: Partial<Record<RegisterField, string>> = {};
    const { workshopName, ruc, name, email, password } = this.values;

    const workshopNameError = nameError(workshopName);
    if (workshopNameError !== null) errors.workshopName = workshopNameError;

    if (ruc.trim() === '') errors.ruc = message('REQUIRED');
    else if (!isValidRuc(normalizeDocument(ruc))) errors.ruc = message('INVALID_RUC');

    const ownNameError = nameError(name);
    if (ownNameError !== null) errors.name = ownNameError;

    if (email.trim() === '') errors.email = message('REQUIRED');
    else if (!isValidEmail(normalizeEmail(email))) errors.email = message('INVALID_EMAIL');

    // The password is never trimmed and its length counts Unicode characters (FR-005).
    const length = unicodeLength(password);
    if (password === '') errors.password = message('REQUIRED');
    else if (length < PASSWORD_MIN_LENGTH) errors.password = message('PASSWORD_TOO_SHORT');
    else if (length > PASSWORD_MAX_LENGTH) errors.password = message('PASSWORD_TOO_LONG');

    return errors;
  }

  /** Exactly the RegisterRequest fields: never tenantId or role (US1-AC9). */
  private body(): RegisterRequest {
    return {
      workshopName: this.values.workshopName.trim(),
      ruc: normalizeDocument(this.values.ruc),
      name: this.values.name.trim(),
      email: normalizeEmail(this.values.email),
      password: this.values.password,
    };
  }

  private signedIn(session: SessionResponse): void {
    this.session.setSession(session);
    this.submitting.set(false);
    void this.router.navigateByUrl('/');
  }

  private failed(error: unknown): void {
    this.submitting.set(false);
    if (!isProblem(error)) {
      this.formError.set(NETWORK_ERROR_MESSAGE);
      return;
    }
    if (error.code === 'RUC_ALREADY_REGISTERED') {
      this.errors.set({ ruc: problemMessage(error) });
      return;
    }
    if (error.code === 'VALIDATION_ERROR') {
      const fieldErrors: Partial<Record<RegisterField, string>> = {};
      for (const [field, text] of Object.entries(fieldErrorMessages(error))) {
        if (isRegisterField(field)) fieldErrors[field] = text;
      }
      this.errors.set(fieldErrors);
      if (Object.keys(fieldErrors).length > 0) return;
    }
    // REGISTRATION_FAILED and anything else: a general message that never points at the email (US1-AC5).
    this.formError.set(problemMessage(error));
  }
}
