import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  inject,
  type OnInit,
  signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute, RouterLink } from '@angular/router';
import type { Role, UserStatus, WorkshopAccount, WorkshopSummary } from '../../core/api/api.models';
import { isProblem, problemMessage } from '../../core/api/problem';
import { SupportApiService } from '../../core/api/support-api.service';
import { NETWORK_ERROR_MESSAGE } from '../auth/auth-form';
import { ACCOUNT_ROLE_LABELS, ACCOUNT_STATUS_LABELS, formatSupportDateTime } from './support-format';

/**
 * Accounts of one workshop for support agents (US4, FR-016).
 */
@Component({
  selector: 'app-workshop-accounts-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink],
  templateUrl: './workshop-accounts.page.html',
  styleUrl: './workshop-accounts.page.scss',
})
export class WorkshopAccountsPage implements OnInit {
  private readonly api = inject(SupportApiService);
  private readonly route = inject(ActivatedRoute);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly workshop = signal<WorkshopSummary | null>(null);
  protected readonly accounts = signal<readonly WorkshopAccount[]>([]);
  protected readonly loading = signal(true);
  protected readonly notFound = signal(false);
  protected readonly error = signal<string | null>(null);

  ngOnInit(): void {
    const id = this.route.snapshot.paramMap.get('id') ?? '';
    this.loadAccounts(id);
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

  private loadAccounts(workshopId: string): void {
    this.loading.set(true);
    this.error.set(null);
    this.notFound.set(false);

    this.api
      .listWorkshopAccounts(workshopId)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (response) => {
          this.workshop.set(response.workshop);
          this.accounts.set(response.items);
          this.loading.set(false);
        },
        error: (err: unknown) => {
          this.loading.set(false);
          if (isProblem(err) && (err.status === 404 || err.code === 'NOT_FOUND')) {
            this.notFound.set(true);
          } else {
            this.error.set(isProblem(err) ? problemMessage(err) : NETWORK_ERROR_MESSAGE);
          }
        },
      });
  }
}
