import { Transform, Type } from 'class-transformer';
import {
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { MUST_BE_TEXT } from '../../auth/dto/register.dto.js';
import { onString, trim } from '../../common/validation/transforms.js';

/** Contract `GET /support/workshops.q`: 1 to 120 characters. */
export const WORKSHOP_QUERY_MAX_LENGTH = 120;

/** Contract `GET /support/workshops` and `GET /support/access-log`: fixed page size. */
export const SUPPORT_PAGE_SIZE = 50;

/**
 * Contract `GET /support/workshops` (US4-AC1, US4-AC2): `q` searches by RUC prefix or by part of
 * the commercial name and `page` is an integer greater than or equal to 1. The service decides
 * which search applies; the DTO only bounds the input.
 */
export class ListWorkshopsDto {
  /** RUC with or without spaces/dashes, or part of the commercial name. Trimmed. */
  @Transform(onString(trim))
  @IsOptional()
  @IsString({ message: MUST_BE_TEXT })
  @MinLength(1, { message: 'La búsqueda debe tener al menos 1 carácter' })
  @MaxLength(WORKSHOP_QUERY_MAX_LENGTH, {
    message: 'La búsqueda admite como máximo 120 caracteres',
  })
  q?: string;

  /** 1-based page number. Fixed page size of 50. */
  @Type(() => Number)
  @IsOptional()
  @IsInt({ message: 'La página debe ser un entero' })
  @Min(1, { message: 'La página debe ser mayor o igual a 1' })
  page: number = 1;
}
