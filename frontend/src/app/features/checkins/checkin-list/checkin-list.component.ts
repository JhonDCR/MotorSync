import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { catchError, map, type Observable, of, startWith, Subject, switchMap } from 'rxjs';
import { CheckinService, type CheckinSummary } from '../checkin.service';

type ListState = { kind: 'loading' } | { kind: 'loaded'; items: CheckinSummary[] } | { kind: 'error' };

const MILEAGE_FORMAT = new Intl.NumberFormat('es-EC', { maximumFractionDigits: 0 });

/** Check-in history of a vehicle, in the server order (newest first) (US2-AC1). */
@Component({
  selector: 'app-checkin-list',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, DatePipe],
  templateUrl: './checkin-list.component.html',
  styleUrl: '../checkin-page.scss',
})
export class CheckinListComponent {
  private readonly api = inject(CheckinService);
  private readonly reload$ = new Subject<void>();

  protected readonly vehicleId = signal('');
  protected readonly state = signal<ListState>({ kind: 'loading' });

  constructor() {
    inject(ActivatedRoute)
      .paramMap.pipe(
        map((params) => params.get('id') ?? ''),
        switchMap((id) => {
          this.vehicleId.set(id);
          return this.reload$.pipe(
            startWith(undefined),
            switchMap(() => this.load(id)),
          );
        }),
        takeUntilDestroyed(),
      )
      .subscribe((state) => this.state.set(state));
  }

  protected formatMileage(mileage: number): string {
    return MILEAGE_FORMAT.format(mileage);
  }

  protected retry(): void {
    this.reload$.next();
  }

  private load(id: string): Observable<ListState> {
    return this.api.list(id).pipe(
      map((items): ListState => ({ kind: 'loaded', items })),
      catchError(() => of<ListState>({ kind: 'error' })),
      startWith<ListState>({ kind: 'loading' }),
    );
  }
}
