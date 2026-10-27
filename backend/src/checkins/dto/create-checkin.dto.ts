import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsDefined,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Length,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { IMAGE_MIMES, type ImageMime } from '../image.util.js';

export const FUEL_LEVELS = ['vacio', '1/4', '1/2', '3/4', 'lleno'] as const;
export type FuelLevel = (typeof FUEL_LEVELS)[number];
export const VIEWS = ['frente', 'atras', 'izquierda', 'derecha', 'arriba'] as const;
export type View = (typeof VIEWS)[number];
export const DAMAGE_TYPES = ['rayon', 'golpe', 'abolladura', 'rotura', 'faltante', 'otro'] as const;
export type DamageType = (typeof DAMAGE_TYPES)[number];

/** Contract `ImageUpload`. */
export class ImageUploadDto {
  @IsDefined()
  @IsIn(IMAGE_MIMES)
  mime!: ImageMime;

  @IsDefined()
  @IsString()
  base64!: string;
}

/** Contract `DamageInput`. */
export class DamageInputDto {
  @IsDefined()
  @IsIn(VIEWS)
  view!: View;

  @IsDefined()
  @IsIn(DAMAGE_TYPES)
  type!: DamageType;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => ImageUploadDto)
  photo?: ImageUploadDto;
}

/** Contract `CheckinCreate` (additionalProperties: false, enforced by forbidNonWhitelisted). */
export class CreateCheckinDto {
  @IsDefined()
  @IsInt()
  @Min(0)
  mileage!: number;

  @IsDefined()
  @IsIn(FUEL_LEVELS)
  fuelLevel!: FuelLevel;

  @IsDefined()
  @IsString()
  @Length(1, 1000)
  reason!: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(30)
  @IsString({ each: true })
  @Length(1, 100, { each: true })
  inventory?: string[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => DamageInputDto)
  damages?: DamageInputDto[];

  @IsDefined()
  @ValidateNested()
  @Type(() => ImageUploadDto)
  signature!: ImageUploadDto;
}
