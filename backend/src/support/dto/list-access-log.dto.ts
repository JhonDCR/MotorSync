import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsUUID, Min } from 'class-validator';

/**
 * Contract `GET /support/access-log` (US4-AC8): optional and combinable filters by workshop and
 * by agent, plus a 1-based page number with a fixed page size of 50. A non-uuid filter gives 400
 * VALIDATION_ERROR on that field.
 */
export class ListAccessLogDto {
  /** Workshop (tenant) id; an unknown uuid returns an empty page. */
  @IsOptional()
  @IsUUID(undefined, { message: 'Identificador de taller inválido' })
  workshopId?: string;

  /** Support agent id; an unknown uuid returns an empty page. */
  @IsOptional()
  @IsUUID(undefined, { message: 'Identificador de agente inválido' })
  agentId?: string;

  /** 1-based page number. Fixed page size of 50. */
  @Type(() => Number)
  @IsOptional()
  @IsInt({ message: 'La página debe ser un entero' })
  @Min(1, { message: 'La página debe ser mayor o igual a 1' })
  page: number = 1;
}
