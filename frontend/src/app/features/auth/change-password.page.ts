import { ChangeDetectionStrategy, Component, DestroyRef, inject, Injector, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Router } from '@angular/router';
import { catchError, type Observable, switchMap, throwError } from 'rxjs';
import type { ChangePasswordRequest, FieldError, Problem, SessionResponse } from '../../core/api/api.models';
import { AuthApiService } from '../../core/api/auth-api.service';
import { fieldErrorMessage, isProblem, problemMessage } from '../../core/api/problem';
import { SessionRefreshCoordinator } from '../../core/auth/auth-refresh.interceptor';
import { LOGIN_PATH } from '../../core/auth/auth.guards';
import { SessionStore } from '../../core/auth/session.store';
import { NETWORK_ERROR_MESSAGE, PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH, unicodeLength } from './auth-form';

/** Fields of the screen: the two of ChangePasswordRequest plus the confirmation, which is never sent. */
export type ChangePasswordField = keyof ChangePasswordRequest | 'confirmPassword';

const REQUIRED_MESSAGE = fieldErrorMessage({ field: '', code: 'REQUIRED', message: '' });
const TOO_SHORT_MESSAGE = fieldErrorMessage({ field: '', code: 'PASSWORD_TOO_SHORT', message: '' });
const TOO_LONG_MESSAGE = fieldErrorMessage({ field: '', code: 'PASSWORD_TOO_LONG', message: '' });
const SAME_PASSWORD_MESSAGE = fieldErrorMessage({ field: '', code: 'SAME_PASSWORD', message: '' });
const CURRENT_INCORRECT_MESSAGE = fieldErrorMessage({ field: '', code: 'CURRENT_PASSWORD_INCORRECT', message: '' });
const MISMATCH_MESSAGE = 'Las contraseñas no coinciden';

/** Field codes with a message of ours: the `message` of the server is never shown (it could echo input, FR-006). */
const KNOWN_FIELD_CODES: readonly string[] = [
  'REQUIRED',
  'PASSWORD_TOO_SHORT',
  'PASSWORD_TOO_LONG',
  'SAME_PASSWORD',
  'CURRENT_PASSWORD_INCORRECT',
];
const SENT_FIELDS: readonly string[] = ['currentPassword', 'newPassword'];

type SessionEndReason = 'temporary-expired' | 'expired' | 'revoked';

function isSentField(field: string): field is keyof ChangePasswordRequest {
  return SENT_FIELDS.includes(field);
}

function isKnown(error: FieldError): boolean {
  return KNOWN_FIELD_CODES.includes(error.code);
}

/**
 * Change of the own password (US5). Mandatory while a temporary password is pending: the guards only open this
 * screen then (US5-AC1). Passwords are kept only in memory, sent as typed (FR-005) and never rendered (FR-006).
 */
@Component({
  selector: 'app-change-password-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './change-password.page.html',
  styleUrl: './change-password.page.scss',
})
export class ChangePasswordPage {
  private readonly api = inject(AuthApiService);
  private readonly router = inject(Router);
  private readonly injector = inject(Injector);
  private readonly destroyRef = inject(DestroyRef);
  protected readonly session = inject(SessionStore);

  /** Typed values; never bound back to the inputs nor rendered. */
  private readonly values: Record<ChangePasswordField, string> = {
    currentPassword: '',
    newPassword: '',
    confirmPassword: '',
  };

  protected readonly errors = signal<Partial<Record<ChangePasswordField, string>>>({});
  protected readonly formError = signal<string | null>(null);
  protected readonly submitting = signal(false);
  protected readonly passwordMinLength = PASSWORD_MIN_LENGTH;

