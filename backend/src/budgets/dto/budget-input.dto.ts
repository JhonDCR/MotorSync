import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsDefined,
  IsIn,
  IsString,
  Length,
  Matches,
  ValidateNested,
} from 'class-validator';

export const LINE_KINDS = ['mano_obra', 'repuesto'] as const;
export type LineKind = (typeof LINE_KINDS)[number];

/** Contract `Money`: decimal string with up to 2 decimals. */
export const MONEY_PATTERN = /^\d{1,10}(\.\d{1,2})?$/;
/** Same as Money but strictly greater than zero (quantity > 0, US1-AC3). */
const POSITIVE_MONEY_PATTERN = /^(?!0+(\.0{1,2})?$)\d{1,10}(\.\d{1,2})?$/;

/** Contract `LineInput`. */
export class LineInputDto {
  @IsDefined()
  @IsIn(LINE_KINDS)
  kind!: LineKind;

  @IsDefined()
  @IsString()
  @Length(1, 200)
  description!: string;

  @IsDefined()
  @IsString()
  @Matches(POSITIVE_MONEY_PATTERN)
  quantity!: string;

  @IsDefined()
  @IsString()
  @Matches(MONEY_PATTERN)
  unitPrice!: string;
}

/** Contract `BudgetInput`. */
export class BudgetInputDto {
  @IsDefined()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => LineInputDto)
  lines!: LineInputDto[];
}
