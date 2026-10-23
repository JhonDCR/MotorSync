import { Transform } from 'class-transformer';
import { IsDefined, IsNotEmpty, IsString, MaxLength, MinLength } from 'class-validator';
import { normalizeDocument } from '../../common/identifiers/normalize.js';
import { IsEcDocument } from '../../common/validation/is-ec-document.js';
import { IsEmailNormalized } from '../../common/validation/is-email-normalized.js';
import { IsPassword } from '../../common/validation/is-password.js';
import { onString, trim } from '../../common/validation/transforms.js';

export const REQUIRED = 'Campo obligatorio';
export const MUST_BE_TEXT = 'Debe ser texto';
export const NAME_MIN_LENGTH = 2;
export const NAME_MAX_LENGTH = 120;

/**
 * Contract `RegisterRequest` (additionalProperties: false, enforced by forbidNonWhitelisted):
 * `tenantId` or `role` give 400 UNKNOWN_FIELD (US1-AC9).
 */
export class RegisterDto {
  /** Trade name, trimmed; 2 to 120 characters. */
  @Transform(onString(trim))
  @IsDefined({ message: REQUIRED })
  @IsString({ message: MUST_BE_TEXT })
  @IsNotEmpty({ message: REQUIRED })
  @MinLength(NAME_MIN_LENGTH, { message: 'El nombre comercial debe tener al menos 2 caracteres' })
  @MaxLength(NAME_MAX_LENGTH, { message: 'El nombre comercial admite como máximo 120 caracteres' })
  workshopName: string;

  /** Normalized without whitespace or hyphens, then validated as in the 001 (FR-002). */
  @Transform(onString(normalizeDocument))
  @IsDefined({ message: REQUIRED })
  @IsEcDocument({ kind: 'ruc' })
  ruc: string;

  /** Name of the first administrator, trimmed; 2 to 120 characters. */
  @Transform(onString(trim))
  @IsDefined({ message: REQUIRED })
  @IsString({ message: MUST_BE_TEXT })
  @IsNotEmpty({ message: REQUIRED })
  @MinLength(NAME_MIN_LENGTH, { message: 'El nombre debe tener al menos 2 caracteres' })
  @MaxLength(NAME_MAX_LENGTH, { message: 'El nombre admite como máximo 120 caracteres' })
  name: string;

  /** Trimmed and lowercased before validation (FR-003). */
  @IsDefined({ message: REQUIRED })
  @IsEmailNormalized()
  email: string;

  /** 8 to 128 Unicode characters, never trimmed (FR-005). */
  @IsDefined({ message: REQUIRED })
  @IsPassword()
  password: string;
}
