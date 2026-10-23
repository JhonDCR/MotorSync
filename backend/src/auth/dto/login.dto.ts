import { IsDefined, IsNotEmpty, IsString, MaxLength } from 'class-validator';
import { IsEmailNormalized } from '../../common/validation/is-email-normalized.js';
import { PASSWORD_MAX_LENGTH } from '../../common/validation/is-password.js';
import { MUST_BE_TEXT, REQUIRED } from './register.dto.js';

/**
 * Contract `LoginRequest` (additionalProperties: false): `tenantId` or `role` give 400
 * UNKNOWN_FIELD (US2-AC10). The workshop always comes from the account (FR-007).
 */
export class LoginDto {
  /** Trimmed and lowercased before validation and lookup (FR-003, US2-AC2). */
  @IsDefined({ message: REQUIRED })
  @IsEmailNormalized()
  email: string;

  /** Compared as typed: never trimmed nor normalized (US2-AC2). MaxLength counts code points. */
  @IsDefined({ message: REQUIRED })
  @IsString({ message: MUST_BE_TEXT })
  @IsNotEmpty({ message: REQUIRED })
  @MaxLength(PASSWORD_MAX_LENGTH, { message: 'La contraseña admite como máximo 128 caracteres' })
  password: string;
}
