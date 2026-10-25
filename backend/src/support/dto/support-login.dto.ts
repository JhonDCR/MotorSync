import { IsDefined, IsNotEmpty, IsString, MaxLength } from 'class-validator';
import { MUST_BE_TEXT, REQUIRED } from '../../auth/dto/register.dto.js';
import { IsEmailNormalized } from '../../common/validation/is-email-normalized.js';
import { PASSWORD_MAX_LENGTH } from '../../common/validation/is-password.js';

/**
 * Contract `SupportLoginRequest` (additionalProperties: false): only email and password. The
 * panel never takes a workshop: `tenantId`, `role` or any other field give 400 UNKNOWN_FIELD
 * through the global ValidationPipe (FR-010, US2-AC4).
 */
export class SupportLoginDto {
  /** Trimmed and lowercased before validation and lookup. */
  @IsDefined({ message: REQUIRED })
  @IsEmailNormalized()
  email: string;

  /** Compared as typed: never trimmed nor normalized. MaxLength counts code points. */
  @IsDefined({ message: REQUIRED })
  @IsString({ message: MUST_BE_TEXT })
  @IsNotEmpty({ message: REQUIRED })
  @MaxLength(PASSWORD_MAX_LENGTH, {
    message: 'La contraseña admite como máximo 128 caracteres',
  })
  password: string;
}
