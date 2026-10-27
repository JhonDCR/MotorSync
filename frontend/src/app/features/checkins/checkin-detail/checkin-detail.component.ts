import { DatePipe } from '@angular/common';
import { HttpErrorResponse } from '@angular/common/http';
import { ChangeDetectionStrategy, Component, computed, DestroyRef, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { catchError, map, type Observable, of, startWith, switchMap } from 'rxjs';
import {
  type CheckinDamage,
  type CheckinDetail,
  CheckinService,
  DAMAGE_TYPE_LABELS,
  FUEL_LABELS,
  type View,
  VIEW_LABELS,
  VIEWS,
} from '../checkin.service';

type DetailState =
  | { kind: 'loading' }
  | { kind: 'loaded'; checkin: CheckinDetail }
  | { kind: 'not-found' }
  | { kind: 'error' };

const MILEAGE_FORMAT = new Intl.NumberFormat('es-EC', { maximumFractionDigits: 0 });

/** Check-in detail (US2-AC1): data, damages grouped by view, photos and signature loaded as blobs. */
@Component({
  selector: 'app-checkin-detail',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, DatePipe],
  templateUrl: './checkin-detail.component.html',
  styleUrl: '../checkin-page.scss',
})
export class CheckinDetailComponent {
  private readonly api = inject(CheckinService);
  private readonly objectUrls: string[] = [];

  protected readonly state = signal<DetailState>({ kind: 'loading' });
  /** Object URLs by image id. */
  protected readonly images = signal<Record<string, string>>({});
  protected readonly viewLabels = VIEW_LABELS;
  protected readonly typeLabels = DAMAGE_TYPE_LABELS;
  protected readonly fuelLabels = FUEL_LABELS;

  protected readonly groups = computed<{ view: View; damages: CheckinDamage[] }[]>(() => {
    const current = this.state();
    if (current.kind !== 'loaded') {
      return [];
    }
    return VIEWS.map((view) => ({ view, damages: current.checkin.damages.filter((d) => d.view === view) })).filter(
      (group) => group.damages.length > 0,
    );
  });

  constructor() {
    inject(ActivatedRoute)
      .paramMap.pipe(
        map((params) => params.get('id') ?? ''),
        switchMap((id) => this.load(id)),
        takeUntilDestroyed(),
      )
      .subscribe((state) => {
        this.state.set(state);
        if (state.kind === 'loaded') {
          this.loadImages(state.checkin);
        }
      });
    inject(DestroyRef).onDestroy(() => this.objectUrls.forEach((url) => URL.revokeObjectURL(url)));
  }

  protected formatMileage(mileage: number): string {
    return MILEAGE_FORMAT.format(mileage);
  }

  private load(id: string): Observable<DetailState> {
    return this.api.getById(id).pipe(
      map((checkin): DetailState => ({ kind: 'loaded', checkin })),
      catchError((error: unknown) =>
        of<DetailState>(
          error instanceof HttpErrorResponse && error.status === 404 ? { kind: 'not-found' } : { kind: 'error' },
        ),
      ),
      startWith<DetailState>({ kind: 'loading' }),
    );
  }

  private loadImages(checkin: CheckinDetail): void {
    const ids = [
      checkin.signatureImageId,
      ...checkin.damages.map((d) => d.photoImageId).filter((id): id is string => id !== null),
    ];
    for (const imageId of ids) {
      this.api.getImage(checkin.id, imageId).subscribe({
        next: (blob) => {
          const url = URL.createObjectURL(blob);
          this.objectUrls.push(url);
          this.images.update((all) => ({ ...all, [imageId]: url }));
        },
        error: () => undefined,
      });
    }
  }
}
