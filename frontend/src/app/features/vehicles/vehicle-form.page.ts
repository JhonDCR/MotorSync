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
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import type { Subscription } from 'rxjs';
import type {
  BodyType,
  ClientDetail,
  ClientSummary,
  FieldError,
  Problem,
  VehicleCreate,
  VehicleDetail,
  VehicleUpdate,
} from '../../core/api/api.models';
import { ClientsApiService } from '../../core/api/clients-api.service';
import { fieldErrorMessage, isProblem, problemMessage } from '../../core/api/problem';
import { VehiclesApiService } from '../../core/api/vehicles-api.service';
import { readCurrentSession } from '../../core/auth/current-session';
import { isBodyType, normalizePlateForWrite } from '../../shared/identifiers/plate';
import { normalizeVin } from '../../shared/identifiers/vin';
import {
  isReasonAcceptable,
  isReasonRequired,
  normalizeReason,
  REASON_MAX_LENGTH,
  REASON_REQUIRED_MESSAGE,
} from '../../shared/validators/reason';
import { mileageValidator, plateValidator, vinValidator, yearValidator } from '../../shared/validators/vehicle.validators';
import { BODY_TYPE_OPTIONS } from './body-type';

/** Contract field names of VehicleCreate shown in the form. */
export type VehicleFormField =
  | 'plate'
  | 'vin'
  | 'brand'
  | 'model'
  | 'year'
  | 'color'
  | 'bodyType'
  | 'initialMileage'
  | 'ownerClientId';

type DraftField = Exclude<VehicleFormField, 'ownerClientId'>;

type DraftTextField = Exclude<DraftField, 'bodyType'>;

/** Values kept while the user registers a new client (US3-AC9). */
export type VehicleFormDraft = Record<DraftTextField, string> & { bodyType: BodyType };

/** sessionStorage key of the draft: read once when /vehicles/new opens, then removed. */
export const VEHICLE_FORM_DRAFT_KEY = 'motorsync.vehicle-form-draft';
export const VEHICLE_FORM_PATH = '/vehicles/new';

const DRAFT_TEXT_FIELDS: readonly DraftTextField[] = ['plate', 'vin', 'brand', 'model', 'year', 'color', 'initialMileage'];
const SERVER_FIELDS: readonly VehicleFormField[] = [...DRAFT_TEXT_FIELDS, 'bodyType', 'ownerClientId'];
const TEXT_MAX_LENGTH = 60;
const MIN_OWNER_SEARCH_LENGTH = 2;
const OWNER_REQUIRED = 'Elija el propietario del vehículo';
const OWNER_SEARCH_TOO_SHORT = 'Escriba al menos 2 caracteres';
const OWNER_SEARCH_FAILED = 'No se pudo buscar clientes. Revise la conexión e inténtelo de nuevo';
const OWNER_LOAD_FAILED = 'No se pudo cargar el cliente. Búsquelo de nuevo';
const UNEXPECTED_ERROR = 'No se pudo guardar el vehículo. Inténtelo de nuevo';
const LOAD_FAILED = 'No se pudo cargar el vehículo. Revise la conexión e inténtelo de nuevo';
const NOT_FOUND_STATUS = 404;

/** Edit mode load state; in vehicles/new it is always 'ready'. */
export type VehicleLoadState =
  | { kind: 'loading' }
  | { kind: 'ready' }
  | { kind: 'error'; message: string; canRetry: boolean };

/** Plate as it would be stored: normalized when possible (invalid symbols are left to the validator). */
function writePlate(raw: string): string {
  return normalizePlateForWrite(raw) ?? raw;
}

/** VIN as it would be stored: '' → null, normalized when possible. */
function writeVin(raw: string): string | null {
  const vin = raw.trim();
  return vin === '' ? null : (normalizeVin(vin) ?? vin);
}

function isVehicleDetail(value: Problem['current']): value is VehicleDetail {
  return value !== undefined && 'plate' in value;
}

/** Required text: empty or whitespace-only values are missing. */
const requiredText: ValidatorFn = (control: AbstractControl): ValidationErrors | null =>
  typeof control.value === 'string' && control.value.trim() !== '' ? null : { REQUIRED: true };

/** Brand, model and color admit at most 60 characters once trimmed (data-model.md). */
const maxTextLength: ValidatorFn = (control: AbstractControl): ValidationErrors | null =>
  typeof control.value === 'string' && control.value.trim().length > TEXT_MAX_LENGTH ? { MAX_LENGTH: true } : null;

