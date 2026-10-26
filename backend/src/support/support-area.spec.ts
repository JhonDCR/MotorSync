// T013 (specs/003-soporte-plataforma): @SupportArea() marca la zona del panel de soporte con la
// metadata que lee el guard global (research R3). Entrega en rojo: el decorador y SupportModule
// llegan en T014. Todo controlador declarado en SupportModule debe llevar el decorador a nivel de
// clase; este caso crece con cada controlador nuevo (T027, T029) sin tocar esta spec.
import 'reflect-metadata';
import { Reflector } from '@nestjs/core';
import { SUPPORT_AREA_KEY, SupportArea } from './support-area.decorator.js';
import { SupportModule } from './support.module.js';

class HandlerController {
  @SupportArea()
  list(this: void): void {}
}

@SupportArea()
class ClassController {
  me(this: void): void {}
}

class PlainController {
  list(this: void): void {}
}

describe('@SupportArea() (T013, research R3)', () => {
  it('[T013] el decorador en un handler deja supportArea = true y se lee con Reflector', () => {
    const handler = HandlerController.prototype.list;
    const reflector = new Reflector();

    expect(Reflect.getMetadata(SUPPORT_AREA_KEY, handler)).toBe(true);
    expect(
      reflector.getAllAndOverride(SUPPORT_AREA_KEY, [
        handler,
        HandlerController,
      ]),
    ).toBe(true);
  });

  it('[T013] el decorador en una clase deja supportArea = true en la clase', () => {
    const reflector = new Reflector();

    expect(Reflect.getMetadata(SUPPORT_AREA_KEY, ClassController)).toBe(true);
    expect(
      reflector.getAllAndOverride(SUPPORT_AREA_KEY, [
        ClassController.prototype.me,
        ClassController,
      ]),
    ).toBe(true);
  });

  it('[T013] una clase y un handler sin el decorador no tienen supportArea', () => {
    const handler = PlainController.prototype.list;
    const reflector = new Reflector();

    expect(
      Reflect.getMetadata(SUPPORT_AREA_KEY, PlainController),
    ).toBeUndefined();
    expect(Reflect.getMetadata(SUPPORT_AREA_KEY, handler)).toBeUndefined();
    expect(
      reflector.getAllAndOverride(SUPPORT_AREA_KEY, [handler, PlainController]),
    ).toBeUndefined();
  });

  it('[T013][T027] todo controlador declarado en SupportModule lleva @SupportArea() a nivel de clase', () => {
    const controllers = Reflect.getMetadata('controllers', SupportModule) ?? [];

    expect(Array.isArray(controllers)).toBe(true);
    for (const controller of controllers) {
      expect(Reflect.getMetadata(SUPPORT_AREA_KEY, controller)).toBe(true);
    }
  });
});
