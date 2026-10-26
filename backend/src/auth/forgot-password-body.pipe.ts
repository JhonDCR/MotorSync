import { Injectable, type PipeTransform } from '@nestjs/common';
import { isValidEmail, normalizeEmail } from '../common/identifiers/email.js';
import { ProblemException } from '../common/problem-details.filter.js';
import { REQUIRED } from './dto/register.dto.js';

/** Body of POST /auth/forgot-password: only the email (research R7). */
export interface ForgotPasswordBody {
  email: string;
}

const INVALID_EMAIL_MESSAGE = 'Correo electrónico inválido';

/**
 * Validates and normalizes the body of POST /auth/forgot-password (research R7). Unlike the DTOs of
 * the 002 it does not reject unknown fields: US1-AC9 asks to ignore `tenantId`, `userId` or
 * `ticketId`. It always returns a fresh `{ email }`, so no other key (not even `__proto__`) reaches
 * the service.
 */
@Injectable()
export class ForgotPasswordBodyPipe implements PipeTransform {
  transform(value: unknown): ForgotPasswordBody {
    const body =
      typeof value === 'object' && value !== null && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : undefined;
    const raw = body?.email;
    if (typeof raw !== 'string') throw required();
    const email = normalizeEmail(raw);
    if (email === '') throw required();
    if (!isValidEmail(email)) {
      throw new ProblemException(400, 'VALIDATION_ERROR', {
        errors: [
          {
            field: 'email',
            code: 'INVALID_EMAIL',
            message: INVALID_EMAIL_MESSAGE,
          },
        ],
      });
    }
    return { email };
  }
}

/** 400 VALIDATION_ERROR with a single REQUIRED error in `email` (US1-AC8). */
function required(): ProblemException {
  return new ProblemException(400, 'VALIDATION_ERROR', {
    errors: [{ field: 'email', code: 'REQUIRED', message: REQUIRED }],
  });
}
