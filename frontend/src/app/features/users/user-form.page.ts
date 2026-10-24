import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import type { Role } from '../../core/api/api.models';
import { isProblem, problemMessage } from '../../core/api/problem';
import { UsersApiService } from '../../core/api/users-api.service';
import { normalizeEmail } from '../../shared/identifiers/email';
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH, passwordLengthValidator } from '../auth/auth-form';

const NAME_MIN_LENGTH = 2;
const NAME_MAX_LENGTH = 120;
const EMAIL_MAX_LENGTH = 254;

/** Ids of the temporary password errors, referenced by the aria-describedby of the input. */
const PASSWORD_ERROR_IDS = {
  required: 'temporary-password-required-error',
  minLength: 'temporary-password-length-error',
  maxLength: 'temporary-password-max-length-error',
} as const;

@Component({
  selector: 'app-user-form-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ReactiveFormsModule, RouterLink],
  templateUrl: './user-form.page.html',
  styleUrl: './user-form.page.scss',
})
export class UserFormPage {
  private readonly fb = inject(FormBuilder);
  private readonly usersApi = inject(UsersApiService);
  private readonly router = inject(Router);

  protected readonly form = this.fb.group({
    name: [
      '',
      [Validators.required, Validators.minLength(NAME_MIN_LENGTH), Validators.maxLength(NAME_MAX_LENGTH)],
    ],
    email: ['', [Validators.required, Validators.email, Validators.maxLength(EMAIL_MAX_LENGTH)]],
    role: ['asesor' as Role, [Validators.required]],
    temporaryPassword: [
      '',
      [Validators.required, passwordLengthValidator],
    ],
  });

  protected readonly submitting = signal(false);
  protected readonly formError = signal<string | null>(null);

  protected readonly passwordErrorIds = PASSWORD_ERROR_IDS;
  protected readonly passwordMinLength = PASSWORD_MIN_LENGTH;
  protected readonly passwordMaxLength = PASSWORD_MAX_LENGTH;

  /** Id of the visible error of the temporary password, for its aria-describedby; null when there is none. */
  protected passwordDescribedBy(): string | null {
    const control = this.form.controls.temporaryPassword;
    if (!control.touched) return null;
    if (control.hasError('required')) return PASSWORD_ERROR_IDS.required;
    if (control.hasError('minlength')) return PASSWORD_ERROR_IDS.minLength;
    if (control.hasError('maxlength')) return PASSWORD_ERROR_IDS.maxLength;
    return null;
  }

  protected submit(): void {
    if (this.submitting()) return;
    this.formError.set(null);

    if (this.form.invalid) {
      this.form.markAllAsTouched();
      return;
    }

    const raw = this.form.getRawValue();
    this.submitting.set(true);

    this.usersApi
      .create({
        name: raw.name!.trim(),
        email: normalizeEmail(raw.email!),
        role: raw.role!,
        temporaryPassword: raw.temporaryPassword!,
      })
      .subscribe({
        next: (created) => {
          this.submitting.set(false);
          this.router.navigate(['/users', created.id]);
        },
        error: (err: unknown) => {
          this.submitting.set(false);
          if (isProblem(err)) {
            if (err.code === 'EMAIL_UNAVAILABLE') {
              this.formError.set(
                'No se pudo crear la cuenta con este correo. Si la persona ya tiene una cuenta en su taller, búsquela en la lista; si no, use otro correo',
              );
            } else {
              this.formError.set(problemMessage(err));
            }
          } else {
            this.formError.set('No se pudo crear la cuenta. Revise su conexión');
          }
        },
      });
  }
}
