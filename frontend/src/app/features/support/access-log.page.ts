import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  inject,
  type OnInit,
  signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router } from '@angular/router';
import type { AccessLogEntry } from '../../core/api/api.models';
import { isProblem, problemMessage } from '../../core/api/problem';
import { SupportApiService } from '../../core/api/support-api.service';
import { NETWORK_ERROR_MESSAGE } from '../auth/auth-form';
import { formatSupportDateTime } from './support-format';

/**
 * Read-only platform support access log (US4, FR-027).
 */
@Component({
  selector: 'app-access-log-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [],
  templateUrl: './access-log.page.html',
  styleUrl: './access-log.page.scss',
})
export class AccessLogPage implements OnInit {
  private readonly api = inject(SupportApiService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly entries = signal<readonly AccessLogEntry[]>([]);
  protected readonly loading = signal(true);
  protected readonly error = signal<string | null>(null);

  protected readonly workshopId = signal<string | null>(null);
  protected readonly agentId = signal<string | null>(null);
  protected readonly page = signal(1);
  protected readonly total = signal(0);
  protected readonly pageSize = signal(50);

  protected readonly totalPages = computed(() =>
    Math.max(1, Math.ceil(this.total() / this.pageSize())),
  );

  ngOnInit(): void {
    this.route.queryParamMap
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((params) => {
        const wsId = params.get('workshopId');
        const agId = params.get('agentId');
        const pageParam = Number(params.get('page'));

        this.workshopId.set(wsId || null);
        this.agentId.set(agId || null);
        this.page.set(pageParam >= 1 ? pageParam : 1);

        this.loadLog();
      });
  }

  protected formatDate(iso: string): string {
    return formatSupportDateTime(iso);
  }

  protected channelLabel(channel: string): string {
    return channel === 'support_panel' ? 'Panel de soporte' : channel;
  }

  protected filterByWorkshop(id: string): void {
    this.router.navigate([], {
      relativeTo: this.route,
      queryParams: { workshopId: id, page: null },
      queryParamsHandling: 'merge',
    });
  }

  protected filterByAgent(id: string): void {
    this.router.navigate([], {
      relativeTo: this.route,
      queryParams: { agentId: id, page: null },
      queryParamsHandling: 'merge',
    });
  }

  protected removeWorkshopFilter(): void {
    this.router.navigate([], {
      relativeTo: this.route,
      queryParams: { workshopId: null, page: null },
      queryParamsHandling: 'merge',
    });
  }

  protected removeAgentFilter(): void {
    this.router.navigate([], {
      relativeTo: this.route,
      queryParams: { agentId: null, page: null },
      queryParamsHandling: 'merge',
    });
  }

  protected goToPage(newPage: number): void {
    if (newPage < 1 || newPage > this.totalPages()) return;
    this.router.navigate([], {
      relativeTo: this.route,
      queryParams: { page: newPage > 1 ? newPage : null },
      queryParamsHandling: 'merge',
    });
  }

  private loadLog(): void {
    this.loading.set(true);
    this.error.set(null);

    const filters = {
      workshopId: this.workshopId() ?? undefined,
      agentId: this.agentId() ?? undefined,
      page: this.page() > 1 ? this.page() : undefined,
    };

    this.api
      .listAccessLog(filters)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (response) => {
          this.entries.set(response.items);
          this.total.set(response.total);
          this.page.set(response.page);
          this.pageSize.set(response.pageSize);
          this.loading.set(false);
        },
        error: (err: unknown) => {
          this.loading.set(false);
          this.error.set(isProblem(err) ? problemMessage(err) : NETWORK_ERROR_MESSAGE);
        },
      });
  }
}
