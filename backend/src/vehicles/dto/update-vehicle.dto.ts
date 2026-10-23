import { Transform } from 'class-transformer';
import {
  IsDefined,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { BODY_TYPES, type BodyType } from '../../common/identifiers/plate.js';
import { IsEcPlate } from '../../common/validation/is-ec-plate.js';
import { IsVehicleYear } from '../../common/validation/is-vehicle-year.js';
import { IsVin } from '../../common/validation/is-vin.js';
import { IfPresent, onString, trim } from '../../common/validation/transforms.js';
import {
  MAX_INITIAL_MILEAGE,
  MILEAGE,
  MUST_BE_TEXT,
  plateForWrite,
  REQUIRED,
  vinForWrite,
} from './create-vehicle.dto.js';

/**
 * Contract `VehicleUpdate` (additionalProperties: false, enforced by forbidNonWhitelisted, so
 * ownerClientId, tenantId or any other key is 400 UNKNOWN_FIELD: the owner only changes through
 * ownership-transfers). Only the sent fields change. The plate is validated here against bodyType
 * when both are sent; the service revalidates it against the resulting body type (US3-AC14).
 */
export class UpdateVehicleDto {
  /** Optimistic lock (research R5): the version the user edited. */
  @IsDefined({ message: REQUIRED })
  @IsInt({ message: 'La versión debe ser un entero' })
  @Min(1, { message: 'La versión debe ser mayor o igual a 1' })
  version: number;

  @Transform(onString(plateForWrite))
  @IfPresent()
  @IsString({ message: MUST_BE_TEXT, context: { code: 'INVALID_PLATE' } })
  @IsEcPlate('bodyType')
  plate?: string;

  /** Nullable: null removes the VIN (audited as vehicle.vin_changed). */
  @Transform(onString(vinForWrite))
  @IsOptional()
  @IsString({ message: MUST_BE_TEXT, context: { code: 'INVALID_VIN' } })
  @IsVin()
  vin?: string | null;

  @Transform(onString(trim))
  @IfPresent()
  @IsString({ message: MUST_BE_TEXT })
  @IsNotEmpty({ message: REQUIRED })
  @MaxLength(60, { message: 'La marca admite como máximo 60 caracteres' })
  brand?: string;

  @Transform(onString(trim))
  @IfPresent()
  @IsString({ message: MUST_BE_TEXT })
  @IsNotEmpty({ message: REQUIRED })
  @MaxLength(60, { message: 'El modelo admite como máximo 60 caracteres' })
  model?: string;

  @IfPresent()
  @IsVehicleYear()
  year?: number;

  @Transform(onString(trim))
  @IfPresent()
  @IsString({ message: MUST_BE_TEXT })
  @IsNotEmpty({ message: REQUIRED })
  @MaxLength(60, { message: 'El color admite como máximo 60 caracteres' })
  color?: string;

  @IfPresent()
  @IsIn(BODY_TYPES, {
    message: 'Carrocería inválida: sedan, suv, pickup, motorcycle u other',
  })
  bodyType?: BodyType;

  @IfPresent()
  @IsInt(MILEAGE)
  @Min(0, MILEAGE)
  @Max(MAX_INITIAL_MILEAGE, MILEAGE)
  initialMileage?: number;

  /**
   * Required by role when the plate or the VIN changes (FR-019). Its length (10 to 500 after
   * trim) is decided by reason-policy, so that an empty or blank reason counts as omitted.
   */
  @IsOptional()
  @IsString({ message: MUST_BE_TEXT })
  reason?: string | null;
}