function toSummary(client: ClientDetail | ClientSummary): ClientSummary {
  return {
    id: client.id,
    clientType: client.clientType,
    documentType: client.documentType,
    documentNumber: client.documentNumber,
    displayName: client.displayName,
    phone: client.phone,
    email: client.email,
  };
}

function readDraft(): Partial<VehicleFormDraft> | null {
  let raw: string | null;
  try {
    raw = sessionStorage.getItem(VEHICLE_FORM_DRAFT_KEY);
    sessionStorage.removeItem(VEHICLE_FORM_DRAFT_KEY);
  } catch {
    return null;
  }
  if (raw === null) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return null;
  }
  const source = parsed as Record<string, unknown>;
  const draft: Partial<VehicleFormDraft> = {};
  for (const field of DRAFT_TEXT_FIELDS) {
    const value = source[field];
    if (typeof value === 'string') {
      draft[field] = value;
    }
  }
  const bodyType = source['bodyType'];
  if (isBodyType(bodyType)) {
    draft.bodyType = bodyType;
  }
  return draft;
}

function removeDraft(): void {
  try {
    sessionStorage.removeItem(VEHICLE_FORM_DRAFT_KEY);
  } catch {
    // Storage unavailable: there is nothing to remove.
  }
}

/**
 * New vehicle (US3) at vehicles/new: owner, Ecuadorian plate by body type, optional VIN, year and initial mileage.
 * Edit mode (US4) at vehicles/:id/edit: same rules and optimistic locking; the owner is read-only (it changes only
 * through the ownership transfer) and changing the plate or the VIN asks for a reason (FR-019).
 */
@Component({
  selector: 'app-vehicle-form-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ReactiveFormsModule, RouterLink],
  templateUrl: './vehicle-form.page.html',
  styleUrl: './vehicle-form.page.scss',
})
export class VehicleFormPage {
  private readonly vehiclesApi = inject(VehiclesApiService);
  private readonly clientsApi = inject(ClientsApiService);
  private readonly router = inject(Router);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly injector = inject(Injector);
  private readonly destroyRef = inject(DestroyRef);

  /** Id of the vehicle being edited (vehicles/:id/edit); null in vehicles/new. */
  protected readonly vehicleId: string | null = inject(ActivatedRoute).snapshot.paramMap.get('id');
  protected readonly editing = this.vehicleId !== null;
  /** UI only (FR-019): the backend decides with the verified token. Without a session the asesor rule applies. */
  protected readonly reasonRequired = isReasonRequired(readCurrentSession());
  protected readonly reasonMaxLength = REASON_MAX_LENGTH;

  protected readonly bodyTypeOptions = BODY_TYPE_OPTIONS;

  protected readonly form = inject(FormBuilder).nonNullable.group({
    plate: ['', [requiredText, plateValidator()]],
    vin: ['', vinValidator],
    brand: ['', [requiredText, maxTextLength]],
    model: ['', [requiredText, maxTextLength]],
    year: ['', [requiredText, yearValidator]],
    color: ['', [requiredText, maxTextLength]],
    bodyType: 'sedan' as BodyType,
    initialMileage: ['', [requiredText, mileageValidator]],
  });

  protected readonly reason = new FormControl('', { nonNullable: true });
  protected readonly ownerTerm = new FormControl('', { nonNullable: true });
  protected readonly owner = signal<ClientSummary | null>(null);
  protected readonly ownerLoading = signal(false);
  protected readonly ownerResults = signal<{ items: ClientSummary[]; hasMore: boolean } | null>(null);
  protected readonly ownerSearching = signal(false);
  protected readonly ownerSearchError = signal<string | null>(null);
  protected readonly ownerError = signal<string | null>(null);

  protected readonly submitted = signal(false);
  protected readonly saving = signal(false);
  protected readonly serverErrors = signal<Partial<Record<VehicleFormField, FieldError>>>({});
  protected readonly duplicate = signal<{ message: string; existingId: string | null } | null>(null);
  protected readonly networkError = signal(false);
  protected readonly generalError = signal<string | null>(null);
  protected readonly loadState = signal<VehicleLoadState>({ kind: this.editing ? 'loading' : 'ready' });
  protected readonly versionConflict = signal(false);
  protected readonly reasonServerError = signal<string | null>(null);

  /** Stored vehicle in edit mode: the base to compare plate and VIN, and the version to send. */
  private readonly stored = signal<VehicleDetail | null>(null);
  private readonly plateValue = signal('');
  private readonly vinValue = signal('');

