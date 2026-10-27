import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { RouterLink } from '@angular/router';
import { BehaviorSubject, catchError, map, type Observable, of, startWith, switchMap } from 'rxjs';
import {
  WORK_ORDER_STATUSES,
  WorkOrderService,
  type WorkOrderStatus,
  type WorkOrderSummary,
} from '../work-order.service';

type BoardState =
  | { kind: 'loading' }
  | { kind: 'loaded'; orders: WorkOrderSummary[] }
  | { kind: 'error' };

/** Workshop board of work orders with a status filter (US3-AC1). */
@Component({
  selector: 'app-work-order-board',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink],
  templateUrl: './work-order-board.component.html',
  styleUrl: '../../budgets/budget-page.scss',
})
export class WorkOrderBoardComponent {
  private readonly api = inject(WorkOrderService);
  private readonly filter = new BehaviorSubject<WorkOrderStatus | undefined>(undefined);

  protected readonly statuses = WORK_ORDER_STATUSES;
  protected readonly state = signal<BoardState>({ kind: 'loading' });

  constructor() {
    this.filter
      .pipe(
        switchMap((status) => this.load(status)),
        takeUntilDestroyed(),
      )
      .subscribe((state) => this.state.set(state));
  }

  protected onFilter(event: Event): void {
    const value = (event.target as HTMLSelectElement).value;
    this.filter.next(WORK_ORDER_STATUSES.find((s) => s === value));
  }

  private load(status: WorkOrderStatus | undefined): Observable<BoardState> {
    return this.api.list(status).pipe(
      map((orders): BoardState => ({ kind: 'loaded', orders })),
      catchError(() => of<BoardState>({ kind: 'error' })),
      startWith<BoardState>({ kind: 'loading' }),
    );
  }
}
