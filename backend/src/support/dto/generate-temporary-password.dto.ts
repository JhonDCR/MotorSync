import { Transform } from 'class-transformer';
import { IsDefined, IsNotEmpty, IsString, MaxLength } from 'class-validator';
import { MUST_BE_TEXT, REQUIRED } from '../../auth/dto/register.dto.js';
import { onString, trim } from '../../common/validation/transforms.js';

/** Contract `GenerateTemporaryPasswordRequest.verificationNote`: 1 to 1000 characters after trimming. */
export const VERIFICATION_NOTE_MAX_LENGTH = 1000;

/**
 * Contract `GenerateTemporaryPasswordRequest` (additionalProperties: false, enforced by
 * forbidNonWhitelisted): the note is trimmed BEFORE validation, so blank gives REQUIRED and an
 * extra field such as `userId` or `tenantId` gives 400 UNKNOWN_FIELD.
 */
export class GenerateTemporaryPasswordDto {
  @Transform(onString(trim))
  @IsDefined({ message: REQUIRED })
  @IsString({ message: MUST_BE_TEXT })
  @IsNotEmpty({ message: REQUIRED })
  @MaxLength(VERIFICATION_NOTE_MAX_LENGTH, {
    message: 'La nota admite como máximo 1000 caracteres',
  })
  verificationNote: string;
}
