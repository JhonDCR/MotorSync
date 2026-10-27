import { json, type NextFunction, type Request, type Response } from 'express';
import { ValidationPipe, type INestApplication, type ValidationError } from '@nestjs/common';
import { ProblemDetailsFilter, ProblemException } from './common/problem-details.filter.js';
import type { FieldError } from './database/pg-errors.js';

export const API_PREFIX = 'api/v1';
export const CHECKIN_BODY_LIMIT = '25mb';

const CONSTRAINT_CODES: Record<string, string> = {
  whitelistValidation: 'UNKNOWN_FIELD',
  isDefined: 'REQUIRED',
  isNotEmpty: 'REQUIRED',
};

const FIELD_MESSAGES: Record<string, string> = {
  UNKNOWN_FIELD: 'Campo no permitido',
  REQUIRED: 'Campo obligatorio',
};

/**
 * Field code of a class-validator error: an explicit `context: { code }` on the decorator wins,
 * then the known constraints; otherwise the generic VALIDATION_ERROR.
 */
function toFieldError(field: string, error: ValidationError): FieldError {
  const constraints = error.constraints ?? {};
  const names = Object.keys(constraints);
  const name = names.includes('whitelistValidation') ? 'whitelistValidation' : names[0];
  const contextCode: unknown = error.contexts?.[name]?.code;
  const code =
    typeof contextCode === 'string' ? contextCode : (CONSTRAINT_CODES[name] ?? 'VALIDATION_ERROR');
  return { field, code, message: FIELD_MESSAGES[code] ?? constraints[name] ?? 'Valor inválido' };
}

function flatten(errors: ValidationError[], parent = ''): FieldError[] {
  return errors.flatMap((error) => {
    const field = parent ? `${parent}.${error.property}` : error.property;
    const own = error.constraints ? [toFieldError(field, error)] : [];
    return [...own, ...flatten(error.children ?? [], field)];
  });
}

/** 400 VALIDATION_ERROR with one errors[] entry per invalid field (contract `FieldError`). */
export function validationExceptionFactory(errors: ValidationError[]): ProblemException {
  return new ProblemException(400, 'VALIDATION_ERROR', { errors: flatten(errors) });
}

/** HTTP wiring shared by main.ts and the e2e tests: prefix, validation and problem+json. */
export function configureApp(app: INestApplication): void {
  app.setGlobalPrefix(API_PREFIX);
  // Check-in creation carries base64 photos (up to 21 images of 1 MB): 25 MB only on that route.
  // Registered before Nest's default 100 kb parser, which then skips the already parsed body.
  // Wrapped so that the layer is not named `jsonParser`: Nest skips its own parsers when it finds one.
  const checkinJson = json({ limit: CHECKIN_BODY_LIMIT });
  app.use(
    `/${API_PREFIX}/vehicles/:vehicleId/checkins`,
    (req: Request, res: Response, next: NextFunction) => checkinJson(req, res, next),
  );
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      exceptionFactory: validationExceptionFactory,
    }),
  );
  app.useGlobalFilters(new ProblemDetailsFilter());
}
