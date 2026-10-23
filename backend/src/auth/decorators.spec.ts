// T012 (specs/002-autenticacion): metadata of @Public(), @Roles() and @AllowPendingPasswordChange(),
// read with Reflector.getAllAndOverride over [handler, class] as the guard and the interceptor do
// (research R2, R7, R8).
import { Reflector } from '@nestjs/core';
import {
  ALLOW_PENDING_PASSWORD_CHANGE_KEY,
  AllowPendingPasswordChange,
} from './allow-pending-password-change.decorator.js';
import { IS_PUBLIC_KEY, Public } from './public.decorator.js';
import { ROLES_KEY, Roles } from './roles.decorator.js';

@Public()
class PublicController {
  handler(this: void): void {}
}

class MixedController {
  @Public()
  open(this: void): void {}

  @Roles('admin')
  adminOnly(this: void): void {}

  @AllowPendingPasswordChange()
  changePassword(this: void): void {}

  plain(this: void): void {}
}

@Roles('admin')
class AdminController {
  list(this: void): void {}

  @Roles('asesor', 'admin')
  overridden(this: void): void {}
}

@AllowPendingPasswordChange()
class PendingController {
  me(this: void): void {}
}

function read<T>(key: string, handler: () => void, controller: object): T | undefined {
  return new Reflector().getAllAndOverride<T | undefined>(key, [handler, controller as never]);
}

describe('Decoradores de autenticación (T012)', () => {
  it("[R2][FR-010] @Public() guarda isPublic = true (SetMetadata('isPublic', true))", () => {
    expect(IS_PUBLIC_KEY).toBe('isPublic');
    expect(read<boolean>(IS_PUBLIC_KEY, MixedController.prototype.open, MixedController)).toBe(
      true,
    );
  });

  it('[R2][FR-010] @Public() en la clase cubre todos sus handlers', () => {
    expect(read<boolean>(IS_PUBLIC_KEY, PublicController.prototype.handler, PublicController)).toBe(
      true,
    );
  });

  it('[R2] un handler sin decorador no es público', () => {
    expect(
      read<boolean>(IS_PUBLIC_KEY, MixedController.prototype.plain, MixedController),
    ).toBeFalsy();
  });

  it("[R8][US4-AC16] @Roles('admin') deja ['admin'] leíble en el handler", () => {
    expect(
      read<string[]>(ROLES_KEY, MixedController.prototype.adminOnly, MixedController),
    ).toEqual(['admin']);
    expect(read<string[]>(ROLES_KEY, MixedController.prototype.plain, MixedController)).toBe(
      undefined,
    );
  });

  it('[R8] @Roles en la clase vale para sus handlers y el del handler tiene prioridad', () => {
    expect(read<string[]>(ROLES_KEY, AdminController.prototype.list, AdminController)).toEqual([
      'admin',
    ]);
    expect(
      read<string[]>(ROLES_KEY, AdminController.prototype.overridden, AdminController),
    ).toEqual(['asesor', 'admin']);
  });

  it('[R7][FR-026] @AllowPendingPasswordChange() deja true leíble en handler y en clase', () => {
    expect(
      read<boolean>(
        ALLOW_PENDING_PASSWORD_CHANGE_KEY,
        MixedController.prototype.changePassword,
        MixedController,
      ),
    ).toBe(true);
    expect(
      read<boolean>(ALLOW_PENDING_PASSWORD_CHANGE_KEY, PendingController.prototype.me, PendingController),
    ).toBe(true);
    expect(
      read<boolean>(ALLOW_PENDING_PASSWORD_CHANGE_KEY, MixedController.prototype.plain, MixedController),
    ).toBeFalsy();
  });

  it('[T012] las tres claves de metadata son distintas', () => {
    expect(new Set([IS_PUBLIC_KEY, ROLES_KEY, ALLOW_PENDING_PASSWORD_CHANGE_KEY]).size).toBe(3);
  });
});
