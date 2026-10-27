import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { catchError, map, type Observable, of, startWith, Subject, switchMap } from 'rxjs';
import { BudgetService, type BudgetSummary } from '../budget.service';

type ListState =
  { kind: 'loading' } | { kind: 'loaded'; items: BudgetSummary[] } | { kind: 'error' };

/** Budgets of a vehicle (vehicles/:id/budgets) or a check-in (checkins/:id/budgets), server order (US3-AC1). */
@Component({
  selector: 'app-budget-list',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, DatePipe],
  templateUrl: './budget-list.component.html',
  styleUrl: '../budget-page.scss',
})
export class BudgetListComponent {
  private readonly api = inject(BudgetService);
  private readonly reload$ = new Subject<void>();

  protected readonly scope = signal<'vehicles' | 'checkins'>('vehicles');
  protected readonly ownerId = signal('');
  protected readonly state = signal<ListState>({ kind: 'loading' });

  constructor() {
    const route = inject(ActivatedRoute);
    route.paramMap
      .pipe(
        map((params) => params.get('id') ?? ''),
        switchMap((id) => {
          const scope = route.snapshot.routeConfig?.path?.startsWith('checkins')
            ? 'checkins'
            : 'vehicles';
          this.scope.set(scope);
          this.ownerId.set(id);
          return this.reload$.pipe(
            startWith(undefined),
            switchMap(() => this.load(scope, id)),
          );
        }),
        takeUntilDestroyed(),
      )
      .subscribe((state) => this.state.set(state));
  }

  protected retry(): void {
    this.reload$.next();
  }

  private load(scope: 'vehicles' | 'checkins', id: string): Observable<ListState> {
    const request = scope === 'checkins' ? this.api.listByCheckin(id) : this.api.listByVehicle(id);
    return request.pipe(
      map((items): ListState => ({ kind: 'loaded', items })),
      catchError(() => of<ListState>({ kind: 'error' })),
      startWith<ListState>({ kind: 'loading' }),
    );
  }
}
