import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormControl, ReactiveFormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { catchError, debounceTime, map, type Observable, of, startWith, switchMap } from 'rxjs';
import type { BodyType, VehicleSearchItem } from '../../core/api/api.models';
import { isProblem } from '../../core/api/problem';
import { VehiclesApiService } from '../../core/api/vehicles-api.service';
import { isValidPlate, normalizePlateForSearch } from '../../shared/identifiers/plate';
import { BODY_TYPE_LABELS } from './body-type';

/** Research R9: wait 250 ms after the last keystroke before searching. */
export const VEHICLE_SEARCH_DEBOUNCE_MS = 250;
const MIN_TERM_LENGTH = 2;
/** Contract `q`: maxLength 40. */
export const VEHICLE_SEARCH_MAX_LENGTH = 40;
const MILEAGE_FORMAT = new Intl.NumberFormat('es-EC', { maximumFractionDigits: 0 });

export type VehicleSearchState =
  | { kind: 'idle' }
  | { kind: 'too-short' }
  | { kind: 'loading' }
  | { kind: 'results'; items: VehicleSearchItem[]; hasMore: boolean; registerPlate: string | null }
  | { kind: 'error' };

/** A normalized term shaped like a full car or motorcycle plate can be offered for registration (US1-AC6). */
function asFullPlate(term: string): string | null {
  return isValidPlate(term, 'sedan') || isValidPlate(term, 'motorcycle') ? term : null;
}

/** Start screen: vehicle search by full or partial plate, or full VIN (US1, FR-026). */
@Component({
  selector: 'app-vehicle-search-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ReactiveFormsModule, RouterLink],
  templateUrl: './vehicle-search.page.html',
  styleUrl: './vehicle-search.page.scss',
})
export class VehicleSearchPage {
  private readonly api = inject(VehiclesApiService);

  protected readonly maxLength = VEHICLE_SEARCH_MAX_LENGTH;
  protected readonly term = new FormControl('', { nonNullable: true });
  protected readonly state = signal<VehicleSearchState>({ kind: 'idle' });

  constructor() {
    this.term.valueChanges
      .pipe(
        debounceTime(VEHICLE_SEARCH_DEBOUNCE_MS),
        // switchMap cancels the previous request; errors are caught inside so the stream stays alive.
        switchMap((raw) => this.searchState(raw)),
        takeUntilDestroyed(),
      )
      .subscribe((state) => this.state.set(state));
  }

  protected bodyTypeLabel(bodyType: BodyType): string {
    return BODY_TYPE_LABELS[bodyType];
  }

  /** Thousands separator of Ecuador (45.200), as the vehicle card. */
  protected formatMileage(mileage: number): string {
    return MILEAGE_FORMAT.format(mileage);
  }

  private searchState(raw: string): Observable<VehicleSearchState> {
    if (raw.trim() === '') {
      return of({ kind: 'idle' });
    }
    const q = normalizePlateForSearch(raw);
    if (q.length < MIN_TERM_LENGTH) {
      return of({ kind: 'too-short' });
    }
    return this.api.search(q).pipe(
      map(
        (response): VehicleSearchState => ({
          kind: 'results',
          items: response.items,
          hasMore: response.hasMore,
          registerPlate: response.items.length === 0 ? asFullPlate(q) : null,
        }),
      ),
      catchError((error: unknown) =>
        of<VehicleSearchState>(
          isProblem(error) && error.code === 'SEARCH_TERM_TOO_SHORT' ? { kind: 'too-short' } : { kind: 'error' },
        ),
      ),
      startWith<VehicleSearchState>({ kind: 'loading' }),
    );
  }
}
