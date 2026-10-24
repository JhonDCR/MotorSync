import { IsDefined } from 'class-validator';
import { IsPassword } from '../../common/validation/is-password.js';

export class ResetPasswordDto {
  @IsDefined()
  @IsPassword()
  temporaryPassword: string;
}