  /** The reason field is shown only when the plate or the VIN really change (compared normalized). */
  protected readonly identifiersChanged = computed(() => {
    const stored = this.stored();
    return (
      stored !== null && (writePlate(this.plateValue()) !== stored.plate || writeVin(this.vinValue()) !== stored.vin)
    );
  });

  /** Last body sent: "Reintentar" resends exactly the same data. */
  private lastBody: VehicleCreate | VehicleUpdate | null = null;
  private loadRequest: Subscription | null = null;
  private ownerLookup: Subscription | null = null;
  private ownerSearch: Subscription | null = null;

  constructor() {
    const { controls } = this.form;
    // US3-AC14: the plate format depends on the body type, so the plate is revalidated on every change.
    controls.bodyType.valueChanges.pipe(takeUntilDestroyed()).subscribe(() => {
      if (this.editing && this.stored() !== null) {
        // The stored plate was not typed now: its error for the new body type is shown right away.
        controls.plate.markAsTouched();
      }
      controls.plate.updateValueAndValidity();
      this.clearServerError('bodyType');
      this.clearServerError('plate');
    });
    for (const field of DRAFT_TEXT_FIELDS) {
      controls[field].valueChanges.pipe(takeUntilDestroyed()).subscribe(() => this.clearServerError(field));
    }
    controls.plate.valueChanges.pipe(takeUntilDestroyed()).subscribe((value) => this.plateValue.set(value));
    controls.vin.valueChanges.pipe(takeUntilDestroyed()).subscribe((value) => this.vinValue.set(value));
    this.reason.valueChanges.pipe(takeUntilDestroyed()).subscribe(() => this.reasonServerError.set(null));
    this.destroyRef.onDestroy(() => this.loadRequest?.unsubscribe());

    if (this.editing) {
      // Neither the draft nor ?plate= / ?clientId= apply to an existing vehicle.
      this.load();
      return;
    }

    // The draft is restored once; ?plate= and ?clientId= take precedence over it (US3-AC9).
    const draft = readDraft();
    if (draft !== null) {
      this.form.patchValue(draft);
    }
    inject(ActivatedRoute)
      .queryParamMap.pipe(takeUntilDestroyed())
      .subscribe((params) => {
        const plate = params.get('plate');
        if (plate !== null) {
          controls.plate.setValue(normalizePlateForWrite(plate) ?? plate);
        }
        const clientId = params.get('clientId');
        if (clientId !== null && clientId !== '') {
          this.loadOwner(clientId);
        }
      });
  }

  /** Message next to a field: the server's errors[] first, then the validators once touched or after saving. */
  protected errorFor(field: DraftField): string | null {
    const bodyType = this.form.controls.bodyType.value;
    const server = this.serverErrors()[field];
    if (server !== undefined) {
      return fieldErrorMessage(server, { bodyType });
    }
    const control = this.form.controls[field];
    if (!(this.submitted() || control.touched) || control.errors === null) {
      return null;
    }
    const code = Object.keys(control.errors)[0];
    if (code === 'MAX_LENGTH') {
      return `Admite como máximo ${TEXT_MAX_LENGTH} caracteres`;
    }
    return fieldErrorMessage({ field, code, message: 'Valor inválido' }, { bodyType });
  }

  /** Message under the reason: the server's REASON_REQUIRED first, then the local rule after a save attempt. */
  protected reasonError(): string | null {
    const server = this.reasonServerError();
    if (server !== null) {
      return server;
    }
    if (!this.submitted() || !this.identifiersChanged() || this.isReasonValid()) {
      return null;
    }
    return REASON_REQUIRED_MESSAGE;
  }

  protected retryLoad(): void {
    this.load();
  }

  protected ownerErrorMessage(): string | null {
    const server = this.serverErrors().ownerClientId;
    if (server !== undefined) {
      return fieldErrorMessage(server);
    }
    if (this.ownerError() !== null) {
      return this.ownerError();
    }
    return this.submitted() && this.owner() === null && !this.ownerLoading() ? OWNER_REQUIRED : null;
  }

  /** US3-AC2: after leaving the field the user sees the normalized value (unless it has invalid symbols). */
  protected normalizeOnBlur(field: 'plate' | 'vin'): void {
    const control = this.form.controls[field];
    const normalized = field === 'plate' ? normalizePlateForWrite(control.value) : normalizeVin(control.value);
    if (normalized !== null && normalized !== control.value) {
      control.setValue(normalized);
    }
  }

