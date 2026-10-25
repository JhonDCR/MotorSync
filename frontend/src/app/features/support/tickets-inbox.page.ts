import { ChangeDetectionStrategy, Component, DestroyRef, inject, type OnInit, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { RouterLink } from '@angular/router';
import type { Role, TicketSummary, UserStatus } from '../../core/api/api.models';
import { isProblem, problemMessage } from '../../core/api/problem';
import { SupportApiService } from '../../core/api/support-api.service';
import { NETWORK_ERROR_MESSAGE } from '../auth/auth-form';
import { ACCOUNT_ROLE_LABELS, ACCOUNT_STATUS_LABELS, formatSupportDateTime } from './support-format';

/**
 * Open tickets inbox for support agents (US2, FR-009).
 */
@Component({
  selector: 'app-tickets-inbox-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink],
  templateUrl: './tickets-inbox.page.html',
  styleUrl: './tickets-inbox.page.scss',
})
export class TicketsInboxPage implements OnInit {
  private readonly api = inject(SupportApiService);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly tickets = signal<readonly TicketSummary[]>([]);
  protected readonly loading = signal(true);
  protected readonly error = signal<string | null>(null);

  ngOnInit(): void {
    this.loadTickets();
  }

  protected formatDate(iso: string): string {
    return formatSupportDateTime(iso);
  }

  protected roleLabel(role: Role): string {
    return ACCOUNT_ROLE_LABELS[role];
  }

  protected statusLabel(status: UserStatus): string {
    return ACCOUNT_STATUS_LABELS[status];
  }

  private loadTickets(): void {
    this.loading.set(true);
    this.error.set(null);
    this.api
      .listOpenTickets()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (response) => {
          this.tickets.set(response.items);
          this.loading.set(false);
        },
        error: (err: unknown) => {
          this.loading.set(false);
          this.error.set(isProblem(err) ? problemMessage(err) : NETWORK_ERROR_MESSAGE);
        },
      });
  }
}
