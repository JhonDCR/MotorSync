import { ChangeDetectionStrategy, Component, DestroyRef, inject, Injector, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Router } from '@angular/router';
import { catchError, type Observable, switchMap, throwError } from 'rxjs';
import type { ChangePasswordRequest, FieldError, Problem, SupportSessionResponse } from '../../core/api/api.models';
import { fieldErrorMessage, isProblem, problemMessage } from '../../core/api/problem';
import { SupportApiService } from '../../core/api/support-api.service';
import { SUPPORT_HOME_PATH, SUPPORT_LOGIN_PATH } from '../../core/support/support.guards';
import { SupportSessionRefreshCoordinator } from '../../core/support/support-refresh.interceptor';
import { SupportSessionStore } from '../../core/support/support-session.store';
import { NETWORK_ERROR_MESSAGE, PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH, unicodeLength } from '../auth/auth-form';

export type SupportChangePasswordField = keyof ChangePasswordRequest | 'confirmPassword';

const REQUIRED_MESSAGE = fieldErrorMessage({ field: '', code: 'REQUIRED', message: '' });
const TOO_SHORT_MESSAGE = fieldErrorMessage({ field: '', code: 'PASSWORD_TOO_SHORT', message: '' });
const TOO_LONG_MESSAGE = fieldErrorMessage({ field: '', code: 'PASSWORD_TOO_LONG', message: '' });
const SAME_PASSWORD_MESSAGE = fieldErrorMessage({ field: '', code: 'SAME_PASSWORD', message: '' });
const CURRENT_INCORRECT_MESSAGE = fieldErrorMessage({ field: '', code: 'CURRENT_PASSWORD_INCORRECT', message: '' });
const MISMATCH_MESSAGE = 'Las contraseñas no coinciden';

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
 * Mandatory or voluntary password change for support agents (FR-006, US2-AC2).
 */
@Component({
  selector: 'app-support-change-password-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './support-change-password.page.html',
  styleUrl: './support-change-password.page.scss',
})
export class SupportChangePasswordPage {
  private readonly api = inject(SupportApiService);
  private readonly router = inject(Router);
  private readonly injector = inject(Injector);
  private readonly destroyRef = inject(DestroyRef);
  protected readonly session = inject(SupportSessionStore);

  private readonly values: Record<SupportChangePasswordField, string> = {
    currentPassword: '',
    newPassword: '',
    confirmPassword: '',
  };

  protected readonly errors = signal<Partial<Record<SupportChangePasswordField, string>>>({});
  protected readonly formError = signal<string | null>(null);
  protected readonly submitting = signal(false);
  protected readonly passwordMinLength = PASSWORD_MIN_LENGTH;

  protected update(field: SupportChangePasswordField, event: Event): void {
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

  private validate(): Partial<Record<SupportChangePasswordField, string>> {
    const { currentPassword, newPassword, confirmPassword } = this.values;
    const errors: Partial<Record<SupportChangePasswordField, string>> = {};
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

  private send(body: ChangePasswordRequest): Observable<SupportSessionResponse> {
    return this.api.changePassword(body).pipe(
      catchError((error: unknown) => {
        if (!isProblem(error) || error.code !== 'TOKEN_EXPIRED') {
          return throwError(() => error);
        }
        return this.injector
          .get(SupportSessionRefreshCoordinator)
          .refresh()
          .pipe(switchMap(() => this.api.changePassword(body)));
      }),
    );
  }

  private changed(session: SupportSessionResponse): void {
    this.submitting.set(false);
    this.session.setSession(session);
    void this.router.navigateByUrl(SUPPORT_HOME_PATH);
  }

  private failed(error: unknown): void {
    this.submitting.set(false);
    if (!isProblem(error)) {
      this.formError.set(NETWORK_ERROR_MESSAGE);
      return;
    }
    switch (error.code) {
      case 'TEMPORARY_PASSWORD_EXPIRED':
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
    this.formError.set(problemMessage(error));
  }

  private showFieldErrors(problem: Problem): boolean {
    const errors: Partial<Record<SupportChangePasswordField, string>> = {};
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
    void this.router.navigate([SUPPORT_LOGIN_PATH], { queryParams: { reason } });
  }
}
