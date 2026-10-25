import type { Role, TicketStatus, UserStatus } from '../../core/api/api.models';

const GUAYAQUIL_FORMATTER = new Intl.DateTimeFormat('es-EC', {
  timeZone: 'America/Guayaquil',
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

export const ACCOUNT_ROLE_LABELS: Readonly<Record<Role, string>> = {
  admin: 'Administrador',
  asesor: 'Asesor',
};

export const ACCOUNT_STATUS_LABELS: Readonly<Record<UserStatus, string>> = {
  active: 'Activo',
  inactive: 'Inactivo',
};

export const TICKET_STATUS_LABELS: Readonly<Record<TicketStatus, string>> = {
  open: 'Abierto',
  resolved: 'Resuelto',
  discarded: 'Descartado',
};

/**
 * Formats an ISO-8601 UTC timestamp in the workshop/support timezone (America/Guayaquil, UTC-5).
 */
export function formatSupportDateTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return iso;
  }
  const parts = GUAYAQUIL_FORMATTER.formatToParts(date);
  const lookup = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value ?? '';
  return `${lookup('day')}/${lookup('month')}/${lookup('year')} ${lookup('hour')}:${lookup('minute')}`;
}
