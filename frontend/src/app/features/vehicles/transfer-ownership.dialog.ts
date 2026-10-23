import { HttpErrorResponse } from '@angular/common/http';
import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  inject,
  Injector,
  input,
  linkedSignal,
  output,
  signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormControl, ReactiveFormsModule } from '@angular/forms';
import type { Subscription } from 'rxjs';
import type { ClientSummary, OwnershipTransferRequest, Problem, VehicleDetail } from '../../core/api/api.models';
import { ClientsApiService } from '../../core/api/clients-api.service';
import { fieldErrorMessage, isProblem, problemMessage } from '../../core/api/problem';
import { VehiclesApiService } from '../../core/api/vehicles-api.service';
import { readCurrentSession } from '../../core/auth/current-session';
import {
  isReasonAcceptable,
  isReasonRequired,
  normalizeReason,
  REASON_MAX_LENGTH,
  REASON_REQUIRED_MESSAGE,
} from '../../shared/validators/reason';

type Step = 'form' | 'confirm';

const MIN_SEARCH_LENGTH = 2;
const SEARCH_TOO_SHORT = 'Escriba al menos 2 caracteres';
const SEARCH_FAILED = 'No se pudo buscar clientes. Revise la conexión e inténtelo de nuevo';
const CLIENT_REQUIRED = 'Elija el cliente al que se transfiere el vehículo';
const VERSION_CONFLICT_MESSAGE =
  'El registro cambió: otra persona modificó este vehículo. Revise el propietario actual y vuelva a confirmar';
const NETWORK_ERROR = 'No se pudo conectar con el servidor. Inténtelo de nuevo';
const UNEXPECTED_ERROR = 'No se pudo transferir el vehículo. Inténtelo de nuevo';
const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select, [tabindex="0"]';

let nextId = 0;

function isVehicleDetail(value: Problem['current']): value is VehicleDetail {
  return value !== undefined && 'plate' in value;
}

/**
 * Ownership transfer (US4-AC7 to AC9, FR-018): choose the destination client with the client search, give the
 * reason the role requires (FR-019) and confirm explicitly. Modal dialog: initial focus, focus kept inside and
 * Escape to cancel.
 */
@Component({
  selector: 'app-transfer-ownership-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ReactiveFormsModule],
  templateUrl: './transfer-ownership.dialog.html',
  styleUrl: './transfer-ownership.dialog.scss',
})
export class TransferOwnershipDialog {
  private readonly clientsApi = inject(ClientsApiService);
  private readonly vehiclesApi = inject(VehiclesApiService);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly injector = inject(Injector);

  readonly vehicle = input.required<VehicleDetail>();
  readonly transferred = output<VehicleDetail>();
  readonly cancelled = output<void>();

  protected readonly titleId = `transfer-title-${++nextId}`;
  /** UI only (FR-019): the backend decides with the verified token. Without a session the asesor rule applies. */
  protected readonly reasonRequired = isReasonRequired(readCurrentSession());
  protected readonly reasonMaxLength = REASON_MAX_LENGTH;

  protected readonly searchTerm = new FormControl('', { nonNullable: true });
  protected readonly reason = new FormControl('', { nonNullable: true });

  /** Owner and version shown and sent; a 409 replaces them with the current ones (US4-AC12). */
  protected readonly currentOwner = linkedSignal(() => this.vehicle().owner);
  private readonly version = linkedSignal(() => this.vehicle().version);

  protected readonly step = signal<Step>('form');
  protected readonly searching = signal(false);
  protected readonly results = signal<{ items: ClientSummary[]; hasMore: boolean } | null>(null);
  protected readonly searchError = signal<string | null>(null);
  protected readonly selected = signal<ClientSummary | null>(null);
  protected readonly submitted = signal(false);
  protected readonly saving = signal(false);
  protected readonly operationError = signal<string | null>(null);
  protected readonly reasonServerError = signal<string | null>(null);

  private search: Subscription | null = null;
  private transfer: Subscription | null = null;

  constructor() {
    this.reason.valueChanges.pipe(takeUntilDestroyed()).subscribe(() => this.reasonServerError.set(null));
    inject(DestroyRef).onDestroy(() => {
      this.search?.unsubscribe();
      this.transfer?.unsubscribe();
    });
    this.focus('#transfer-search');
  }

  protected clientError(): string | null {
    return this.submitted() && this.selected() === null ? CLIENT_REQUIRED : null;
  }

