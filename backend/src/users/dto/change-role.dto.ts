import { IsDefined, IsIn } from 'class-validator';
import type { AuthRole } from '../../auth/auth-user.js';

export class ChangeRoleDto {
  @IsDefined()
  @IsIn(['asesor', 'admin'])
  role: AuthRole;
}
