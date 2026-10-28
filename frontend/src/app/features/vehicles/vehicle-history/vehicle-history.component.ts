import { DatePipe } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { catchError, map, of, startWith, Subject, switchMap, type Observable } from 'rxjs';
import type {
  TimelineEvent,
  TimelineEventKind,
  VehicleClinicalHistory,
} from '../../../core/api/api.models';
import { isProblem, problemMessage } from '../../../core/api/problem';
import { VehiclesApiService } from '../../../core/api/vehicles-api.service';

export type HistoryFilter = 'all' | TimelineEventKind;

export type VehicleHistoryState =
  | { kind: 'loading' }
  | { kind: 'loaded'; history: VehicleClinicalHistory }
  | { kind: 'not-found'; message: string }
  | { kind: 'error' };

const NOT_FOUND_STATUS = 404;
const MILEAGE_FORMAT = new Intl.NumberFormat('es-EC', { maximumFractionDigits: 0 });

export const TIMELINE_KIND_LABELS: Record<TimelineEventKind, string> = {
  checkin: 'Check-in',
  budget: 'Presupuesto',
  work_order: 'Orden de trabajo',
  ownership_transfer: 'Transferencia de propietario',
};

@Component({
  selector: 'app-vehicle-history',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, DatePipe],
  templateUrl: './vehicle-history.component.html',
  styleUrl: './vehicle-history.component.scss',
})
export class VehicleHistoryComponent {
  private readonly api = inject(VehiclesApiService);
  private readonly reload$ = new Subject<void>();

  protected readonly state = signal<VehicleHistoryState>({ kind: 'loading' });
  protected readonly activeFilter = signal<HistoryFilter>('all');
  protected readonly kindLabels = TIMELINE_KIND_LABELS;

  protected readonly filteredTimeline = computed<TimelineEvent[]>(() => {
    const currentState = this.state();
    if (currentState.kind !== 'loaded') {
      return [];
    }
    const filter = this.activeFilter();
    const items = currentState.history.timeline;
    if (filter === 'all') {
      return items;
    }
    return items.filter((event) => event.kind === filter);
  });

  constructor() {
    const id$ = inject(ActivatedRoute).paramMap.pipe(map((params) => params.get('id') ?? ''));
    id$
      .pipe(
        switchMap((id) => this.reload$.pipe(startWith(undefined), switchMap(() => this.load(id)))),
        takeUntilDestroyed(),
      )
      .subscribe((state) => this.state.set(state));
  }

  protected formatMileage(mileage: number): string {
    return MILEAGE_FORMAT.format(mileage);
  }

  protected setFilter(filter: HistoryFilter): void {
    this.activeFilter.set(filter);
  }

  protected retry(): void {
    this.reload$.next();
  }

  protected print(): void {
    window.print();
  }

  protected getLink(event: TimelineEvent): { path: string[]; label: string } | null {
    switch (event.kind) {
      case 'checkin':
        return { path: ['/checkins', event.id], label: 'Ver detalle de check-in' };
      case 'budget':
        return { path: ['/budgets', event.id], label: 'Ver detalle de presupuesto' };
      case 'work_order':
        return { path: ['/work-orders', event.id], label: 'Ver detalle de orden de trabajo' };
      default:
        return null;
    }
  }

  private load(id: string): Observable<VehicleHistoryState> {
    return this.api.getHistory(id).pipe(
      map((history): VehicleHistoryState => ({ kind: 'loaded', history })),
      catchError((error: unknown) =>
        of<VehicleHistoryState>(
          isProblem(error) && error.status === NOT_FOUND_STATUS
            ? { kind: 'not-found', message: problemMessage(error, { resource: 'vehicle' }) }
            : { kind: 'error' },
        ),
      ),
      startWith<VehicleHistoryState>({ kind: 'loading' }),
    );
  }
}