  protected reasonError(): string | null {
    const server = this.reasonServerError();
    if (server !== null) {
      return server;
    }
    return this.submitted() && !this.isReasonValid() ? REASON_REQUIRED_MESSAGE : null;
  }

  /** The reason as it will be sent (trimmed), or null when omitted. */
  protected reasonToSend(): string | null {
    return normalizeReason(this.reason.value);
  }

  protected searchClients(event?: Event): void {
    event?.preventDefault();
    const term = this.searchTerm.value.trim();
    this.search?.unsubscribe();
    this.results.set(null);
    this.searchError.set(null);
    if (term.length < MIN_SEARCH_LENGTH) {
      this.searchError.set(SEARCH_TOO_SHORT);
      return;
    }
    this.searching.set(true);
    this.search = this.clientsApi.search(term).subscribe({
      next: (response) => {
        this.searching.set(false);
        this.results.set({ items: response.items, hasMore: response.hasMore });
      },
      error: (error: unknown) => {
        this.searching.set(false);
        this.searchError.set(isProblem(error) ? problemMessage(error) : SEARCH_FAILED);
      },
    });
  }

  protected choose(client: ClientSummary): void {
    this.selected.set(client);
    this.results.set(null);
    this.operationError.set(null);
    this.focus('[data-testid="transfer-change-client"]');
  }

  protected changeClient(): void {
    this.selected.set(null);
    this.focus('#transfer-search');
  }

  /** Validates the destination and the reason, then asks for the explicit confirmation (FR-018). */
  protected continue(): void {
    this.submitted.set(true);
    this.operationError.set(null);
    if (this.selected() === null) {
      this.focus('#transfer-search');
      return;
    }
    if (!this.isReasonValid()) {
      this.focus('#transfer-reason');
      return;
    }
    this.step.set('confirm');
    this.focus('[data-testid="transfer-confirm"]');
  }

  protected back(): void {
    this.step.set('form');
    this.focus('#transfer-reason');
  }

  protected cancel(): void {
    this.transfer?.unsubscribe();
    this.cancelled.emit();
  }

  protected confirm(): void {
    const target = this.selected();
    if (target === null || this.saving()) {
      return;
    }
    const body: OwnershipTransferRequest = { newOwnerClientId: target.id, version: this.version() };
    const reason = this.reasonToSend();
    if (reason !== null) {
      body.reason = reason;
    }
    this.saving.set(true);
    this.transfer = this.vehiclesApi.transferOwnership(this.vehicle().id, body).subscribe({
      next: (vehicle) => {
        this.saving.set(false);
        this.transferred.emit(vehicle);
      },
      error: (error: unknown) => {
        this.saving.set(false);
        this.handleError(error);
      },
    });
  }

  /** Keeps Tab and Shift+Tab inside the dialog while it is open. */
  protected trapFocus(event: KeyboardEvent): void {
    if (event.key !== 'Tab') {
      return;
    }
    const focusable = Array.from(this.host.nativeElement.querySelectorAll<HTMLElement>(FOCUSABLE));
    if (focusable.length === 0) {
      return;
    }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active = document.activeElement;
    if (event.shiftKey && active === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  }

  /** After any error the dialog goes back to the form keeping the destination and the reason. */
  private handleError(error: unknown): void {
    this.step.set('form');
    if (isProblem(error)) {
      if (error.code === 'VERSION_CONFLICT') {
        if (isVehicleDetail(error.current)) {
          this.version.set(error.current.version);
          this.currentOwner.set(error.current.owner);
        }
        this.operationError.set(VERSION_CONFLICT_MESSAGE);
      } else {
        const reasonError = error.errors?.find((fieldError) => fieldError.field === 'reason');
        if (reasonError !== undefined) {
          this.reasonServerError.set(fieldErrorMessage(reasonError));
          this.focus('#transfer-reason');
          return;
        }
        this.operationError.set(problemMessage(error, { resource: 'vehicle' }));
      }
    } else {
      this.operationError.set(error instanceof HttpErrorResponse && error.status === 0 ? NETWORK_ERROR : UNEXPECTED_ERROR);
    }
    this.focus('[data-testid="transfer-error"]');
  }

  private isReasonValid(): boolean {
    return isReasonAcceptable(this.reason.value, this.reasonRequired);
  }

  private focus(selector: string): void {
    afterNextRender(() => this.host.nativeElement.querySelector<HTMLElement>(selector)?.focus(), {
      injector: this.injector,
    });
  }
}
