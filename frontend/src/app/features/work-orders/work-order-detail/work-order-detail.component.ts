import { DatePipe } from '@angular/common';
import { HttpErrorResponse } from '@angular/common/http';
import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { catchError, map, type Observable, of, startWith, switchMap } from 'rxjs';
import { SessionStore } from '../../../core/auth/session.store';
import {
  type WorkOrderDetail,
  workOrderErrorMessage,
  WorkOrderService,
  type WorkOrderStatus,
} from '../work-order.service';

type DetailState =
  | { kind: 'loading' }
  | { kind: 'loaded'; order: WorkOrderDetail }
  | { kind: 'not-found' }
  | { kind: 'error' };

type Transition = 'start' | 'finish' | 'deliver';

const ACTIONS: Record<WorkOrderStatus, readonly Transition[]> = {
  abierta: ['start'],
  en_proceso: ['finish'],
  terminada: ['deliver'],
  entregada: [],
  cancelada: [],
};

/** Work order detail: status actions, cancellation with reason, notes and history (US2). */
@Component({
  selector: 'app-work-order-detail',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, DatePipe],
  templateUrl: './work-order-detail.component.html',
  styleUrl: '../../budgets/budget-page.scss',
})
export class WorkOrderDetailComponent {
  private readonly api = inject(WorkOrderService);
  private readonly session = inject(SessionStore);

  protected readonly state = signal<DetailState>({ kind: 'loading' });
  protected readonly busy = signal(false);
  protected readonly actionError = signal<string | null>(null);
  protected readonly cancelling = signal(false);
  protected readonly cancelReason = signal('');
  protected readonly noteBody = signal('');
  protected readonly assigneeId = signal('');
  protected readonly isAdmin = computed(() => this.session.user()?.role === 'admin');

  constructor() {
    inject(ActivatedRoute)
      .paramMap.pipe(
        map((params) => params.get('id') ?? ''),
        switchMap((id) => this.load(id)),
        takeUntilDestroyed(),
      )
      .subscribe((state) => this.state.set(state));
  }

  protected can(order: WorkOrderDetail, action: Transition): boolean {
    return ACTIONS[order.status].includes(action);
  }

  protected canCancel(order: WorkOrderDetail): boolean {
    return order.status === 'abierta' || order.status === 'en_proceso';
  }

  protected isClosed(order: WorkOrderDetail): boolean {
    return order.status === 'entregada' || order.status === 'cancelada';
  }

  protected valueOf(event: Event): string {
    return (event.target as HTMLInputElement).value;
  }

  protected run(order: WorkOrderDetail, transition: Transition): void {
    this.execute(this.api[transition](order.id));
  }

  protected confirmCancel(order: WorkOrderDetail): void {
    const reason = this.cancelReason().trim();
    if (reason !== '') {
      this.execute(this.api.cancel(order.id, reason), () => {
        this.cancelling.set(false);
        this.cancelReason.set('');
      });
    }
  }

  protected addNote(order: WorkOrderDetail): void {
    const body = this.noteBody().trim();
    if (body !== '') {
      this.execute(this.api.addNote(order.id, body), () => this.noteBody.set(''));
    }
  }

  protected reassign(order: WorkOrderDetail): void {
    const userId = this.assigneeId().trim();
    if (userId !== '') {
      this.execute(this.api.reassign(order.id, userId), () => this.assigneeId.set(''));
    }
  }

  private execute(request: Observable<WorkOrderDetail>, done?: () => void): void {
    if (this.busy()) {
      return;
    }
    this.busy.set(true);
    this.actionError.set(null);
    request.subscribe({
      next: (order) => {
        this.busy.set(false);
        this.state.set({ kind: 'loaded', order });
        done?.();
      },
      error: (err: unknown) => {
        this.busy.set(false);
        this.actionError.set(workOrderErrorMessage(err));
      },
    });
  }

  private load(id: string): Observable<DetailState> {
    return this.api.getById(id).pipe(
      map((order): DetailState => ({ kind: 'loaded', order })),
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
