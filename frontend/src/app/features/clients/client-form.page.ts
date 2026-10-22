import { HttpErrorResponse } from '@angular/common/http';
import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  inject,
  Injector,
  signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormBuilder, ReactiveFormsModule, type AbstractControl, type ValidationErrors, type ValidatorFn } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink, type UrlTree } from '@angular/router';
import type { Subscription } from 'rxjs';
import type { ClientCreate, ClientType, DocumentType, FieldErrorCode } from '../../core/api/api.models';
import { ClientsApiService } from '../../core/api/clients-api.service';
import { fieldErrorMessage, fieldErrorMessages, isProblem, problemMessage } from '../../core/api/problem';
import { isValidCedula, isValidRuc } from '../../shared/identifiers/ec-document';
import { normalizeEmail } from '../../shared/identifiers/email';
import { normalizeDocument } from '../../shared/identifiers/normalize';
import { normalizePhone } from '../../shared/identifiers/phone';
import { documentNumberValidator, emailValidator, phoneValidator } from '../../shared/validators/client.validators';

/** Contract field names of ClientCreate shown in the form. */
export type ClientFormField = 'documentNumber' | 'firstNames' | 'lastNames' | 'businessName' | 'phone' | 'email';

const CEDULA_LENGTH = 10;
const RUC_SUFFIX = '001';
const UNEXPECTED_ERROR = 'No se pudo guardar el cliente. Inténtelo de nuevo';

/** Required text: empty or whitespace-only values are missing (US2-AC8). */
const requiredText: ValidatorFn = (control: AbstractControl): ValidationErrors | null =>
  typeof control.value === 'string' && control.value.trim() !== '' ? null : { REQUIRED: true };

/** Spanish message of the first validator error, through the contract codes (problem.ts). */
function validationMessage(errors: ValidationErrors): string {
  const code = Object.keys(errors)[0] as FieldErrorCode;
  return fieldErrorMessage({ field: '', code, message: 'Valor inválido' });
}

/**
 * ?returnTo= is only honored for internal paths (US3-AC9): it starts with "/" and not with "//" or "/\"
 * (both would be read by the browser as another origin).
 */
export function isInternalPath(value: string | null): value is string {
  return value !== null && value.startsWith('/') && !value.startsWith('//') && !value.startsWith('/\\');
}

/** Counterpart of a natural person's document: cedula X ↔ RUC X001 (edge case "posible duplicado"). */
function counterpartOf(documentType: DocumentType, documentNumber: string): string | null {
  if (documentType === 'cedula' && isValidCedula(documentNumber)) {
    return `${documentNumber}${RUC_SUFFIX}`;
  }
  if (documentType === 'ruc' && isValidRuc(documentNumber)) {
    const cedula = documentNumber.slice(0, CEDULA_LENGTH);
    return isValidCedula(cedula) ? cedula : null;
  }
  return null;
}

/** New client (US2): natural person or company, Ecuadorian documents, phone and optional email. */
@Component({
  selector: 'app-client-form-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ReactiveFormsModule, RouterLink],
  templateUrl: './client-form.page.html',
  styleUrl: './client-form.page.scss',
})
export class ClientFormPage {
  private readonly api = inject(ClientsApiService);
  private readonly router = inject(Router);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly injector = inject(Injector);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly form = inject(FormBuilder).nonNullable.group({
    clientType: 'natural' as ClientType,
    documentType: 'cedula' as DocumentType,
    documentNumber: ['', [requiredText, documentNumberValidator('cedula')]],
    firstNames: ['', requiredText],
    lastNames: ['', requiredText],
    businessName: [{ value: '', disabled: true }, requiredText],
    phone: ['', [requiredText, phoneValidator]],
    email: ['', emailValidator],
  });

  protected readonly clientType = signal<ClientType>('natural');
  protected readonly documentType = signal<DocumentType>('cedula');
  protected readonly submitted = signal(false);
  protected readonly saving = signal(false);
  protected readonly serverErrors = signal<Partial<Record<string, string>>>({});
  protected readonly duplicate = signal<{ message: string; existingId: string | null } | null>(null);
  protected readonly networkError = signal(false);
  protected readonly generalError = signal<string | null>(null);
  protected readonly possibleDuplicate = signal<{ displayName: string; documentNumber: string } | null>(null);

  /** Internal page to come back to after creating the client (for example, the new vehicle form). */
  protected readonly returnTo: UrlTree | null = this.readReturnTo();

  /** Last body sent: "Reintentar" resends exactly the same data. */
  private lastBody: ClientCreate | null = null;
  private duplicateCheck: Subscription | null = null;

  constructor() {
    const { controls } = this.form;
    controls.clientType.valueChanges.pipe(takeUntilDestroyed()).subscribe((type) => this.onClientTypeChange(type));
    controls.documentType.valueChanges.pipe(takeUntilDestroyed()).subscribe((type) => this.onDocumentTypeChange(type));
    controls.documentNumber.valueChanges.pipe(takeUntilDestroyed()).subscribe(() => this.clearPossibleDuplicate());
    for (const field of ['documentNumber', 'firstNames', 'lastNames', 'businessName', 'phone', 'email'] as const) {
      controls[field].valueChanges.pipe(takeUntilDestroyed()).subscribe(() => this.clearServerError(field));
    }
    this.destroyRef.onDestroy(() => this.duplicateCheck?.unsubscribe());
  }

