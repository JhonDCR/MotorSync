import type { BodyType } from '../../core/api/api.models';

/** Spanish labels of the body types (US3-AC8). */
export const BODY_TYPE_LABELS: Readonly<Record<BodyType, string>> = {
  sedan: 'Sedán',
  suv: 'SUV',
  pickup: 'Pickup',
  motorcycle: 'Moto',
  other: 'Otro',
};

const SELECTOR_ORDER: readonly BodyType[] = ['sedan', 'suv', 'pickup', 'motorcycle', 'other'];

/** Options of the body type selector, in the order of US3-AC8 (Sedán first, the default). */
export const BODY_TYPE_OPTIONS: readonly { value: BodyType; label: string }[] = SELECTOR_ORDER.map((value) => ({
  value,
  label: BODY_TYPE_LABELS[value],
}));
