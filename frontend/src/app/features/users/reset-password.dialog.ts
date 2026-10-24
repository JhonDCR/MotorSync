import {
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

const PASSWORD_MIN_LENGTH = 8;
const PASSWORD_MAX_LENGTH = 128;

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

  protected readonly passwordControl = new FormControl('', {
    nonNullable: true,
    validators: [
      Validators.required,
      Validators.minLength(PASSWORD_MIN_LENGTH),
      Validators.maxLength(PASSWORD_MAX_LENGTH),
    ],
  });

  protected readonly submitting = signal(false);
  protected readonly errorMessage = signal<string | null>(null);

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
