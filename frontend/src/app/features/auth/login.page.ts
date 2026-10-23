import { ChangeDetectionStrategy, Component, computed, DestroyRef, inject, signal } from '@angular/core';
import { takeUntilDestroyed, toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import type { LoginRequest, SessionResponse } from '../../core/api/api.models';
import { AuthApiService } from '../../core/api/auth-api.service';
import { fieldErrorMessage, fieldErrorMessages, isProblem, problemMessage } from '../../core/api/problem';
import { SessionStore } from '../../core/auth/session.store';
import { normalizeEmail } from '../../shared/identifiers/email';
import { NETWORK_ERROR_MESSAGE } from './auth-form';

/** Contract field names of LoginRequest. */
export type LoginField = keyof LoginRequest;

const LOGIN_FIELDS: readonly LoginField[] = ['email', 'password'];
const REQUIRED_MESSAGE = fieldErrorMessage({ field: '', code: 'REQUIRED', message: '' });
const CHANGE_PASSWORD_URL = '/change-password';

/** Why the user arrived at /login (query `reason`). Unknown values show nothing; the query is never rendered. */
const REASON_MESSAGES: Readonly<Record<string, string>> = {
  expired: 'Su sesión expiró por inactividad',
  revoked: 'Su sesión fue cerrada. Vuelva a iniciar sesión',
  logout: 'Cerró su sesión',
  'temporary-expired': 'Su contraseña temporal venció. Pida al administrador de su taller que la restablezca',
};

function reasonMessage(reason: string | null): string | null {
  return reason !== null && Object.prototype.hasOwnProperty.call(REASON_MESSAGES, reason) ? REASON_MESSAGES[reason] : null;
}

/** Only internal paths are followed after signing in (no open redirect, FR-010). */
function internalReturnUrl(value: string | null): string | null {
  // A backslash is read as "/" by browsers ("/\evil.example" would leave the site), so it is rejected too.
  if (value === null || !value.startsWith('/') || value.startsWith('//') || value.includes('://') || value.includes('\\')) {
    return null;
  }
  return value;
}

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
  private readonly session = inject(SessionStore);
  private readonly destroyRef = inject(DestroyRef);
  private readonly queryParams = toSignal(inject(ActivatedRoute).queryParamMap);

  /** Message for the `reason` query (US3-AC2, US3-AC3, US3-AC4, US5-AC9). */
  protected readonly reason = computed(() => reasonMessage(this.queryParams()?.get('reason') ?? null));

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
    this.session.setSession(session);
    this.submitting.set(false);
    const returnUrl = internalReturnUrl(this.queryParams()?.get('returnUrl') ?? null);
    void this.router.navigateByUrl(session.user.mustChangePassword ? CHANGE_PASSWORD_URL : (returnUrl ?? '/'));
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