  /** Message next to a field: the server's errors[] first, then the client validators after a save attempt. */
  protected errorFor(field: ClientFormField): string | null {
    const server = this.serverErrors()[field];
    if (server !== undefined) {
      return server;
    }
    const control = this.form.controls[field];
    if (!this.submitted() || control.disabled || control.errors === null) {
      return null;
    }
    return validationMessage(control.errors);
  }

  protected save(): void {
    this.submitted.set(true);
    this.clearNotices();
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      this.focusFirstInvalid();
      return;
    }
    this.send(this.buildBody());
  }

  protected retry(): void {
    if (this.lastBody === null) {
      return;
    }
    this.clearNotices();
    this.send(this.lastBody);
  }

  /** On blur of the document: looks for the cedula ↔ RUC counterpart without blocking the save. */
  protected checkPossibleDuplicate(): void {
    this.clearPossibleDuplicate();
    const documentNumber = normalizeDocument(this.form.controls.documentNumber.value);
    const counterpart = counterpartOf(this.documentType(), documentNumber);
    if (counterpart === null) {
      return;
    }
    this.duplicateCheck = this.api.search(documentNumber.slice(0, CEDULA_LENGTH)).subscribe({
      next: (response) => {
        const match = response.items.find((item) => item.documentNumber === counterpart);
        this.possibleDuplicate.set(match ? { displayName: match.displayName, documentNumber: match.documentNumber } : null);
      },
      error: () => this.possibleDuplicate.set(null),
    });
  }

  private send(body: ClientCreate): void {
    this.lastBody = body;
    this.saving.set(true);
    this.api.create(body).subscribe({
      next: (detail) => {
        this.saving.set(false);
        if (this.returnTo !== null) {
          const target = this.router.parseUrl(this.router.serializeUrl(this.returnTo));
          target.queryParams = { ...target.queryParams, clientId: detail.id };
          void this.router.navigateByUrl(target);
          return;
        }
        void this.router.navigate(['/clients', detail.id]);
      },
      error: (error: unknown) => {
        this.saving.set(false);
        this.handleError(error);
      },
    });
  }

  private handleError(error: unknown): void {
    if (isProblem(error)) {
      if (error.code === 'DOCUMENT_ALREADY_EXISTS') {
        this.duplicate.set({ message: problemMessage(error), existingId: error.existingId ?? null });
        return;
      }
      const fieldMessages = fieldErrorMessages(error);
      this.serverErrors.set(fieldMessages);
      this.generalError.set(problemMessage(error, { resource: 'client' }));
      if (Object.keys(fieldMessages).length > 0) {
        this.focusFirstInvalid();
      }
      return;
    }
    if (error instanceof HttpErrorResponse && error.status === 0) {
      this.networkError.set(true);
      return;
    }
    this.generalError.set(UNEXPECTED_ERROR);
  }

  private buildBody(): ClientCreate {
    const value = this.form.getRawValue();
    const email = value.email.trim();
    const common = {
      documentNumber: normalizeDocument(value.documentNumber),
      phone: normalizePhone(value.phone),
      email: email === '' ? null : normalizeEmail(email),
    };
    if (value.clientType === 'company') {
      return { clientType: 'company', documentType: 'ruc', businessName: value.businessName.trim(), ...common };
    }
    return {
      clientType: 'natural',
      documentType: value.documentType,
      firstNames: value.firstNames.trim(),
      lastNames: value.lastNames.trim(),
      ...common,
    };
  }

  private onClientTypeChange(type: ClientType): void {
    const { controls } = this.form;
    this.clientType.set(type);
    if (type === 'company') {
      controls.firstNames.disable({ emitEvent: false });
      controls.lastNames.disable({ emitEvent: false });
      controls.businessName.enable({ emitEvent: false });
      controls.documentType.setValue('ruc');
    } else {
      controls.firstNames.enable({ emitEvent: false });
      controls.lastNames.enable({ emitEvent: false });
      controls.businessName.disable({ emitEvent: false });
    }
    this.serverErrors.set({});
  }

  private onDocumentTypeChange(type: DocumentType): void {
    const documentNumber = this.form.controls.documentNumber;
    this.documentType.set(type);
    documentNumber.setValidators([requiredText, documentNumberValidator(type)]);
    documentNumber.updateValueAndValidity({ emitEvent: false });
    this.clearPossibleDuplicate();
    this.clearServerError('documentNumber');
  }

  private readReturnTo(): UrlTree | null {
    const value = inject(ActivatedRoute).snapshot.queryParamMap.get('returnTo');
    if (!isInternalPath(value)) {
      return null;
    }
    try {
      return this.router.parseUrl(value);
    } catch {
      return null;
    }
  }

  private clearNotices(): void {
    this.serverErrors.set({});
    this.duplicate.set(null);
    this.networkError.set(false);
    this.generalError.set(null);
  }

  private clearServerError(field: ClientFormField): void {
    const errors = this.serverErrors();
    if (errors[field] !== undefined) {
      const rest = { ...errors };
      delete rest[field];
      this.serverErrors.set(rest);
    }
  }

  private clearPossibleDuplicate(): void {
    this.duplicateCheck?.unsubscribe();
    this.duplicateCheck = null;
    this.possibleDuplicate.set(null);
  }

  /** Keyboard and screen reader users land on the first field to fix. */
  private focusFirstInvalid(): void {
    afterNextRender(
      () => this.host.nativeElement.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus(),
      { injector: this.injector },
    );
  }
}
