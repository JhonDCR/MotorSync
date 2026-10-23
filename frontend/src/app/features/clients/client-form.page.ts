import { HttpErrorResponse } from '@angular/common/http';
import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  ElementRef,
  inject,
  Injector,
  signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import {
  FormBuilder,
  FormControl,
  ReactiveFormsModule,
  type AbstractControl,
  type ValidationErrors,
  type ValidatorFn,
} from '@angular/forms';
import { ActivatedRoute, Router, RouterLink, type UrlTree } from '@angular/router';
import type { Subscription } from 'rxjs';
import type {
  ClientCreate,
  ClientDetail,
  ClientType,
  ClientUpdate,
  DocumentType,
  FieldErrorCode,
  Problem,
} from '../../core/api/api.models';
import { ClientsApiService } from '../../core/api/clients-api.service';
import { fieldErrorMessage, fieldErrorMessages, isProblem, problemMessage } from '../../core/api/problem';
import { readCurrentSession } from '../../core/auth/current-session';
import { isValidCedula, isValidRuc } from '../../shared/identifiers/ec-document';
import { normalizeEmail } from '../../shared/identifiers/email';
import { normalizeDocument } from '../../shared/identifiers/normalize';
import { normalizePhone } from '../../shared/identifiers/phone';
import { documentNumberValidator, emailValidator, phoneValidator } from '../../shared/validators/client.validators';
import {
  isReasonAcceptable,
  isReasonRequired,
  normalizeReason,
  REASON_MAX_LENGTH,
  REASON_REQUIRED_MESSAGE,
} from '../../shared/validators/reason';

/** Contract field names of ClientCreate shown in the form. */
export type ClientFormField = 'documentNumber' | 'firstNames' | 'lastNames' | 'businessName' | 'phone' | 'email';

/** Edit mode load state; in clients/new it is always 'ready'. */
export type ClientLoadState = { kind: 'loading' } | { kind: 'ready' } | { kind: 'error'; message: string; canRetry: boolean };

const CEDULA_LENGTH = 10;
const RUC_SUFFIX = '001';
const NOT_FOUND_STATUS = 404;
const UNEXPECTED_ERROR = 'No se pudo guardar el cliente. Inténtelo de nuevo';
const LOAD_FAILED = 'No se pudo cargar el cliente. Revise la conexión e inténtelo de nuevo';

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

function isClientDetail(value: Problem['current']): value is ClientDetail {
  return value !== undefined && 'clientType' in value;
}

