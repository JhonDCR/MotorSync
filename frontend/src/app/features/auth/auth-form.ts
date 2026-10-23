// Shared rules of the public auth pages (register and login), from specs/002-autenticacion (FR-005).

export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 128;

/** Shown when the request fails without a Problem body (network failure, status 0). */
export const NETWORK_ERROR_MESSAGE = 'No se pudo conectar con el servidor. Revise la conexión e inténtelo de nuevo';

/** Length in Unicode characters (code points), never trimmed: "😀" counts as one (FR-005). */
export function unicodeLength(value: string): number {
  return [...value].length;
}
