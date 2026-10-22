import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { catchError, map, type Observable, of, startWith, Subject, switchMap } from 'rxjs';
import type { ClientDetail } from '../../core/api/api.models';
import { ClientsApiService } from '../../core/api/clients-api.service';
import { isProblem, problemMessage } from '../../core/api/problem';

export type ClientDetailState =
  | { kind: 'loading' }
  | { kind: 'loaded'; client: ClientDetail }
  | { kind: 'not-found'; message: string }
  | { kind: 'error' };

const NOT_FOUND_STATUS = 404;

/** Client card: contact data, vehicles and last modification (US4-AC3, FR-017). */
@Component({
  selector: 'app-client-detail-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, DatePipe],
  templateUrl: './client-detail.page.html',
  styleUrl: './client-detail.page.scss',
})
export class ClientDetailPage {
  private readonly api = inject(ClientsApiService);
  private readonly reload$ = new Subject<void>();

  protected readonly state = signal<ClientDetailState>({ kind: 'loading' });

  constructor() {
    inject(ActivatedRoute)
      .paramMap.pipe(
        map((params) => params.get('id') ?? ''),
        // A new id cancels the previous load; "Reintentar" reloads the current id.
        switchMap((id) => this.reload$.pipe(startWith(undefined), switchMap(() => this.load(id)))),
        takeUntilDestroyed(),
      )
      .subscribe((state) => this.state.set(state));
  }

  protected retry(): void {
    this.reload$.next();
  }

  private load(id: string): Observable<ClientDetailState> {
    return this.api.getById(id).pipe(
      map((client): ClientDetailState => ({ kind: 'loaded', client })),
      catchError((error: unknown) =>
        of<ClientDetailState>(
          isProblem(error) && error.status === NOT_FOUND_STATUS
            ? { kind: 'not-found', message: problemMessage(error, { resource: 'client' }) }
            : { kind: 'error' },
        ),
      ),
      startWith<ClientDetailState>({ kind: 'loading' }),
    );
  }
}
