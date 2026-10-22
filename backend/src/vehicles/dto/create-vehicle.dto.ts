import { Transform, type TransformFnParams } from 'class-transformer';
import {
  IsDefined,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { BODY_TYPES, normalizePlateForWrite, type BodyType } from '../../common/identifiers/plate.js';
import { normalizeVin } from '../../common/identifiers/vin.js';
import { IsEcPlate } from '../../common/validation/is-ec-plate.js';
import { IsVehicleYear } from '../../common/validation/is-vehicle-year.js';
import { IsVin } from '../../common/validation/is-vin.js';

export const MAX_INITIAL_MILEAGE = 9_999_999;

const REQUIRED = 'Campo obligatorio';
const MUST_BE_TEXT = 'Debe ser texto';
const MILEAGE_MESSAGE = `Kilometraje inválido: entero entre 0 y ${MAX_INITIAL_MILEAGE}`;
const MILEAGE = { message: MILEAGE_MESSAGE, context: { code: 'INVALID_MILEAGE' } };

/** Applies `fn` to strings only; other values reach the validators untouched. */
function onString(fn: (value: string) => string): (params: TransformFnParams) => unknown {
  return ({ value }: TransformFnParams): unknown => (typeof value === 'string' ? fn(value) : value);
}

const trim = (value: string): string => value.trim();

/**
 * Plate and VIN are normalized before validation (FR-002). When a character other than letters,
 * digits, whitespace or hyphens remains, the raw value is kept so that the format validator
 * rejects it (INVALID_PLATE / INVALID_VIN) instead of cleaning it silently (US3-AC14).
 */
const plateForWrite = (value: string): string => normalizePlateForWrite(value) ?? value;
const vinForWrite = (value: string): string => normalizeVin(value) ?? value;

/** Contract `VehicleCreate` (additionalProperties: false, enforced by forbidNonWhitelisted). */
export class CreateVehicleDto {
  /** FR-014: exactly one current owner, a client of the same tenant (checked under RLS). */
  @IsDefined({ message: REQUIRED })
  @IsUUID(undefined, { message: 'Identificador de cliente inválido' })
  ownerClientId: string;

  /** Validated against the format of `bodyType` (FR-007). */
  @Transform(onString(plateForWrite))
  @IsDefined({ message: REQUIRED })
  @IsString({ message: MUST_BE_TEXT, context: { code: 'INVALID_PLATE' } })
  @IsEcPlate('bodyType')
  plate: string;

  /** Optional and nullable (US3-AC6). */
  @Transform(onString(vinForWrite))
  @IsOptional()
  @IsString({ message: MUST_BE_TEXT, context: { code: 'INVALID_VIN' } })
  @IsVin()
  vin?: string | null;

  @Transform(onString(trim))
  @IsDefined({ message: REQUIRED })
  @IsString({ message: MUST_BE_TEXT })
  @IsNotEmpty({ message: REQUIRED })
  @MaxLength(60, { message: 'La marca admite como máximo 60 caracteres' })
  brand: string;

  @Transform(onString(trim))
  @IsDefined({ message: REQUIRED })
  @IsString({ message: MUST_BE_TEXT })
  @IsNotEmpty({ message: REQUIRED })
  @MaxLength(60, { message: 'El modelo admite como máximo 60 caracteres' })
  model: string;

  @IsDefined({ message: REQUIRED })
  @IsVehicleYear()
  year: number;

  @Transform(onString(trim))
  @IsDefined({ message: REQUIRED })
  @IsString({ message: MUST_BE_TEXT })
  @IsNotEmpty({ message: REQUIRED })
  @MaxLength(60, { message: 'El color admite como máximo 60 caracteres' })
  color: string;

  @IsDefined({ message: REQUIRED })
  @IsIn(BODY_TYPES, {
    message: 'Carrocería inválida: sedan, suv, pickup, motorcycle u other',
  })
  bodyType: BodyType;

  @IsDefined({ message: REQUIRED })
  @IsInt(MILEAGE)
  @Min(0, MILEAGE)
  @Max(MAX_INITIAL_MILEAGE, MILEAGE)
  initialMileage: number;
}
