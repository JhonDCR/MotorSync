import { HttpErrorResponse } from '@angular/common/http';
import { afterNextRender, ChangeDetectionStrategy, Component, ElementRef, inject, Injector, signal } from '@angular/core';
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
import type { BodyType, ClientDetail, ClientSummary, FieldError, VehicleCreate } from '../../core/api/api.models';
import { ClientsApiService } from '../../core/api/clients-api.service';
import { fieldErrorMessage, isProblem, problemMessage } from '../../core/api/problem';
import { VehiclesApiService } from '../../core/api/vehicles-api.service';
import { isBodyType, normalizePlateForWrite } from '../../shared/identifiers/plate';
import { normalizeVin } from '../../shared/identifiers/vin';
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

/** New vehicle (US3): owner, Ecuadorian plate by body type, optional VIN, year and initial mileage. */
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

  /** Last body sent: "Reintentar" resends exactly the same data. */
  private lastBody: VehicleCreate | null = null;
  private ownerLookup: Subscription | null = null;
  private ownerSearch: Subscription | null = null;

  constructor() {
    const { controls } = this.form;
    // US3-AC14: the plate format depends on the body type, so the plate is revalidated on every change.
    controls.bodyType.valueChanges.pipe(takeUntilDestroyed()).subscribe(() => {
      controls.plate.updateValueAndValidity();
      this.clearServerError('bodyType');
      this.clearServerError('plate');
    });
    for (const field of DRAFT_TEXT_FIELDS) {
      controls[field].valueChanges.pipe(takeUntilDestroyed()).subscribe(() => this.clearServerError(field));
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
    if (this.form.invalid || this.owner() === null) {
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

  private send(body: VehicleCreate): void {
    this.lastBody = body;
    this.saving.set(true);
    this.vehiclesApi.create(body).subscribe({
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
      for (const fieldError of error.errors ?? []) {
        const field = SERVER_FIELDS.find((name) => name === fieldError.field);
        if (field !== undefined && fieldErrors[field] === undefined) {
          fieldErrors[field] = fieldError;
        }
      }
      this.serverErrors.set(fieldErrors);
      this.generalError.set(problemMessage(error, { resource: 'vehicle' }));
      if (Object.keys(fieldErrors).length > 0) {
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

  private buildBody(): VehicleCreate {
    const value = this.form.getRawValue();
    const vin = value.vin.trim();
    return {
      ownerClientId: this.owner()?.id ?? '',
      plate: normalizePlateForWrite(value.plate) ?? value.plate,
      vin: vin === '' ? null : (normalizeVin(vin) ?? vin),
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
