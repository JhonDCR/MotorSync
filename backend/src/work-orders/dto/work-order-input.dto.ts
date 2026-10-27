import { Type } from 'class-transformer';
import { IsDefined, IsIn, IsInt, IsOptional, IsString, IsUUID, Length, Max, Min } from 'class-validator';

export const WORK_ORDER_STATUSES = ['abierta', 'en_proceso', 'terminada', 'entregada', 'cancelada'] as const;
export type WorkOrderStatus = (typeof WORK_ORDER_STATUSES)[number];

/** Body of POST /work-orders/{id}/cancel. */
export class CancelWorkOrderDto {
  @IsDefined()
  @IsString()
  @Length(1, 500)
  reason!: string;
}

/** Body of PATCH /work-orders/{id}/assignee. */
export class AssigneeDto {
  @IsDefined()
  @IsUUID()
  userId!: string;
}

/** Body of POST /work-orders/{id}/notes. */
export class NoteDto {
  @IsDefined()
  @IsString()
  @Length(1, 1000)
  body!: string;
}

/** Query of GET /work-orders. */
export class BoardQueryDto {
  @IsOptional()
  @IsIn(WORK_ORDER_STATUSES)
  status?: WorkOrderStatus;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}
