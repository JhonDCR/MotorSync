import { ChangeDetectionStrategy, Component, DestroyRef, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Router, RouterLink } from '@angular/router';
import type { LoginRequest, SessionResponse } from '../../core/api/api.models';
import { AuthApiService } from '../../core/api/auth-api.service';
import { fieldErrorMessage, fieldErrorMessages, isProblem, problemMessage } from '../../core/api/problem';
import { AUTH_TOKEN_STORAGE_KEY } from '../../core/auth/auth-token.interceptor';
import { normalizeEmail } from '../../shared/identifiers/email';
import { NETWORK_ERROR_MESSAGE } from './auth-form';

/** Contract field names of LoginRequest. */
export type LoginField = keyof LoginRequest;

const LOGIN_FIELDS: readonly LoginField[] = ['email', 'password'];
const REQUIRED_MESSAGE = fieldErrorMessage({ field: '', code: 'REQUIRED', message: '' });
const CHANGE_PASSWORD_URL = '/change-password';

function isLoginField(field: string): field is LoginField {
  return (LOGIN_FIELDS as readonly string[]).includes(field);
}

/**
 * Public sign-in with email and password (US2). The workshop and role come from the account, never from the
 * form (US2-AC10). Credential errors use one general message that does not reveal whether the email exists.
 */
@Component({
  selector: 'app-login-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink],
  templateUrl: './login.page.html',
  styleUrl: './login.page.scss',
})
export class LoginPage {
  private readonly api = inject(AuthApiService);
  private readonly router = inject(Router);
  private readonly destroyRef = inject(DestroyRef);

  /** Typed values. The password is kept only here and never rendered back (FR-006). */
  private readonly values: Record<LoginField, string> = { email: '', password: '' };

  protected readonly errors = signal<Partial<Record<LoginField, string>>>({});
  protected readonly formError = signal<string | null>(null);
  protected readonly submitting = signal(false);

  protected update(field: LoginField, event: Event): void {
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

    const errors: Partial<Record<LoginField, string>> = {};
    if (this.values.email.trim() === '') errors.email = REQUIRED_MESSAGE;
    // The password is never trimmed: only an empty one is missing (FR-005).
    if (this.values.password === '') errors.password = REQUIRED_MESSAGE;
    this.errors.set(errors);
    if (Object.keys(errors).length > 0) return;

    this.submitting.set(true);
    const body: LoginRequest = { email: normalizeEmail(this.values.email), password: this.values.password };
    this.api
      .login(body)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (session) => this.signedIn(session),
        error: (error: unknown) => this.failed(error),
      });
  }

  private signedIn(session: SessionResponse): void {
    localStorage.setItem(AUTH_TOKEN_STORAGE_KEY, session.accessToken);
    this.submitting.set(false);
    void this.router.navigateByUrl(session.user.mustChangePassword ? CHANGE_PASSWORD_URL : '/');
  }

  private failed(error: unknown): void {
    this.submitting.set(false);
    if (!isProblem(error)) {
      this.formError.set(NETWORK_ERROR_MESSAGE);
      return;
    }
    if (error.code === 'VALIDATION_ERROR') {
      const fieldErrors: Partial<Record<LoginField, string>> = {};
      for (const [field, text] of Object.entries(fieldErrorMessages(error))) {
        if (isLoginField(field)) fieldErrors[field] = text;
      }
      this.errors.set(fieldErrors);
      if (Object.keys(fieldErrors).length > 0) return;
    }
    // INVALID_CREDENTIALS, ACCOUNT_LOCKED, TEMPORARY_PASSWORD_EXPIRED…: the message comes from the code only,
    // never from detail or title, so every credential failure reads the same (US2-AC3).
    this.formError.set(problemMessage(error));
  }
}
