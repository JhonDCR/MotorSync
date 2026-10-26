import { ChangeDetectionStrategy, Component, DestroyRef, effect, inject, signal } from '@angular/core';
import { takeUntilDestroyed, toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { AuthApiService } from '../../core/api/auth-api.service';
import { fieldErrorMessage, fieldErrorMessages, isProblem, problemMessage } from '../../core/api/problem';
import { isValidEmail, normalizeEmail } from '../../shared/identifiers/email';
import { NETWORK_ERROR_MESSAGE } from './auth-form';

const REQUIRED_MESSAGE = fieldErrorMessage({ field: 'email', code: 'REQUIRED', message: '' });
const INVALID_EMAIL_MESSAGE = fieldErrorMessage({ field: 'email', code: 'INVALID_EMAIL', message: '' });
const FORGOT_PASSWORD_ACCEPTED_MESSAGE =
  'Si el correo corresponde a una cuenta de MotorSync, nuestro equipo de soporte se pondrá en contacto con usted para verificar su identidad y ayudarle a recuperar el acceso.';

/**
 * Public password help request page ("¿Olvidaste tu contraseña?", US1).
 * Sends only the normalized email; on 202 replaces the form with the generic FR-003 message.
 */
@Component({
  selector: 'app-forgot-password-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink],
  templateUrl: './forgot-password.page.html',
  styleUrl: './forgot-password.page.scss',
})
export class ForgotPasswordPage {
  private readonly api = inject(AuthApiService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly queryParams = toSignal(inject(ActivatedRoute).queryParamMap);

  protected readonly email = signal('');
  protected readonly emailError = signal<string | null>(null);
  protected readonly formError = signal<string | null>(null);
  protected readonly submitting = signal(false);
  protected readonly acceptedMessage = signal<string | null>(null);

  constructor() {
    effect(() => {
      const prefill = this.queryParams()?.get('email');
      if (prefill !== null && prefill !== undefined) {
        this.email.set(prefill);
      }
    });
  }

  protected updateEmail(event: Event): void {
    this.email.set((event.target as HTMLInputElement).value);
    if (this.emailError() !== null) {
      this.emailError.set(null);
    }
  }

  protected submit(event: Event): void {
    event.preventDefault();
    if (this.submitting()) return;
    this.formError.set(null);

    const raw = this.email();
    if (raw.trim() === '') {
      this.emailError.set(REQUIRED_MESSAGE);
      return;
    }
    const normalized = normalizeEmail(raw);
    if (!isValidEmail(normalized)) {
      this.emailError.set(INVALID_EMAIL_MESSAGE);
      return;
    }
    this.emailError.set(null);
    this.submitting.set(true);

    this.api
      .forgotPassword(normalized)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: () => {
          this.submitting.set(false);
          this.acceptedMessage.set(FORGOT_PASSWORD_ACCEPTED_MESSAGE);
        },
        error: (error: unknown) => {
          this.submitting.set(false);
          if (!isProblem(error)) {
            this.formError.set(NETWORK_ERROR_MESSAGE);
            return;
          }
          if (error.code === 'VALIDATION_ERROR') {
            const messages = fieldErrorMessages(error);
            if (messages['email'] !== undefined) {
              this.emailError.set(messages['email']);
              return;
            }
          }
          this.formError.set(problemMessage(error));
        },
      });
  }
}
