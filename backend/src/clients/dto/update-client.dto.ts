import { Transform } from 'class-transformer';
import {
  IsDefined,
  IsEmail,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';
import { normalizeDocument } from '../../common/identifiers/normalize.js';
import { normalizePhone } from '../../common/identifiers/phone.js';
import { IsEcDocument } from '../../common/validation/is-ec-document.js';
import { IsEcPhone } from '../../common/validation/is-ec-phone.js';
import { IfPresent, onString, trim } from '../../common/validation/transforms.js';
import type { DocumentType } from '../client.entity.js';
import { DOCUMENT_TYPES, MUST_BE_TEXT, normalizeEmail, REQUIRED } from './create-client.dto.js';

/**
 * Contract `ClientUpdate` (additionalProperties: false, enforced by forbidNonWhitelisted, so
 * clientType, tenantId or any other key is 400 UNKNOWN_FIELD). Only the sent fields change.
 * The document number is validated here against documentType when both are sent; the service
 * revalidates the resulting pair (stored values + changes) and the client type.
 */
export class UpdateClientDto {
  /** Optimistic lock (research R5): the version the user edited. */
  @IsDefined({ message: REQUIRED })
  @IsInt({ message: 'La versión debe ser un entero' })
  @Min(1, { message: 'La versión debe ser mayor o igual a 1' })
  version: number;

  @IfPresent()
  @IsIn(DOCUMENT_TYPES, {
    message: 'Tipo de documento inválido: cedula, ruc o passport',
    context: { code: 'INVALID_DOCUMENT_TYPE' },
  })
  documentType?: DocumentType;

  /** Normalized (uppercase, without whitespace or hyphens) before validation (research R7). */
  @Transform(onString(normalizeDocument))
  @IfPresent()
  @IsString({ message: MUST_BE_TEXT })
  @MaxLength(30, { message: 'El documento admite como máximo 30 caracteres' })
  @IsEcDocument('documentType')
  documentNumber?: string;

  @Transform(onString(trim))
  @IfPresent()
  @IsString({ message: MUST_BE_TEXT })
  @IsNotEmpty({ message: REQUIRED })
  @MaxLength(100, { message: 'Los nombres admiten como máximo 100 caracteres' })
  firstNames?: string;

  @Transform(onString(trim))
  @IfPresent()
  @IsString({ message: MUST_BE_TEXT })
  @IsNotEmpty({ message: REQUIRED })
  @MaxLength(100, { message: 'Los apellidos admiten como máximo 100 caracteres' })
  lastNames?: string;

  @Transform(onString(trim))
  @IfPresent()
  @IsString({ message: MUST_BE_TEXT })
  @IsNotEmpty({ message: REQUIRED })
  @MaxLength(200, { message: 'La razón social admite como máximo 200 caracteres' })
  businessName?: string;

  /** Normalized (without whitespace, hyphens or parentheses; the + is kept). */
  @Transform(onString(normalizePhone))
  @IfPresent()
  @IsString({ message: MUST_BE_TEXT, context: { code: 'INVALID_PHONE' } })
  @MaxLength(25, {
    message: 'El teléfono admite como máximo 25 caracteres',
    context: { code: 'INVALID_PHONE' },
  })
  @IsEcPhone()
  phone?: string;

  /** Nullable: null clears the email. Trimmed and lowercased before validation. */
  @Transform(onString(normalizeEmail))
  @IsOptional()
  @IsString({ message: MUST_BE_TEXT, context: { code: 'INVALID_EMAIL' } })
  @MaxLength(254, {
    message: 'El correo admite como máximo 254 caracteres',
    context: { code: 'INVALID_EMAIL' },
  })
  @IsEmail({}, { message: 'Correo electrónico inválido', context: { code: 'INVALID_EMAIL' } })
  email?: string | null;

  /**
   * Required by role when the document changes (FR-019). Its length (10 to 500 after trim) is
   * decided by reason-policy, so that an empty or blank reason counts as omitted.
   */
  @IsOptional()
  @IsString({ message: MUST_BE_TEXT })
  reason?: string | null;
}
