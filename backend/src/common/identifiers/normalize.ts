/**
 * Normalizes a document number (research R7): uppercase, without whitespace or hyphens.
 * Any other non-alphanumeric character is kept so that validation rejects it (FR-002).
 */
export function normalizeDocument(raw: string): string {
  return raw.replace(/[\s-]+/g, '').toUpperCase();
}
