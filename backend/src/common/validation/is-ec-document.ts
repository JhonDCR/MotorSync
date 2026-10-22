import {
  registerDecorator,
  type ValidationArguments,
  type ValidationOptions,
} from 'class-validator';
import { isValidCedula, isValidPassport, isValidRuc } from '../identifiers/ec-document.js';

export type DocumentKind = 'cedula' | 'ruc' | 'passport';

interface DocumentRule {
  name: string;
  code: string;
  message: string;
  isValid: (value: string) => boolean;
}

// One constraint per document type, so that each one carries its own contract code.
const DOCUMENT_RULES: Record<DocumentKind, DocumentRule> = {
  cedula: {
    name: 'isEcCedula',
    code: 'INVALID_CEDULA',
    message: 'Cédula inválida: deben ser 10 dígitos con provincia y dígito verificador válidos',
    isValid: isValidCedula,
  },
  ruc: {
    name: 'isEcRuc',
    code: 'INVALID_RUC',
    message: 'RUC inválido: deben ser 13 dígitos terminados en 001',
    isValid: isValidRuc,
  },
  passport: {
    name: 'isEcPassport',
    code: 'INVALID_PASSPORT',
    message: 'Pasaporte inválido: de 5 a 20 letras o dígitos',
    isValid: isValidPassport,
  },
};

/**
 * Error of an already normalized document number for its type (INVALID_CEDULA, INVALID_RUC or
 * INVALID_PASSPORT), or null if valid. Used where the type is not in the same DTO (PATCH).
 */
export function documentNumberError(
  kind: DocumentKind,
  value: string,
): { code: string; message: string } | null {
  const rule = DOCUMENT_RULES[kind];
  return rule.isValid(value) ? null : { code: rule.code, message: rule.message };
}

function siblingValue(args: ValidationArguments, property: string): unknown {
  return (args.object as Record<string, unknown>)[property];
}

/**
 * Validates an already normalized document number (normalizeDocument) according to the
 * document type found in `typeProperty`. Emits INVALID_CEDULA, INVALID_RUC or INVALID_PASSPORT
 * through `context.code`. An unknown or missing type is left to the type's own validators.
 */
export function IsEcDocument(typeProperty: string): PropertyDecorator {
  return (target: object, propertyName: string | symbol): void => {
    for (const [kind, rule] of Object.entries(DOCUMENT_RULES)) {
      registerDecorator({
        name: rule.name,
        target: target.constructor,
        propertyName: String(propertyName),
        constraints: [typeProperty],
        options: { message: rule.message, context: { code: rule.code } },
        validator: {
          validate(value: unknown, args: ValidationArguments): boolean {
            if (siblingValue(args, typeProperty) !== kind) return true;
            return typeof value === 'string' && rule.isValid(value);
          },
        },
      });
    }
  };
}

export const DOCUMENT_TYPE_NOT_ALLOWED_MESSAGE = 'Una empresa solo puede registrarse con RUC';

/** Document types allowed for each client type: a company only with RUC (US2-AC2). */
const ALLOWED_DOCUMENT_TYPES: Record<string, readonly DocumentKind[]> = {
  natural: ['cedula', 'ruc', 'passport'],
  company: ['ruc'],
};

/**
 * Checks the document type against the client type found in `clientTypeProperty`
 * (INVALID_DOCUMENT_TYPE). An unknown or missing client type is left to its own validators.
 */
/** Whether `documentType` is allowed for `clientType` (a company only with RUC). */
export function isDocumentTypeAllowed(clientType: string, documentType: string): boolean {
  const allowed = ALLOWED_DOCUMENT_TYPES[clientType];
  return allowed === undefined || (allowed as readonly string[]).includes(documentType);
}

export function IsDocumentTypeAllowedFor(
  clientTypeProperty: string,
  options: ValidationOptions = {},
): PropertyDecorator {
  return (target: object, propertyName: string | symbol): void => {
    registerDecorator({
      name: 'isDocumentTypeAllowedFor',
      target: target.constructor,
      propertyName: String(propertyName),
      constraints: [clientTypeProperty],
      options: {
        message: DOCUMENT_TYPE_NOT_ALLOWED_MESSAGE,
        context: { code: 'INVALID_DOCUMENT_TYPE' },
        ...options,
      },
      validator: {
        validate(value: unknown, args: ValidationArguments): boolean {
          const clientType = siblingValue(args, clientTypeProperty);
          if (typeof clientType !== 'string') return true;
          const allowed = ALLOWED_DOCUMENT_TYPES[clientType];
          if (!allowed) return true;
          return typeof value === 'string' && (allowed as readonly string[]).includes(value);
        },
      },
    });
  };
}