  protected searchOwner(event?: Event): void {
    event?.preventDefault();
    const term = this.ownerTerm.value.trim();
    this.ownerSearch?.unsubscribe();
    this.ownerResults.set(null);
    this.ownerSearchError.set(null);
    if (term.length < MIN_OWNER_SEARCH_LENGTH) {
      this.ownerSearchError.set(OWNER_SEARCH_TOO_SHORT);
      return;
    }
    this.ownerSearching.set(true);
    this.ownerSearch = this.clientsApi.search(term).subscribe({
      next: (response) => {
        this.ownerSearching.set(false);
        this.ownerResults.set({ items: response.items.map(toSummary), hasMore: response.hasMore });
      },
      error: (error: unknown) => {
        this.ownerSearching.set(false);
        this.ownerSearchError.set(isProblem(error) ? problemMessage(error) : OWNER_SEARCH_FAILED);
      },
    });
  }

  protected chooseOwner(client: ClientSummary): void {
    this.setOwner(client);
  }

  protected changeOwner(): void {
    this.owner.set(null);
    this.ownerResults.set(null);
    this.focusOn('owner-search');
  }

  /** "Registrar cliente nuevo" (US3-AC9): keeps what was typed and comes back with ?clientId=. */
  protected registerNewClient(): void {
    const value = this.form.getRawValue();
    const draft: VehicleFormDraft = {
      plate: value.plate,
      vin: value.vin,
      brand: value.brand,
      model: value.model,
      year: value.year,
      color: value.color,
      bodyType: value.bodyType,
      initialMileage: value.initialMileage,
    };
    try {
      sessionStorage.setItem(VEHICLE_FORM_DRAFT_KEY, JSON.stringify(draft));
    } catch {
      // Storage unavailable: the user can still register the client; only the draft is lost.
    }
    void this.router.navigate(['/clients/new'], { queryParams: { returnTo: VEHICLE_FORM_PATH } });
  }

