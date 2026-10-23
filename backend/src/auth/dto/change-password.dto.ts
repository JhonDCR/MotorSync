import { IsDefined, IsNotEmpty, IsString, MaxLength } from 'class-validator';
import { IsPassword, PASSWORD_MAX_LENGTH } from '../../common/validation/is-password.js';
import { MUST_BE_TEXT, REQUIRED } from './register.dto.js';

/**
 * Contract `ChangePasswordRequest` (additionalProperties: false): only the account of the session
 * changes, so `userId` or any other field gives 400 UNKNOWN_FIELD (US5-AC8).
 */
export class ChangePasswordDto {
  /** Compared as typed: never trimmed nor normalized. 1 to 128 characters (code points). */
  @IsDefined({ message: REQUIRED })
  @IsString({ message: MUST_BE_TEXT })
  @IsNotEmpty({ message: REQUIRED })
  @MaxLength(PASSWORD_MAX_LENGTH, { message: 'La contraseña admite como máximo 128 caracteres' })
  currentPassword: string;

  /** 8 to 128 Unicode characters, never trimmed (FR-005). */
  @IsDefined({ message: REQUIRED })
  @IsPassword()
  newPassword: string;
}
