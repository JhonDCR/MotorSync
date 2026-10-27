import { DatePipe } from '@angular/common';
import { HttpErrorResponse } from '@angular/common/http';
import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { workOrderErrorMessage, WorkOrderService } from '../../work-orders/work-order.service';
import { catchError, map, type Observable, of, startWith, switchMap } from 'rxjs';
import {
  type BudgetDetail,
  budgetErrorMessage,
  BudgetService,
  LINE_KIND_LABELS,
} from '../budget.service';

type DetailState =
  | { kind: 'loading' }
  | { kind: 'loaded'; budget: BudgetDetail }
  | { kind: 'not-found' }
  | { kind: 'error' };

type Transition = 'send' | 'approve' | 'reject';

/** Budget detail with amounts and the actions allowed by its status (US2-AC1, US3-AC1). */
@Component({
  selector: 'app-budget-detail',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, DatePipe],
  templateUrl: './budget-detail.component.html',
  styleUrl: '../budget-page.scss',
})
export class BudgetDetailComponent {
  private readonly api = inject(BudgetService);
  private readonly workOrders = inject(WorkOrderService);
  private readonly router = inject(Router);

  protected readonly kindLabels = LINE_KIND_LABELS;
  protected readonly state = signal<DetailState>({ kind: 'loading' });
  protected readonly busy = signal(false);
  protected readonly actionError = signal<string | null>(null);

  constructor() {
    inject(ActivatedRoute)
      .paramMap.pipe(
        map((params) => params.get('id') ?? ''),
        switchMap((id) => this.load(id)),
        takeUntilDestroyed(),
      )
      .subscribe((state) => this.state.set(state));
  }

  protected run(budget: BudgetDetail, transition: Transition): void {
    if (this.busy()) {
      return;
    }
    this.busy.set(true);
    this.actionError.set(null);
    this.api[transition](budget.id).subscribe({
      next: (updated) => {
        this.busy.set(false);
        this.state.set({ kind: 'loaded', budget: updated });
      },
      error: (err: unknown) => {
        this.busy.set(false);
        this.actionError.set(budgetErrorMessage(err));
      },
    });
  }

  protected createWorkOrder(budget: BudgetDetail): void {
    if (this.busy()) {
      return;
    }
    this.busy.set(true);
    this.actionError.set(null);
    this.workOrders.create(budget.id).subscribe({
      next: (order) => {
        this.busy.set(false);
        void this.router.navigate(['/work-orders', order.id]);
      },
      error: (err: unknown) => {
        this.busy.set(false);
        this.actionError.set(workOrderErrorMessage(err));
      },
    });
  }

  private load(id: string): Observable<DetailState> {
    return this.api.getById(id).pipe(
      map((budget): DetailState => ({ kind: 'loaded', budget })),
      catchError((error: unknown) =>
        of<DetailState>(
          error instanceof HttpErrorResponse && error.status === 404
            ? { kind: 'not-found' }
            : { kind: 'error' },
        ),
      ),
      startWith<DetailState>({ kind: 'loading' }),
    );
  }
}