  protected update(field: ChangePasswordField, event: Event): void {
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

    const errors = this.validate();
    this.errors.set(errors);
    if (Object.keys(errors).length > 0) return;

    this.submitting.set(true);
    // Exactly the contract body: no confirmation, no user id, nothing trimmed (FR-005, US5-AC8).
    const body: ChangePasswordRequest = {
      currentPassword: this.values.currentPassword,
      newPassword: this.values.newPassword,
    };
    this.send(body)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (session) => this.changed(session),
        error: (error: unknown) => this.failed(error),
      });
  }

  /** Lengths in Unicode characters, never trimmed: only the empty string is missing (FR-005). Case matters. */
  private validate(): Partial<Record<ChangePasswordField, string>> {
    const { currentPassword, newPassword, confirmPassword } = this.values;
    const errors: Partial<Record<ChangePasswordField, string>> = {};
    if (currentPassword === '') errors.currentPassword = REQUIRED_MESSAGE;

    const length = unicodeLength(newPassword);
    if (newPassword === '') errors.newPassword = REQUIRED_MESSAGE;
    else if (length < PASSWORD_MIN_LENGTH) errors.newPassword = TOO_SHORT_MESSAGE;
    else if (length > PASSWORD_MAX_LENGTH) errors.newPassword = TOO_LONG_MESSAGE;
    else if (newPassword === currentPassword) errors.newPassword = SAME_PASSWORD_MESSAGE;

    if (confirmPassword === '') errors.confirmPassword = REQUIRED_MESSAGE;
    else if (confirmPassword !== newPassword) errors.confirmPassword = MISMATCH_MESSAGE;
    return errors;
  }

  /**
   * The refresh interceptor leaves /auth/* untouched, so a TOKEN_EXPIRED here is handled by the page: the session
   * is renewed once with the shared single-flight refresh and the change is sent again.
   */
  private send(body: ChangePasswordRequest): Observable<SessionResponse> {
    return this.api.changePassword(body).pipe(
      catchError((error: unknown) => {
        if (!isProblem(error) || error.code !== 'TOKEN_EXPIRED') {
          return throwError(() => error);
        }
        return this.injector
          .get(SessionRefreshCoordinator)
          .refresh()
          .pipe(switchMap(() => this.api.changePassword(body)));
      }),
    );
  }

  private changed(session: SessionResponse): void {
    this.submitting.set(false);
    this.session.setSession(session);
    void this.router.navigateByUrl('/');
  }

  private failed(error: unknown): void {
    this.submitting.set(false);
    if (!isProblem(error)) {
      this.formError.set(NETWORK_ERROR_MESSAGE);
      return;
    }
    switch (error.code) {
      case 'TEMPORARY_PASSWORD_EXPIRED':
        // US5-AC9: the server already revoked the session; the login page explains what to do.
        this.endSession('temporary-expired');
        return;
      case 'SESSION_EXPIRED':
        this.endSession('expired');
        return;
      case 'SESSION_REVOKED':
        this.endSession('revoked');
        return;
      case 'CURRENT_PASSWORD_INCORRECT':
        this.errors.set({ currentPassword: CURRENT_INCORRECT_MESSAGE });
        return;
      case 'VALIDATION_ERROR':
        if (this.showFieldErrors(error)) return;
        break;
      default:
        break;
    }
    // ACCOUNT_LOCKED and the rest: message from the code only, never from detail or title.
    this.formError.set(problemMessage(error));
  }

  /** Server field errors on the fields of the screen. False if none applies. */
  private showFieldErrors(problem: Problem): boolean {
    const errors: Partial<Record<ChangePasswordField, string>> = {};
    for (const fieldError of problem.errors ?? []) {
      if (isSentField(fieldError.field) && errors[fieldError.field] === undefined && isKnown(fieldError)) {
        errors[fieldError.field] = fieldErrorMessage(fieldError);
      }
    }
    this.errors.set(errors);
    return Object.keys(errors).length > 0;
  }

  private endSession(reason: SessionEndReason): void {
    this.session.clear();
    void this.router.navigate([LOGIN_PATH], { queryParams: { reason } });
  }
}
