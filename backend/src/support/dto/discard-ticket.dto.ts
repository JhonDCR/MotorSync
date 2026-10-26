import { Transform } from 'class-transformer';
import { IsDefined, IsNotEmpty, IsString, MaxLength } from 'class-validator';
import { MUST_BE_TEXT, REQUIRED } from '../../auth/dto/register.dto.js';
import { onString, trim } from '../../common/validation/transforms.js';

/** Contract `DiscardTicketRequest.reason`: 1 to 500 characters after trimming. */
export const DISCARD_REASON_MAX_LENGTH = 500;

/**
 * Contract `DiscardTicketRequest` (additionalProperties: false, enforced by
 * forbidNonWhitelisted): the reason is trimmed BEFORE validation, so blank gives REQUIRED and an
 * extra field such as `userId` gives 400 UNKNOWN_FIELD.
 */
export class DiscardTicketDto {
  @Transform(onString(trim))
  @IsDefined({ message: REQUIRED })
  @IsString({ message: MUST_BE_TEXT })
  @IsNotEmpty({ message: REQUIRED })
  @MaxLength(DISCARD_REASON_MAX_LENGTH, {
    message: 'El motivo admite como máximo 500 caracteres',
  })
  reason: string;
}
