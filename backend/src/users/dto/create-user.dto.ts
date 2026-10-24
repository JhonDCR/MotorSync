import { Transform } from 'class-transformer';
import { IsDefined, IsIn, IsString, Length } from 'class-validator';
import type { AuthRole } from '../../auth/auth-user.js';
import { IsEmailNormalized } from '../../common/validation/is-email-normalized.js';
import { IsPassword } from '../../common/validation/is-password.js';

export class CreateUserDto {
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value))
  @IsDefined()
  @IsString()
  @Length(2, 120)
  name: string;

  @IsDefined()
  @IsEmailNormalized()
  email: string;

  @IsDefined()
  @IsIn(['asesor', 'admin'])
  role: AuthRole;

  @IsDefined()
  @IsPassword()
  temporaryPassword: string;
}
