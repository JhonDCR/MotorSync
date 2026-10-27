import { HttpErrorResponse } from '@angular/common/http';
import { ChangeDetectionStrategy, Component, DestroyRef, inject, signal } from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import {
  CheckinService,
  type DamageInput,
  FUEL_LABELS,
  FUEL_LEVELS,
  type FuelLevel,
  type ImageUpload,
} from '../checkin.service';
import { DamageMapComponent } from '../damage-map/damage-map.component';
import { SignaturePadComponent } from '../signature-pad/signature-pad.component';

type FieldName = 'mileage' | 'fuelLevel' | 'reason' | 'signature' | 'inventory';

const MILEAGE_FORMAT = new Intl.NumberFormat('es-EC', { maximumFractionDigits: 0 });
const MAX_INVENTORY = 30;
const MAX_ITEM = 100;
const MAX_REASON = 1000;

/** New check-in of a vehicle (US1): mileage, fuel, reason, inventory, damages and the client's signature. */
@Component({
  selector: 'app-checkin-form',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, DamageMapComponent, SignaturePadComponent],
  templateUrl: './checkin-form.component.html',
  styleUrl: '../checkin-page.scss',
})
export class CheckinFormComponent {
  private readonly api = inject(CheckinService);
  private readonly router = inject(Router);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly vehicleId = inject(ActivatedRoute).snapshot.paramMap.get('id') ?? '';
  protected readonly fuelLevels = FUEL_LEVELS;
  protected readonly fuelLabels = FUEL_LABELS;

  protected readonly mileage = signal('');
  protected readonly fuelLevel = signal('');
  protected readonly reason = signal('');
  protected readonly inventory = signal('');
  protected readonly signature = signal<ImageUpload | null>(null);
  protected readonly damages = signal<DamageInput[]>([]);

  protected readonly errors = signal<Partial<Record<FieldName, string>>>({});
  protected readonly saving = signal(false);
  protected readonly lastMileage = signal<string | null>(null);
  protected readonly saveError = signal<string | null>(null);

  protected value(event: Event): string {
    return (event.target as HTMLInputElement).value;
  }

  protected onSigned(signature: ImageUpload | null): void {
    this.signature.set(signature);
  }

  protected save(event: Event): void {
    event.preventDefault();
    if (this.saving()) {
      return;
    }
    const errors: Partial<Record<FieldName, string>> = {};
    const mileageText = this.mileage().trim();
    const mileage = Number(mileageText);
    if (mileageText === '' || !Number.isInteger(mileage) || mileage < 0) {
      errors.mileage = 'Ingrese un kilometraje entero mayor o igual a 0';
    }
    const fuel = FUEL_LEVELS.find((level): level is FuelLevel => level === this.fuelLevel());
    if (fuel === undefined) {
      errors.fuelLevel = 'Seleccione el nivel de combustible';
    }
    const reason = this.reason().trim();
    if (reason === '' || reason.length > MAX_REASON) {
      errors.reason = 'El motivo es obligatorio (hasta 1000 caracteres)';
    }
    const inventory = this.inventory()
      .split('\n')
      .map((item) => item.trim())
      .filter((item) => item !== '');
    if (inventory.length > MAX_INVENTORY || inventory.some((item) => item.length > MAX_ITEM)) {
      errors.inventory = 'Hasta 30 objetos, de hasta 100 caracteres cada uno';
    }
    const signature = this.signature();
    if (signature === null) {
      errors.signature = 'La firma del cliente es obligatoria';
    }
    this.errors.set(errors);
    this.lastMileage.set(null);
    this.saveError.set(null);
    if (Object.keys(errors).length > 0 || fuel === undefined || signature === null) {
      return;
    }

    this.saving.set(true);
    const subscription = this.api
      .create(this.vehicleId, {
        mileage,
        fuelLevel: fuel,
        reason,
        inventory,
        damages: this.damages(),
        signature,
      })
      .subscribe({
        next: (created) => {
          this.saving.set(false);
          void this.router.navigate(['/checkins', created.id]);
        },
        error: (error: unknown) => {
          this.saving.set(false);
          this.handleError(error);
        },
      });
    this.destroyRef.onDestroy(() => subscription.unsubscribe());
  }

  private handleError(error: unknown): void {
    const body: unknown = error instanceof HttpErrorResponse ? error.error : null;
    const status = error instanceof HttpErrorResponse ? error.status : 0;
    if (status === 409 && typeof body === 'object' && body !== null && 'lastMileage' in body) {
      const last = body.lastMileage;
      if (typeof last === 'number') {
        this.lastMileage.set(MILEAGE_FORMAT.format(last));
        return;
      }
    }
    if (status === 404) {
      this.saveError.set('No se encontró el vehículo');
    } else if (status === 400 || status === 422) {
      this.saveError.set('Revise los datos del formulario');
    } else {
      this.saveError.set('No se pudo guardar el check-in. Revise la conexión e inténtelo de nuevo');
    }
  }
}
