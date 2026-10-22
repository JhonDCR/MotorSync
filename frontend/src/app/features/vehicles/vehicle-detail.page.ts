import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { catchError, map, type Observable, of, startWith, Subject, switchMap } from 'rxjs';
import type { VehicleDetail } from '../../core/api/api.models';
import { isProblem, problemMessage } from '../../core/api/problem';
import { VehiclesApiService } from '../../core/api/vehicles-api.service';
import { BODY_TYPE_LABELS } from './body-type';

export type VehicleDetailState =
  | { kind: 'loading' }
  | { kind: 'loaded'; vehicle: VehicleDetail }
  | { kind: 'not-found'; message: string }
  | { kind: 'error' };

const NOT_FOUND_STATUS = 404;
const MILEAGE_FORMAT = new Intl.NumberFormat('es-EC', { maximumFractionDigits: 0 });

/** Vehicle card: vehicle data, current owner and last modification (US3-AC1, FR-017). */
@Component({
  selector: 'app-vehicle-detail-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, DatePipe],
  templateUrl: './vehicle-detail.page.html',
  styleUrl: './vehicle-detail.page.scss',
})
export class VehicleDetailPage {
  private readonly api = inject(VehiclesApiService);
  private readonly reload$ = new Subject<void>();

  protected readonly state = signal<VehicleDetailState>({ kind: 'loading' });
  protected readonly bodyTypeLabels = BODY_TYPE_LABELS;

  constructor() {
    inject(ActivatedRoute)
      .paramMap.pipe(
        map((params) => params.get('id') ?? ''),
        // A new id cancels the previous load; "Reintentar" reloads the current id.
        switchMap((id) => this.reload$.pipe(startWith(undefined), switchMap(() => this.load(id)))),
        takeUntilDestroyed(),
      )
      .subscribe((state) => this.state.set(state));
  }

  /** Thousands separator of Ecuador (45.000). */
  protected formatMileage(mileage: number): string {
    return MILEAGE_FORMAT.format(mileage);
  }

  protected retry(): void {
    this.reload$.next();
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
}
