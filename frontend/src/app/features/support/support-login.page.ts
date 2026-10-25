import { ChangeDetectionStrategy, Component, computed, DestroyRef, inject, signal } from '@angular/core';
import { takeUntilDestroyed, toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router } from '@angular/router';
import type { SupportLoginRequest, SupportSessionResponse } from '../../core/api/api.models';
import { fieldErrorMessage, fieldErrorMessages, isProblem, problemMessage } from '../../core/api/problem';
import { SupportApiService } from '../../core/api/support-api.service';
import { SUPPORT_CHANGE_PASSWORD_PATH, SUPPORT_HOME_PATH } from '../../core/support/support.guards';
import { SupportSessionStore } from '../../core/support/support-session.store';
import { normalizeEmail } from '../../shared/identifiers/email';
import { NETWORK_ERROR_MESSAGE } from '../auth/auth-form';

export type SupportLoginField = keyof SupportLoginRequest;

const LOGIN_FIELDS: readonly SupportLoginField[] = ['email', 'password'];
const REQUIRED_MESSAGE = fieldErrorMessage({ field: '', code: 'REQUIRED', message: '' });

const REASON_MESSAGES: Readonly<Record<string, string>> = {
  expired: 'Su sesión expiró por inactividad',
  revoked: 'Su sesión fue cerrada. Vuelva a iniciar sesión',
  logout: 'Cerró su sesión',
  'temporary-expired':
    'Su contraseña temporal venció. Pida al administrador de su taller que la restablezca o use ¿Olvidaste tu contraseña?',
};

function reasonMessage(reason: string | null): string | null {
  return reason !== null && Object.prototype.hasOwnProperty.call(REASON_MESSAGES, reason) ? REASON_MESSAGES[reason] : null;
}

/** Only internal /support paths are followed after signing in (no open redirect nor workshop routes). */
function internalSupportReturnUrl(value: string | null): string | null {
  if (
    value === null ||
    !(value === SUPPORT_HOME_PATH || value.startsWith(`${SUPPORT_HOME_PATH}/`) || value.startsWith(`${SUPPORT_HOME_PATH}?`)) ||
    value.startsWith('//') ||
    value.includes('://') ||
    value.includes('\\')
  ) {
    return null;
  }
  return value;
}

function isLoginField(field: string): field is SupportLoginField {
  return (LOGIN_FIELDS as readonly string[]).includes(field);
}

/**
 * Support zone sign-in with email and password (US2, FR-005). Strictly separated from the workshop login.
 */
@Component({
  selector: 'app-support-login-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './support-login.page.html',
  styleUrl: './support-login.page.scss',
})
export class SupportLoginPage {
  private readonly api = inject(SupportApiService);
  private readonly router = inject(Router);
  private readonly session = inject(SupportSessionStore);
  private readonly destroyRef = inject(DestroyRef);
  private readonly queryParams = toSignal(inject(ActivatedRoute).queryParamMap);

  protected readonly reason = computed(() => reasonMessage(this.queryParams()?.get('reason') ?? null));

  private readonly values: Record<SupportLoginField, string> = { email: '', password: '' };

  protected readonly errors = signal<Partial<Record<SupportLoginField, string>>>({});
  protected readonly formError = signal<string | null>(null);
  protected readonly submitting = signal(false);

  protected update(field: SupportLoginField, event: Event): void {
    this.values[field] = (event.target as HTMLInputElement).value;
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

    const errors: Partial<Record<SupportLoginField, string>> = {};
    if (this.values.email.trim() === '') errors.email = REQUIRED_MESSAGE;
    if (this.values.password === '') errors.password = REQUIRED_MESSAGE;
    this.errors.set(errors);
    if (Object.keys(errors).length > 0) return;

    this.submitting.set(true);
    const body: SupportLoginRequest = { email: normalizeEmail(this.values.email), password: this.values.password };
    this.api
      .login(body)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (session) => this.signedIn(session),
        error: (error: unknown) => this.failed(error),
      });
  }

  private signedIn(session: SupportSessionResponse): void {
    this.session.setSession(session);
    this.submitting.set(false);
    const returnUrl = internalSupportReturnUrl(this.queryParams()?.get('returnUrl') ?? null);
    void this.router.navigateByUrl(
      session.agent.mustChangePassword ? SUPPORT_CHANGE_PASSWORD_PATH : (returnUrl ?? SUPPORT_HOME_PATH),
    );
  }

  private failed(error: unknown): void {
    this.submitting.set(false);
    if (!isProblem(error)) {
      this.formError.set(NETWORK_ERROR_MESSAGE);
      return;
    }
    if (error.code === 'VALIDATION_ERROR') {
      const fieldErrors: Partial<Record<SupportLoginField, string>> = {};
      for (const [field, text] of Object.entries(fieldErrorMessages(error))) {
        if (isLoginField(field)) fieldErrors[field] = text;
      }
      this.errors.set(fieldErrors);
      if (Object.keys(fieldErrors).length > 0) return;
    }
    this.formError.set(problemMessage(error));
  }
}
