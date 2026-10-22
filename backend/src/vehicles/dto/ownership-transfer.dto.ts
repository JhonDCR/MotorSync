import { IsDefined, IsInt, IsOptional, IsString, IsUUID, Min } from 'class-validator';
import { MUST_BE_TEXT, REQUIRED } from './create-vehicle.dto.js';

/** Contract `OwnershipTransferRequest` (additionalProperties: false, via forbidNonWhitelisted). */
export class OwnershipTransferDto {
  /** A client of the same tenant, checked under RLS (404 CLIENT_NOT_FOUND otherwise). */
  @IsDefined({ message: REQUIRED })
  @IsUUID(undefined, { message: 'Identificador de cliente inválido' })
  newOwnerClientId: string;

  /** Current version of the vehicle (research R5). */
  @IsDefined({ message: REQUIRED })
  @IsInt({ message: 'La versión debe ser un entero' })
  @Min(1, { message: 'La versión debe ser mayor o igual a 1' })
  version: number;

  /**
   * Required for asesor, optional for admin (FR-019). Its length (10 to 500 after trim) is
   * decided by reason-policy, so that an empty or blank reason counts as omitted.
   */
  @IsOptional()
  @IsString({ message: MUST_BE_TEXT })
  reason?: string | null;
}
