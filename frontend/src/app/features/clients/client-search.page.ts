import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormControl, ReactiveFormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { catchError, debounceTime, map, type Observable, of, startWith, switchMap } from 'rxjs';
import type { ClientSummary } from '../../core/api/api.models';
import { ClientsApiService } from '../../core/api/clients-api.service';
import { isProblem } from '../../core/api/problem';

/** Research R9: wait 250 ms after the last keystroke before searching. */
export const SEARCH_DEBOUNCE_MS = 250;
const MIN_TERM_LENGTH = 2;

export type ClientSearchState =
  | { kind: 'idle' }
  | { kind: 'too-short' }
  | { kind: 'loading' }
  | { kind: 'results'; items: ClientSummary[]; hasMore: boolean }
  | { kind: 'error' };

/** Client search by document or name (US4-AC1, US4-AC2). */
@Component({
  selector: 'app-client-search-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ReactiveFormsModule, RouterLink],
  templateUrl: './client-search.page.html',
  styleUrl: './client-search.page.scss',
})
export class ClientSearchPage {
  private readonly api = inject(ClientsApiService);

  protected readonly term = new FormControl('', { nonNullable: true });
  protected readonly state = signal<ClientSearchState>({ kind: 'idle' });

  constructor() {
    this.term.valueChanges
      .pipe(
        map((value) => value.trim()),
        debounceTime(SEARCH_DEBOUNCE_MS),
        // switchMap cancels the previous request; errors are caught inside so the stream stays alive.
        switchMap((q) => this.searchState(q)),
        takeUntilDestroyed(),
      )
      .subscribe((state) => this.state.set(state));
  }

  private searchState(q: string): Observable<ClientSearchState> {
    if (q === '') {
      return of({ kind: 'idle' });
    }
    if (q.length < MIN_TERM_LENGTH) {
      return of({ kind: 'too-short' });
    }
    return this.api.search(q).pipe(
      map((response): ClientSearchState => ({ kind: 'results', items: response.items, hasMore: response.hasMore })),
      catchError((error: unknown) =>
        of<ClientSearchState>(
          isProblem(error) && error.code === 'SEARCH_TERM_TOO_SHORT' ? { kind: 'too-short' } : { kind: 'error' },
        ),
      ),
      startWith<ClientSearchState>({ kind: 'loading' }),
    );
  }
}
