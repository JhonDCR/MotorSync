import { ChangeDetectionStrategy, Component, DestroyRef, inject, type OnInit, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import type { Role, TicketDetail, TicketStatus, UserStatus } from '../../core/api/api.models';
import { fieldErrorMessage, isProblem, problemMessage } from '../../core/api/problem';
import { SupportApiService } from '../../core/api/support-api.service';
import { SUPPORT_HOME_PATH } from '../../core/support/support.guards';
import { NETWORK_ERROR_MESSAGE } from '../auth/auth-form';
import {
  ACCOUNT_ROLE_LABELS,
  ACCOUNT_STATUS_LABELS,
  formatSupportDateTime,
  TICKET_STATUS_LABELS,
} from './support-format';

const REQUIRED_MESSAGE = fieldErrorMessage({ field: '', code: 'REQUIRED', message: '' });

/**
 * Ticket detail and discard action for support agents (US2, FR-009, FR-012).
 */
@Component({
  selector: 'app-ticket-detail-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink],
  templateUrl: './ticket-detail.page.html',
  styleUrl: './ticket-detail.page.scss',
})
export class TicketDetailPage implements OnInit {
  private readonly api = inject(SupportApiService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly ticket = signal<TicketDetail | null>(null);
  protected readonly loading = signal(true);
  protected readonly error = signal<string | null>(null);

  protected readonly discardReason = signal('');
  protected readonly discardReasonError = signal<string | null>(null);
  protected readonly discardError = signal<string | null>(null);
  protected readonly discarding = signal(false);

  ngOnInit(): void {
    const paramMap = this.route.snapshot.paramMap;
    const id = paramMap.get('id') ?? paramMap.get('ticketId') ?? '';
    this.loadTicket(id);
  }

  protected formatDate(iso: string): string {
    return formatSupportDateTime(iso);
  }

  protected ticketStatusLabel(status: TicketStatus): string {
    return TICKET_STATUS_LABELS[status];
  }

  protected roleLabel(role: Role): string {
    return ACCOUNT_ROLE_LABELS[role];
  }

  protected accountStatusLabel(status: UserStatus): string {
    return ACCOUNT_STATUS_LABELS[status];
  }

  protected updateDiscardReason(event: Event): void {
    const value = (event.target as HTMLTextAreaElement | HTMLInputElement).value;
    this.discardReason.set(value);
    if (this.discardReasonError() !== null) {
      this.discardReasonError.set(null);
    }
  }

  protected submitDiscard(event: Event): void {
    event.preventDefault();
    if (this.discarding()) return;
    const currentTicket = this.ticket();
    if (!currentTicket || currentTicket.status !== 'open') return;

    this.discardError.set(null);
    const trimmed = this.discardReason().trim();
    if (trimmed === '') {
      this.discardReasonError.set(REQUIRED_MESSAGE);
      return;
    }

    this.discardReasonError.set(null);
    this.discarding.set(true);
    this.api
      .discardTicket(currentTicket.id, trimmed)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: () => {
          this.discarding.set(false);
          void this.router.navigateByUrl(SUPPORT_HOME_PATH);
        },
        error: (err: unknown) => {
          this.discarding.set(false);
          if (!isProblem(err)) {
            this.discardError.set(NETWORK_ERROR_MESSAGE);
            return;
          }
          if (err.code === 'VALIDATION_ERROR') {
            const reasonFieldErr = err.errors?.find((e) => e.field === 'reason');
            if (reasonFieldErr) {
              this.discardReasonError.set(fieldErrorMessage(reasonFieldErr));
              return;
            }
          }
          this.discardError.set(problemMessage(err));
        },
      });
  }

  private loadTicket(id: string): void {
    this.loading.set(true);
    this.error.set(null);
    this.api
      .getTicket(id)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (ticket) => {
          this.ticket.set(ticket);
          this.loading.set(false);
        },
        error: (err: unknown) => {
          this.loading.set(false);
          this.error.set(isProblem(err) ? problemMessage(err) : NETWORK_ERROR_MESSAGE);
        },
      });
  }
}
