import { ChangeDetectionStrategy, Component, DestroyRef, inject, type OnInit, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import type { Role, TicketDetail, TicketStatus, UserStatus } from '../../core/api/api.models';
import { fieldErrorMessage, isProblem, problemMessage } from '../../core/api/problem';
import { SupportApiService } from '../../core/api/support-api.service';
import { SUPPORT_HOME_PATH } from '../../core/support/support.guards';
import { NETWORK_ERROR_MESSAGE } from '../auth/auth-form';
import {
  ACCOUNT_ROLE_LABELS,
  ACCOUNT_STATUS_LABELS,
  formatSupportDateTime,
  TICKET_STATUS_LABELS,
} from './support-format';
import { TemporaryPasswordDialogComponent } from './temporary-password.dialog';

const REQUIRED_MESSAGE = fieldErrorMessage({ field: '', code: 'REQUIRED', message: '' });
const VERIFICATION_NOTE_REQUIRED_MESSAGE = 'Indique cómo verificó la identidad de la persona';

/**
 * Ticket detail, temporary password generation and discard action for support agents (US2, US3, FR-009, FR-012, FR-019, FR-023).
 */
@Component({
  selector: 'app-ticket-detail-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, TemporaryPasswordDialogComponent],
  templateUrl: './ticket-detail.page.html',
  styleUrl: './ticket-detail.page.scss',
})
export class TicketDetailPage implements OnInit {
  private readonly api = inject(SupportApiService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly ticket = signal<TicketDetail | null>(null);
  protected readonly loading = signal(true);
  protected readonly error = signal<string | null>(null);

  protected readonly verificationNote = signal('');
  protected readonly verificationNoteError = signal<string | null>(null);
  protected readonly generatePasswordError = signal<string | null>(null);
  protected readonly generating = signal(false);
  protected readonly generatedTemporaryPassword = signal<string | null>(null);

  protected readonly discardReason = signal('');
  protected readonly discardReasonError = signal<string | null>(null);
  protected readonly discardError = signal<string | null>(null);
  protected readonly discarding = signal(false);

  ngOnInit(): void {
    const paramMap = this.route.snapshot.paramMap;
    const id = paramMap.get('id') ?? paramMap.get('ticketId') ?? '';
    this.loadTicket(id);
  }

  toJSON(): Record<string, unknown> {
    return {
      ticket: this.ticket(),
      loading: this.loading(),
      error: this.error(),
      verificationNote: this.verificationNote(),
      verificationNoteError: this.verificationNoteError(),
      generatePasswordError: this.generatePasswordError(),
      generating: this.generating(),
      generatedTemporaryPassword: this.generatedTemporaryPassword(),
      discardReason: this.discardReason(),
      discardReasonError: this.discardReasonError(),
      discardError: this.discardError(),
      discarding: this.discarding(),
    };
  }

  protected formatDate(iso: string): string {
    return formatSupportDateTime(iso);
  }

  protected ticketStatusLabel(status: TicketStatus): string {
    return TICKET_STATUS_LABELS[status];
  }

  protected roleLabel(role: Role): string {
    return ACCOUNT_ROLE_LABELS[role];
  }

  protected accountStatusLabel(status: UserStatus): string {
    return ACCOUNT_STATUS_LABELS[status];
  }

  protected updateVerificationNote(event: Event): void {
    const value = (event.target as HTMLTextAreaElement | HTMLInputElement).value;
    this.verificationNote.set(value);
    if (this.verificationNoteError() !== null) {
      this.verificationNoteError.set(null);
    }
  }

  protected submitGeneratePassword(event: Event): void {
    event.preventDefault();
    if (this.generating()) return;
    const currentTicket = this.ticket();
    if (!currentTicket || currentTicket.status !== 'open') return;

    this.generatePasswordError.set(null);
    const trimmed = this.verificationNote().trim();
    if (trimmed === '') {
      this.verificationNoteError.set(VERIFICATION_NOTE_REQUIRED_MESSAGE);
      return;
    }

    this.verificationNoteError.set(null);
    this.generating.set(true);
    this.api
      .generateTemporaryPassword(currentTicket.id, trimmed)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => {
          this.generating.set(false);
          this.ticket.set(res.ticket);
          this.verificationNote.set('');
          this.generatedTemporaryPassword.set(res.temporaryPassword);
        },
        error: (err: unknown) => {
          this.generating.set(false);
          if (!isProblem(err)) {
            this.generatePasswordError.set(NETWORK_ERROR_MESSAGE);
            return;
          }
          if (err.code === 'VALIDATION_ERROR') {
            const noteFieldErr = err.errors?.find((e) => e.field === 'verificationNote');
            if (noteFieldErr) {
              this.verificationNoteError.set(
                noteFieldErr.code === 'REQUIRED'
                  ? VERIFICATION_NOTE_REQUIRED_MESSAGE
                  : fieldErrorMessage(noteFieldErr),
              );
              return;
            }
          }
          this.generatePasswordError.set(problemMessage(err));
        },
      });
  }

  protected closeTemporaryPasswordDialog(): void {
    this.generatedTemporaryPassword.set(null);
  }

  protected updateDiscardReason(event: Event): void {
    const value = (event.target as HTMLTextAreaElement | HTMLInputElement).value;
    this.discardReason.set(value);
    if (this.discardReasonError() !== null) {
      this.discardReasonError.set(null);
    }
  }

  protected submitDiscard(event: Event): void {
    event.preventDefault();
    if (this.discarding()) return;
    const currentTicket = this.ticket();
    if (!currentTicket || currentTicket.status !== 'open') return;

    this.discardError.set(null);
    const trimmed = this.discardReason().trim();
    if (trimmed === '') {
      this.discardReasonError.set(REQUIRED_MESSAGE);
      return;
    }

    this.discardReasonError.set(null);
    this.discarding.set(true);
    this.api
      .discardTicket(currentTicket.id, trimmed)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: () => {
          this.discarding.set(false);
          void this.router.navigateByUrl(SUPPORT_HOME_PATH);
        },
        error: (err: unknown) => {
          this.discarding.set(false);
          if (!isProblem(err)) {
            this.discardError.set(NETWORK_ERROR_MESSAGE);
            return;
          }
          if (err.code === 'VALIDATION_ERROR') {
            const reasonFieldErr = err.errors?.find((e) => e.field === 'reason');
            if (reasonFieldErr) {
              this.discardReasonError.set(fieldErrorMessage(reasonFieldErr));
              return;
            }
          }
          this.discardError.set(problemMessage(err));
        },
      });
  }

  private loadTicket(id: string): void {
    this.loading.set(true);
    this.error.set(null);
    this.api
      .getTicket(id)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (ticket) => {
          this.ticket.set(ticket);
          this.loading.set(false);
        },
        error: (err: unknown) => {
          this.loading.set(false);
          this.error.set(isProblem(err) ? problemMessage(err) : NETWORK_ERROR_MESSAGE);
        },
      });
  }
}