  protected save(): void {
    this.submitted.set(true);
    this.clearNotices();
    const reasonInvalid = this.identifiersChanged() && !this.isReasonValid();
    if (this.form.invalid || this.owner() === null || reasonInvalid) {
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

  private send(body: VehicleCreate | VehicleUpdate): void {
    this.lastBody = body;
    this.saving.set(true);
    const request =
      this.vehicleId !== null && 'version' in body
        ? this.vehiclesApi.update(this.vehicleId, body)
        : this.vehiclesApi.create(body as VehicleCreate);
    request.subscribe({
      next: (detail) => {
        this.saving.set(false);
        removeDraft();
        void this.router.navigate(['/vehicles', detail.id]);
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
      if (error.code === 'PLATE_ALREADY_EXISTS' || error.code === 'VIN_ALREADY_EXISTS') {
        this.duplicate.set({ message: problemMessage(error), existingId: error.existingId ?? null });
        return;
      }
      if (error.code === 'CLIENT_NOT_FOUND') {
        // US3-AC11: the owner no longer exists for this workshop; another one must be chosen.
        this.owner.set(null);
        this.ownerError.set(problemMessage(error, { resource: 'client' }));
        this.focusFirstInvalid();
        return;
      }
      const fieldErrors: Partial<Record<VehicleFormField, FieldError>> = {};
      const reasonError = error.errors?.find((fieldError) => fieldError.field === 'reason');
      if (reasonError !== undefined) {
        this.reasonServerError.set(fieldErrorMessage(reasonError));
      }
      for (const fieldError of error.errors ?? []) {
        const field = SERVER_FIELDS.find((name) => name === fieldError.field);
        if (field !== undefined && fieldErrors[field] === undefined) {
          fieldErrors[field] = fieldError;
        }
      }
      this.serverErrors.set(fieldErrors);
      this.generalError.set(problemMessage(error, { resource: 'vehicle' }));
      if (Object.keys(fieldErrors).length > 0 || reasonError !== undefined) {
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
    if (isVehicleDetail(problem.current)) {
      this.fill(problem.current);
      return;
    }
    this.load(false);
  }

  /** Loads the vehicle to edit; showLoading false keeps the form on screen (reload after a conflict). */
  private load(showLoading = true): void {
    if (this.vehicleId === null) {
      return;
    }
    if (showLoading) {
      this.loadState.set({ kind: 'loading' });
    }
    this.loadRequest?.unsubscribe();
    this.loadRequest = this.vehiclesApi.getById(this.vehicleId).subscribe({
      next: (vehicle) => {
        this.fill(vehicle);
        this.loadState.set({ kind: 'ready' });
      },
      error: (error: unknown) => {
        const notFound = isProblem(error) && error.status === NOT_FOUND_STATUS;
        this.loadState.set({
          kind: 'error',
          message: notFound ? problemMessage(error, { resource: 'vehicle' }) : LOAD_FAILED,
          canRetry: !notFound,
        });
      },
    });
  }

  /** Puts the stored vehicle in the form; the owner is shown read-only and the reason starts empty again. */
  private fill(vehicle: VehicleDetail): void {
    // stored is set after patching, so that the body type change of the patch does not mark the plate as touched.
    this.stored.set(null);
    this.owner.set(vehicle.owner);
    this.submitted.set(false);
    this.form.patchValue({
      bodyType: vehicle.bodyType,
      plate: vehicle.plate,
      vin: vehicle.vin ?? '',
      brand: vehicle.brand,
      model: vehicle.model,
      year: String(vehicle.year),
      color: vehicle.color,
      initialMileage: String(vehicle.initialMileage),
    });
    this.form.markAsUntouched();
    this.stored.set(vehicle);
    this.reason.setValue('');
    this.serverErrors.set({});
    this.reasonServerError.set(null);
  }

  private isReasonValid(): boolean {
    return isReasonAcceptable(this.reason.value, this.reasonRequired);
  }

  /** VehicleUpdate: the loaded version and the editable fields; never ownerClientId nor tenantId. */
  private buildUpdate(): VehicleUpdate {
    const stored = this.stored();
    if (stored === null) {
      throw new Error('The vehicle to edit is not loaded');
    }
    const { plate, vin, brand, model, year, color, bodyType, initialMileage } = this.buildBody();
    const body: VehicleUpdate = {
      version: stored.version,
      plate,
      vin,
      brand,
      model,
      year,
      color,
      bodyType,
      initialMileage,
    };
    if (this.identifiersChanged()) {
      const reason = normalizeReason(this.reason.value);
      if (reason !== null) {
        body.reason = reason;
      }
    }
    return body;
  }

  private buildBody(): VehicleCreate {
    const value = this.form.getRawValue();
    const vin = value.vin.trim();
    return {
      ownerClientId: this.owner()?.id ?? '',
      plate: writePlate(value.plate),
      vin: writeVin(vin),
      brand: value.brand.trim(),
      model: value.model.trim(),
      year: Number(value.year.trim()),
      color: value.color.trim(),
      bodyType: value.bodyType,
      initialMileage: Number(value.initialMileage.trim()),
    };
  }

  /** ?clientId= preselects the owner (for example, back from registering a new client). */
  private loadOwner(clientId: string): void {
    this.ownerLookup?.unsubscribe();
    this.ownerLoading.set(true);
    this.ownerError.set(null);
    this.ownerLookup = this.clientsApi.getById(clientId).subscribe({
      next: (client) => {
        this.ownerLoading.set(false);
        this.setOwner(toSummary(client));
      },
      error: (error: unknown) => {
        this.ownerLoading.set(false);
        this.owner.set(null);
        this.ownerError.set(isProblem(error) ? problemMessage(error, { resource: 'client' }) : OWNER_LOAD_FAILED);
      },
    });
  }

  private setOwner(client: ClientSummary): void {
    this.owner.set(client);
    this.ownerResults.set(null);
    this.ownerSearchError.set(null);
    this.ownerError.set(null);
    this.clearServerError('ownerClientId');
  }

  private clearNotices(): void {
    this.serverErrors.set({});
    this.duplicate.set(null);
    this.networkError.set(false);
    this.generalError.set(null);
    this.versionConflict.set(false);
    this.reasonServerError.set(null);
  }

  private clearServerError(field: VehicleFormField): void {
    const errors = this.serverErrors();
    if (errors[field] !== undefined) {
      const rest = { ...errors };
      delete rest[field];
      this.serverErrors.set(rest);
    }
  }

  /** Keyboard and screen reader users land on the first field to fix. */
  private focusFirstInvalid(): void {
    afterNextRender(
      () => this.host.nativeElement.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus(),
      { injector: this.injector },
    );
  }

  private focusOn(id: string): void {
    afterNextRender(() => this.host.nativeElement.querySelector<HTMLElement>(`#${id}`)?.focus(), {
      injector: this.injector,
    });
  }
}
