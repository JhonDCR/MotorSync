import { HttpErrorResponse } from '@angular/common/http';
import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import {
  budgetErrorMessage,
  BudgetService,
  computeTotals,
  LINE_KIND_LABELS,
  LINE_KINDS,
  type LineInput,
  type LineKind,
  toHundredths,
} from '../budget.service';

interface DraftLine extends LineInput {
  key: number;
}

type TextField = 'description' | 'quantity' | 'unitPrice';

/** Create (checkins/:id/budgets/new) or edit a draft (budgets/:id/edit) (US1-AC1, US1-AC3, US2-AC2). */
@Component({
  selector: 'app-budget-form',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink],
  templateUrl: './budget-form.component.html',
  styleUrl: '../budget-page.scss',
})
export class BudgetFormComponent {
  private readonly api = inject(BudgetService);
  private readonly router = inject(Router);
  private nextKey = 1;

  protected readonly kinds = LINE_KINDS;
  protected readonly kindLabels = LINE_KIND_LABELS;
  protected readonly mode = signal<'new' | 'edit'>('new');
  protected readonly id = signal('');
  protected readonly loading = signal(false);
  protected readonly saving = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly lines = signal<DraftLine[]>([]);
  protected readonly totals = computed(() => computeTotals(this.lines()));
  protected readonly valid = computed(
    () =>
      this.lines().length > 0 &&
      this.lines().every(
        (l) =>
          l.description.trim() !== '' &&
          toHundredths(l.quantity) !== null &&
          toHundredths(l.unitPrice) !== null,
      ),
  );

  constructor() {
    const route = inject(ActivatedRoute);
    route.paramMap.pipe(takeUntilDestroyed()).subscribe((params) => {
      const id = params.get('id') ?? '';
      const edit = route.snapshot.routeConfig?.path?.endsWith('/edit') ?? false;
      this.id.set(id);
      this.mode.set(edit ? 'edit' : 'new');
      if (edit) {
        this.load(id);
      }
    });
  }

  protected addLine(): void {
    this.lines.update((all) => [
      ...all,
      { key: this.nextKey++, kind: 'mano_obra', description: '', quantity: '1', unitPrice: '' },
    ]);
  }

  protected removeLine(key: number): void {
    this.lines.update((all) => all.filter((l) => l.key !== key));
  }

  protected setKind(key: number, event: Event): void {
    const value = (event.target as HTMLSelectElement).value;
    const kind = LINE_KINDS.find((k): k is LineKind => k === value);
    if (kind !== undefined) {
      this.patch(key, { kind });
    }
  }

  protected setField(key: number, field: TextField, event: Event): void {
    this.patch(key, { [field]: (event.target as HTMLInputElement).value });
  }

  protected save(): void {
    if (!this.valid() || this.saving()) {
      return;
    }
    const body = {
      lines: this.lines().map(({ kind, description, quantity, unitPrice }) => ({
        kind,
        description: description.trim(),
        quantity: quantity.trim(),
        unitPrice: unitPrice.trim(),
      })),
    };
    const request =
      this.mode() === 'edit' ? this.api.update(this.id(), body) : this.api.create(this.id(), body);
    this.saving.set(true);
    this.error.set(null);
    request.subscribe({
      next: (budget) => {
        this.saving.set(false);
        void this.router.navigate(['/budgets', budget.id]);
      },
      error: (err: unknown) => {
        this.saving.set(false);
        this.error.set(budgetErrorMessage(err));
      },
    });
  }

  private patch(key: number, change: Partial<LineInput>): void {
    this.lines.update((all) => all.map((l) => (l.key === key ? { ...l, ...change } : l)));
  }

  private load(id: string): void {
    this.loading.set(true);
    this.api.getById(id).subscribe({
      next: (budget) => {
        this.loading.set(false);
        this.lines.set(
          budget.lines.map(({ kind, description, quantity, unitPrice }) => ({
            key: this.nextKey++,
            kind,
            description,
            quantity,
            unitPrice,
          })),
        );
      },
      error: (err: unknown) => {
        this.loading.set(false);
        this.error.set(
          err instanceof HttpErrorResponse && err.status === 404
            ? 'Presupuesto no encontrado.'
            : budgetErrorMessage(err),
        );
      },
    });
  }
}
