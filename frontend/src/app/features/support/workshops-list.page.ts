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
import { RouterLink } from '@angular/router';
import type { WorkshopSummary } from '../../core/api/api.models';
import { isProblem, problemMessage } from '../../core/api/problem';
import { SupportApiService } from '../../core/api/support-api.service';
import { NETWORK_ERROR_MESSAGE } from '../auth/auth-form';
import { formatSupportDateTime } from './support-format';

/**
 * Workshops list and search for support agents (US4, FR-016).
 */
@Component({
  selector: 'app-workshops-list-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink],
  templateUrl: './workshops-list.page.html',
  styleUrl: './workshops-list.page.scss',
})
export class WorkshopsListPage implements OnInit {
  private readonly api = inject(SupportApiService);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly workshops = signal<readonly WorkshopSummary[]>([]);
  protected readonly loading = signal(true);
  protected readonly error = signal<string | null>(null);
  protected readonly query = signal('');
  protected readonly page = signal(1);
  protected readonly total = signal(0);
  protected readonly pageSize = signal(50);

  protected readonly totalPages = computed(() =>
    Math.max(1, Math.ceil(this.total() / this.pageSize())),
  );

  ngOnInit(): void {
    this.loadWorkshops();
  }

  protected onQueryInput(event: Event): void {
    const input = event.target as HTMLInputElement;
    this.query.set(input.value);
  }

  protected onSearch(event?: Event): void {
    event?.preventDefault();
    this.page.set(1);
    this.loadWorkshops();
  }

  protected goToPage(newPage: number): void {
    if (newPage < 1 || newPage > this.totalPages()) return;
    this.page.set(newPage);
    this.loadWorkshops();
  }

  protected formatDate(iso: string): string {
    return formatSupportDateTime(iso);
  }

  private loadWorkshops(): void {
    this.loading.set(true);
    this.error.set(null);
    const q = this.query().trim() || undefined;
    const pageNum = this.page();

    this.api
      .listWorkshops(q, pageNum)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (response) => {
          this.workshops.set(response.items);
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
