import { DatePipe } from '@angular/common';
import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  inject,
  Injector,
  signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { catchError, map, type Observable, of, startWith, Subject, switchMap } from 'rxjs';
import type { OwnershipChange, VehicleDetail } from '../../core/api/api.models';
import { isProblem, problemMessage } from '../../core/api/problem';
import { VehiclesApiService } from '../../core/api/vehicles-api.service';
import { BODY_TYPE_LABELS } from './body-type';
import { TransferOwnershipDialog } from './transfer-ownership.dialog';

export type VehicleDetailState =
  | { kind: 'loading' }
  | { kind: 'loaded'; vehicle: VehicleDetail }
  | { kind: 'not-found'; message: string }
  | { kind: 'error' };

export type OwnershipHistoryState =
  | { kind: 'loading' }
  | { kind: 'loaded'; items: OwnershipChange[] }
  | { kind: 'error' };

const NOT_FOUND_STATUS = 404;
const MILEAGE_FORMAT = new Intl.NumberFormat('es-EC', { maximumFractionDigits: 0 });

/**
 * Vehicle card: vehicle data, current owner and last modification (US3-AC1, FR-017), plus the read-only
 * ownership history and the access to edit and to transfer the ownership (US4).
 */
@Component({
  selector: 'app-vehicle-detail-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, DatePipe, TransferOwnershipDialog],
  templateUrl: './vehicle-detail.page.html',
  styleUrl: './vehicle-detail.page.scss',
})
export class VehicleDetailPage {
  private readonly api = inject(VehiclesApiService);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly injector = inject(Injector);
  private readonly reload$ = new Subject<void>();
  private readonly reloadHistory$ = new Subject<void>();

  protected readonly state = signal<VehicleDetailState>({ kind: 'loading' });
  protected readonly history = signal<OwnershipHistoryState>({ kind: 'loading' });
  protected readonly transferOpen = signal(false);
  protected readonly bodyTypeLabels = BODY_TYPE_LABELS;

  constructor() {
    const id$ = inject(ActivatedRoute).paramMap.pipe(map((params) => params.get('id') ?? ''));
    id$
      .pipe(
        // A new id cancels the previous load; "Reintentar" reloads the current id.
        switchMap((id) => this.reload$.pipe(startWith(undefined), switchMap(() => this.load(id)))),
        takeUntilDestroyed(),
      )
      .subscribe((state) => this.state.set(state));
    id$
      .pipe(
        // A failed history does not hide the card; after a transfer the history is requested again.
        switchMap((id) => this.reloadHistory$.pipe(startWith(undefined), switchMap(() => this.loadHistory(id)))),
        takeUntilDestroyed(),
      )
      .subscribe((history) => this.history.set(history));
  }

  /** Thousands separator of Ecuador (45.000). */
  protected formatMileage(mileage: number): string {
    return MILEAGE_FORMAT.format(mileage);
  }

  protected retry(): void {
    this.reload$.next();
    this.reloadHistory$.next();
  }

  protected openTransfer(): void {
    this.transferOpen.set(true);
  }

  protected onTransferred(vehicle: VehicleDetail): void {
    this.closeTransfer();
    this.state.set({ kind: 'loaded', vehicle });
    this.reloadHistory$.next();
  }

  protected closeTransfer(): void {
    this.transferOpen.set(false);
    // Focus goes back to the button that opened the dialog.
    afterNextRender(
      () => this.host.nativeElement.querySelector<HTMLElement>('[data-testid="transfer-ownership"]')?.focus(),
      { injector: this.injector },
    );
  }

  private load(id: string): Observable<VehicleDetailState> {
    return this.api.getById(id).pipe(
      map((vehicle): VehicleDetailState => ({ kind: 'loaded', vehicle })),
      catchError((error: unknown) =>
        of<VehicleDetailState>(
          isProblem(error) && error.status === NOT_FOUND_STATUS
            ? { kind: 'not-found', message: problemMessage(error, { resource: 'vehicle' }) }
            : { kind: 'error' },
        ),
      ),
      startWith<VehicleDetailState>({ kind: 'loading' }),
    );
  }

  private loadHistory(id: string): Observable<OwnershipHistoryState> {
    return this.api.getOwnershipHistory(id).pipe(
      map((response): OwnershipHistoryState => ({ kind: 'loaded', items: response.items })),
      catchError(() => of<OwnershipHistoryState>({ kind: 'error' })),
      startWith<OwnershipHistoryState>({ kind: 'loading' }),
    );
  }
}