/**
 * New client (US2) at clients/new: natural person or company, Ecuadorian documents, phone and optional email.
 * Edit mode (US4) at clients/:id/edit: same rules, optimistic locking with version, the client type locked and a
 * reason when the document or its type change (FR-019).
 */
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

  /** Id of the client being edited (clients/:id/edit); null in clients/new. */
  protected readonly clientId: string | null = inject(ActivatedRoute).snapshot.paramMap.get('id');
  protected readonly editing = this.clientId !== null;
  /** UI only (FR-019): the backend decides with the verified token. Without a session the asesor rule applies. */
  protected readonly reasonRequired = isReasonRequired(readCurrentSession());
  protected readonly reasonMaxLength = REASON_MAX_LENGTH;

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
  protected readonly reason = new FormControl('', { nonNullable: true });

  protected readonly clientType = signal<ClientType>('natural');
  protected readonly documentType = signal<DocumentType>('cedula');
  protected readonly submitted = signal(false);
  protected readonly saving = signal(false);
  protected readonly serverErrors = signal<Partial<Record<string, string>>>({});
  protected readonly duplicate = signal<{ message: string; existingId: string | null } | null>(null);
  protected readonly networkError = signal(false);
  protected readonly generalError = signal<string | null>(null);
  protected readonly possibleDuplicate = signal<{ displayName: string; documentNumber: string } | null>(null);
  protected readonly loadState = signal<ClientLoadState>({ kind: this.editing ? 'loading' : 'ready' });
  protected readonly versionConflict = signal(false);

  /** Stored client in edit mode: the base to compare the identifiers and the version to send. */
  private readonly stored = signal<ClientDetail | null>(null);
  private readonly documentNumberValue = signal('');

  /** The reason field is shown only when the document or its type really change (compared normalized). */
  protected readonly documentChanged = computed(() => {
    const stored = this.stored();
    return (
      stored !== null &&
      (this.documentType() !== stored.documentType ||
        normalizeDocument(this.documentNumberValue()) !== stored.documentNumber)
    );
  });

  /** Internal page to come back to after creating the client (for example, the new vehicle form). */
  protected readonly returnTo: UrlTree | null = this.editing ? null : this.readReturnTo();

  /** Last body sent: "Reintentar" resends exactly the same data. */
  private lastBody: ClientCreate | ClientUpdate | null = null;
  private duplicateCheck: Subscription | null = null;
  private loadRequest: Subscription | null = null;

  constructor() {
    const { controls } = this.form;
    controls.clientType.valueChanges.pipe(takeUntilDestroyed()).subscribe((type) => this.onClientTypeChange(type));
    controls.documentType.valueChanges.pipe(takeUntilDestroyed()).subscribe((type) => this.onDocumentTypeChange(type));
    controls.documentNumber.valueChanges.pipe(takeUntilDestroyed()).subscribe((value) => {
      this.documentNumberValue.set(value);
      this.clearPossibleDuplicate();
    });
    for (const field of ['documentNumber', 'firstNames', 'lastNames', 'businessName', 'phone', 'email'] as const) {
      controls[field].valueChanges.pipe(takeUntilDestroyed()).subscribe(() => this.clearServerError(field));
    }
    this.reason.valueChanges.pipe(takeUntilDestroyed()).subscribe(() => this.clearServerError('reason'));
    this.destroyRef.onDestroy(() => {
      this.duplicateCheck?.unsubscribe();
      this.loadRequest?.unsubscribe();
    });
    if (this.editing) {
      // clientType is not part of ClientUpdate: it cannot change.
      controls.clientType.disable({ emitEvent: false });
      this.load();
    }
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

  /** Message under the reason: the server's REASON_REQUIRED first, then the local rule after a save attempt. */
  protected reasonError(): string | null {
    const server = this.serverErrors()['reason'];
    if (server !== undefined) {
      return server;
    }
    if (!this.submitted() || !this.documentChanged() || this.isReasonValid()) {
      return null;
    }
    return REASON_REQUIRED_MESSAGE;
  }

  protected save(): void {
    this.submitted.set(true);
    this.clearNotices();
    const reasonInvalid = this.documentChanged() && !this.isReasonValid();
    if (this.form.invalid || reasonInvalid) {
      this.form.markAllAsTouched();
      this.focusFirstInvalid();
      return;
    }
    this.send(this.editing ? this.buildUpdate() : this.buildBody());
  }

  protected retry(): void {
    if (this.lastBody === null) {
      return;
    }
    this.clearNotices();
    this.send(this.lastBody);
  }

  protected retryLoad(): void {
    this.load();
  }

  /** On blur of the document: looks for the cedula ↔ RUC counterpart without blocking the save. */
  protected checkPossibleDuplicate(): void {
    this.clearPossibleDuplicate();
    if (this.editing && !this.documentChanged()) {
      return;
    }
    const documentNumber = normalizeDocument(this.form.controls.documentNumber.value);
    const counterpart = counterpartOf(this.documentType(), documentNumber);
    if (counterpart === null) {
      return;
    }
    this.duplicateCheck = this.api.search(documentNumber.slice(0, CEDULA_LENGTH)).subscribe({
      next: (response) => {
        const match = response.items.find((item) => item.documentNumber === counterpart && item.id !== this.clientId);
        this.possibleDuplicate.set(match ? { displayName: match.displayName, documentNumber: match.documentNumber } : null);
      },
      error: () => this.possibleDuplicate.set(null),
    });
  }

  private send(body: ClientCreate | ClientUpdate): void {
    this.lastBody = body;
    this.saving.set(true);
    const request =
      this.clientId !== null && 'version' in body ? this.api.update(this.clientId, body) : this.api.create(body as ClientCreate);
    request.subscribe({
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
      if (error.code === 'VERSION_CONFLICT' && this.editing) {
        this.onVersionConflict(error);
        return;
      }
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

  /** US4-AC12: shows the current data (from the 409, or a new GET) and the next save uses its version. */
  private onVersionConflict(problem: Problem): void {
    this.versionConflict.set(true);
    if (isClientDetail(problem.current)) {
      this.fill(problem.current);
      return;
    }
    this.load(false);
  }

  /** Loads the client to edit; showLoading false keeps the form on screen (reload after a conflict). */
  private load(showLoading = true): void {
    if (this.clientId === null) {
      return;
    }
    if (showLoading) {
      this.loadState.set({ kind: 'loading' });
    }
    this.loadRequest?.unsubscribe();
    this.loadRequest = this.api.getById(this.clientId).subscribe({
      next: (client) => {
        this.fill(client);
        this.loadState.set({ kind: 'ready' });
      },
      error: (error: unknown) => {
        const notFound = isProblem(error) && error.status === NOT_FOUND_STATUS;
        this.loadState.set({
          kind: 'error',
          message: notFound ? problemMessage(error, { resource: 'client' }) : LOAD_FAILED,
          canRetry: !notFound,
        });
      },
    });
  }

  /** Puts the stored client in the form; the reason starts empty again. */
  private fill(client: ClientDetail): void {
    this.stored.set(client);
    this.submitted.set(false);
    this.form.patchValue({
      clientType: client.clientType,
      documentType: client.documentType,
      documentNumber: client.documentNumber,
      firstNames: client.firstNames ?? '',
      lastNames: client.lastNames ?? '',
      businessName: client.businessName ?? '',
      phone: client.phone,
      email: client.email ?? '',
    });
    this.reason.setValue('');
    this.serverErrors.set({});
  }

  private isReasonValid(): boolean {
    return isReasonAcceptable(this.reason.value, this.reasonRequired);
  }

  /** ClientUpdate: the loaded version plus the fields that change; never clientType nor tenantId. */
  private buildUpdate(): ClientUpdate {
    const stored = this.stored();
    if (stored === null) {
      throw new Error('The client to edit is not loaded');
    }
    const value = this.form.getRawValue();
    const body: ClientUpdate = { version: stored.version };
    if (this.documentChanged()) {
      body.documentType = value.documentType;
      body.documentNumber = normalizeDocument(value.documentNumber);
      const reason = normalizeReason(this.reason.value);
      if (reason !== null) {
        body.reason = reason;
      }
    }
    if (stored.clientType === 'company') {
      const businessName = value.businessName.trim();
      if (businessName !== (stored.businessName ?? '')) body.businessName = businessName;
    } else {
      const firstNames = value.firstNames.trim();
      const lastNames = value.lastNames.trim();
      if (firstNames !== (stored.firstNames ?? '')) body.firstNames = firstNames;
      if (lastNames !== (stored.lastNames ?? '')) body.lastNames = lastNames;
    }
    const phone = normalizePhone(value.phone);
    if (phone !== stored.phone) body.phone = phone;
    const email = value.email.trim() === '' ? null : normalizeEmail(value.email.trim());
    if (email !== stored.email) body.email = email;
    return body;
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
    this.versionConflict.set(false);
  }

  private clearServerError(field: ClientFormField | 'reason'): void {
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
