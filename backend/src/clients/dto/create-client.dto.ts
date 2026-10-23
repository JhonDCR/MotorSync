import { Transform } from 'class-transformer';
import {
  IsDefined,
  IsEmail,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  ValidateIf,
} from 'class-validator';
import { normalizeDocument } from '../../common/identifiers/normalize.js';
import { normalizePhone } from '../../common/identifiers/phone.js';
import { IsDocumentTypeAllowedFor, IsEcDocument } from '../../common/validation/is-ec-document.js';
import { IsEcPhone } from '../../common/validation/is-ec-phone.js';
import { onString, trim } from '../../common/validation/transforms.js';
import type { ClientType, DocumentType } from '../client.entity.js';

export const CLIENT_TYPES: readonly ClientType[] = ['natural', 'company'];
export const DOCUMENT_TYPES: readonly DocumentType[] = ['cedula', 'ruc', 'passport'];

export const REQUIRED = 'Campo obligatorio';
export const MUST_BE_TEXT = 'Debe ser texto';

export const normalizeEmail = (value: string): string => value.trim().toLowerCase();

/** A name is validated when it applies to the client type, or when it is sent anyway. */
function namesApply(clientType: ClientType, property: keyof CreateClientDto) {
  return (dto: CreateClientDto): boolean =>
    dto.clientType === clientType || dto[property] !== undefined;
}

/** Contract `ClientCreate` (additionalProperties: false, enforced by forbidNonWhitelisted). */
export class CreateClientDto {
  @IsDefined({ message: REQUIRED })
  @IsIn(CLIENT_TYPES, {
    message: 'Tipo de cliente inválido: natural o company',
  })
  clientType: ClientType;

  @IsDefined({ message: REQUIRED })
  @IsIn(DOCUMENT_TYPES, {
    message: 'Tipo de documento inválido: cedula, ruc o passport',
    context: { code: 'INVALID_DOCUMENT_TYPE' },
  })
  @IsDocumentTypeAllowedFor('clientType')
  documentType: DocumentType;

  /** Normalized (uppercase, without whitespace or hyphens) before validation (research R7). */
  @Transform(onString(normalizeDocument))
  @IsDefined({ message: REQUIRED })
  @IsString({ message: MUST_BE_TEXT })
  @MaxLength(30, { message: 'El documento admite como máximo 30 caracteres' })
  @IsEcDocument('documentType')
  documentNumber: string;

  @Transform(onString(trim))
  @ValidateIf(namesApply('natural', 'firstNames'))
  @IsDefined({ message: REQUIRED })
  @IsString({ message: MUST_BE_TEXT })
  @IsNotEmpty({ message: REQUIRED })
  @MaxLength(100, { message: 'Los nombres admiten como máximo 100 caracteres' })
  firstNames?: string;

  @Transform(onString(trim))
  @ValidateIf(namesApply('natural', 'lastNames'))
  @IsDefined({ message: REQUIRED })
  @IsString({ message: MUST_BE_TEXT })
  @IsNotEmpty({ message: REQUIRED })
  @MaxLength(100, { message: 'Los apellidos admiten como máximo 100 caracteres' })
  lastNames?: string;

  @Transform(onString(trim))
  @ValidateIf(namesApply('company', 'businessName'))
  @IsDefined({ message: REQUIRED })
  @IsString({ message: MUST_BE_TEXT })
  @IsNotEmpty({ message: REQUIRED })
  @MaxLength(200, { message: 'La razón social admite como máximo 200 caracteres' })
  businessName?: string;

  /** Normalized (without whitespace, hyphens or parentheses; the + is kept). */
  @Transform(onString(normalizePhone))
  @IsDefined({ message: REQUIRED })
  @IsString({ message: MUST_BE_TEXT, context: { code: 'INVALID_PHONE' } })
  @MaxLength(25, {
    message: 'El teléfono admite como máximo 25 caracteres',
    context: { code: 'INVALID_PHONE' },
  })
  @IsEcPhone()
  phone: string;

  /** Optional and nullable; trimmed and lowercased before validation. */
  @Transform(onString(normalizeEmail))
  @IsOptional()
  @IsString({ message: MUST_BE_TEXT, context: { code: 'INVALID_EMAIL' } })
  @MaxLength(254, {
    message: 'El correo admite como máximo 254 caracteres',
    context: { code: 'INVALID_EMAIL' },
  })
  @IsEmail({}, { message: 'Correo electrónico inválido', context: { code: 'INVALID_EMAIL' } })
  email?: string | null;
}
