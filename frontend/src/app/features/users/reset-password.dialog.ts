import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  HostListener,
  inject,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { FormControl, ReactiveFormsModule, Validators } from '@angular/forms';
import { UsersApiService } from '../../core/api/users-api.service';
import { isProblem, problemMessage } from '../../core/api/problem';
import type { UserAccount } from '../../core/api/api.models';
import { PASSWORD_MAX_LENGTH, passwordLengthValidator } from '../auth/auth-form';


/** Elements that take focus inside the dialog (focus trap, FR-025). */
const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Ids of the field errors, referenced by the aria-describedby of the input (US4-AC21). */
export const RESET_ERROR_IDS = {
  required: 'temp-password-required-error',
  minLength: 'temp-password-length-error',
  maxLength: 'temp-password-max-length-error',
  server: 'reset-dialog-error',
} as const;

@Component({
  selector: 'app-reset-password-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ReactiveFormsModule],
  templateUrl: './reset-password.dialog.html',
  styleUrl: './reset-password.dialog.scss',
})
export class ResetPasswordDialog {
  private readonly usersApi = inject(UsersApiService);

  readonly userId = input.required<string>();
  readonly userName = input<string>('');

  readonly closed = output<void>();
  readonly success = output<UserAccount>();

  protected readonly passwordInput = viewChild<ElementRef<HTMLInputElement>>('pwdInput');
  private readonly dialogElement = viewChild<ElementRef<HTMLElement>>('dialog');

  protected readonly errorIds = RESET_ERROR_IDS;
  protected readonly maxLength = PASSWORD_MAX_LENGTH;

  protected readonly passwordControl = new FormControl('', {
    nonNullable: true,
    validators: [
      Validators.required,
      passwordLengthValidator,
    ],
  });

  protected readonly submitting = signal(false);
  protected readonly errorMessage = signal<string | null>(null);

  constructor() {
    // FR-025: on open, focus goes to the temporary password field.
    afterNextRender(() => {
      this.passwordInput()?.nativeElement.focus();
    });
  }

  /** Ids of the visible errors of the field, for its aria-describedby; null when there is none. */
  protected describedBy(): string | null {
    const control = this.passwordControl;
    const ids: string[] = [];
    if (control.touched) {
      if (control.hasError('required')) ids.push(RESET_ERROR_IDS.required);
      else if (control.hasError('minlength')) ids.push(RESET_ERROR_IDS.minLength);
      else if (control.hasError('maxlength')) ids.push(RESET_ERROR_IDS.maxLength);
    }
    if (this.errorMessage() !== null) ids.push(RESET_ERROR_IDS.server);
    return ids.length > 0 ? ids.join(' ') : null;
  }

  /** Focus trap (FR-025): Tab on the last focusable element goes to the first one, Shift+Tab on the first to the last. */
  protected trapFocus(event: KeyboardEvent): void {
    if (event.key !== 'Tab') return;
    const container = this.dialogElement()?.nativeElement;
    if (container === undefined) return;
    const items = Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
    if (items.length === 0) return;
    const first = items[0];
    const last = items[items.length - 1];
    const active = document.activeElement;
    if (event.shiftKey && (active === first || !container.contains(active))) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (active === last || !container.contains(active))) {
      event.preventDefault();
      first.focus();
    }
  }

  @HostListener('window:keydown.escape')
  onEscape(): void {
    if (!this.submitting()) {
      this.closed.emit();
    }
  }

  protected cancel(): void {
    this.closed.emit();
  }

  protected submit(event: Event): void {
    event.preventDefault();
    if (this.submitting()) return;
    this.errorMessage.set(null);

    if (this.passwordControl.invalid) {
      this.passwordControl.markAsTouched();
      return;
    }

    const tempPassword = this.passwordControl.value;
    this.submitting.set(true);

    this.usersApi.resetPassword(this.userId(), tempPassword).subscribe({
      next: (user) => {
        this.submitting.set(false);
        this.success.emit(user);
      },
      error: (error: unknown) => {
        this.submitting.set(false);
        if (isProblem(error)) {
          this.errorMessage.set(problemMessage(error));
        } else {
          this.errorMessage.set('No se pudo restablecer la contraseña. Revise su conexión');
        }
      },
    });
  }
}
