import { ChangeDetectionStrategy, Component, output, signal } from '@angular/core';
import {
  DAMAGE_TYPE_LABELS,
  DAMAGE_TYPES,
  type DamageInput,
  type DamageType,
  type ImageUpload,
  type View,
  VIEW_LABELS,
  VIEWS,
} from '../checkin.service';
import { compressPhoto } from '../image-utils';

const MAX_DAMAGES = 20;

/** Damage map: 5 views of the vehicle; each damage has a type, an optional note and an optional compressed photo. */
@Component({
  selector: 'app-damage-map',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './damage-map.component.html',
  styleUrl: './damage-map.component.scss',
})
export class DamageMapComponent {
  readonly damagesChange = output<DamageInput[]>();

  protected readonly views = VIEWS;
  protected readonly viewLabels = VIEW_LABELS;
  protected readonly types = DAMAGE_TYPES;
  protected readonly typeLabels = DAMAGE_TYPE_LABELS;
  protected readonly maxDamages = MAX_DAMAGES;

  protected readonly view = signal<View>('frente');
  protected readonly type = signal<DamageType>('rayon');
  protected readonly note = signal('');
  protected readonly photo = signal<ImageUpload | null>(null);
  protected readonly processing = signal(false);
  protected readonly photoError = signal(false);
  protected readonly damages = signal<DamageInput[]>([]);

  protected countFor(view: View): number {
    return this.damages().filter((d) => d.view === view).length;
  }

  protected onType(event: Event): void {
    const value = (event.target as HTMLSelectElement).value;
    const found = DAMAGE_TYPES.find((t) => t === value);
    if (found !== undefined) {
      this.type.set(found);
    }
  }

  protected onNote(event: Event): void {
    this.note.set((event.target as HTMLInputElement).value);
  }

  protected async onPhoto(input: HTMLInputElement): Promise<void> {
    const file = input.files?.[0];
    this.photoError.set(false);
    this.photo.set(null);
    if (file === undefined) {
      return;
    }
    this.processing.set(true);
    try {
      this.photo.set(await compressPhoto(file));
    } catch {
      this.photoError.set(true);
    } finally {
      this.processing.set(false);
    }
  }

  protected add(photoInput: HTMLInputElement): void {
    if (this.damages().length >= MAX_DAMAGES) {
      return;
    }
    const damage: DamageInput = { view: this.view(), type: this.type() };
    const note = this.note().trim();
    if (note !== '') {
      damage.note = note;
    }
    const photo = this.photo();
    if (photo !== null) {
      damage.photo = photo;
    }
    this.damages.update((list) => [...list, damage]);
    this.note.set('');
    this.photo.set(null);
    photoInput.value = '';
    this.damagesChange.emit(this.damages());
  }

  protected remove(index: number): void {
    this.damages.update((list) => list.filter((_, i) => i !== index));
    this.damagesChange.emit(this.damages());
  }
}
