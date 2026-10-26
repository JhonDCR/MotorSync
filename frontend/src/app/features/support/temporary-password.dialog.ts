import { ChangeDetectionStrategy, Component, HostListener, Input, input, output, signal } from '@angular/core';

/**
 * Dialog that displays the generated temporary password once (US3-AC2, FR-019, FR-026).
 */
@Component({
  selector: 'app-temporary-password-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="dialog-backdrop">
      <div
        class="dialog-surface"
        role="dialog"
        aria-modal="true"
        aria-labelledby="temporary-password-dialog-title"
        data-testid="temporary-password-dialog"
      >
        <h2 id="temporary-password-dialog-title">Contraseña temporal generada</h2>

        <div class="password-box">
          <code class="password-mono" data-testid="temporary-password-value">{{ temporaryPasswordValue() }}</code>
          <button
            type="button"
            class="copy-button"
            data-testid="temporary-password-copy"
            (click)="copyPassword()"
          >
            {{ copied() ? 'Copiar (Copiada)' : 'Copiar contraseña' }}
          </button>
        </div>

        @if (copied()) {
          <p class="copied-status" role="status" data-testid="temporary-password-copied">
            Contraseña copiada al portapapeles
          </p>
        }

        <p class="format-notice" data-testid="temporary-password-format-notice">
          Escríbala tal cual, con los guiones y en mayúsculas
        </p>

        <p class="once-notice" data-testid="temporary-password-once-notice">
          Esta contraseña temporal se muestra una sola vez y no se volverá a mostrar
        </p>

        <div class="dialog-actions">
          <button
            type="button"
            class="close-button"
            data-testid="temporary-password-close"
            (click)="close()"
          >
            Entendido
          </button>
        </div>
      </div>
    </div>
  `,
  styles: `
    .dialog-backdrop {
      position: fixed;
      inset: 0;
      z-index: 1000;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 1rem;
      background: rgba(15, 23, 42, 0.6);
    }

    .dialog-surface {
      width: 100%;
      max-width: 30rem;
      padding: 1.5rem;
      border-radius: 0.75rem;
      background: #ffffff;
      color: #0f172a;
      box-shadow: 0 20px 25px -5px rgba(15, 23, 42, 0.25);
      display: flex;
      flex-direction: column;
      gap: 1rem;
    }

    .dialog-surface h2 {
      margin: 0;
      font-size: 1.25rem;
      color: #0f172a;
    }

    .password-box {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      justify-content: space-between;
      gap: 0.75rem;
      padding: 0.75rem 1rem;
      border: 1px solid #cbd5e1;
      border-radius: 0.5rem;
      background: #f8fafc;
    }

    .password-mono {
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace;
      font-size: 1.25rem;
      font-weight: 700;
      letter-spacing: 0.04em;
      color: #0f172a;
      user-select: all;
    }

    .copied-status {
      margin: 0;
      font-size: 0.875rem;
      font-weight: 600;
      color: #15803d;
    }

    .format-notice {
      margin: 0;
      font-weight: 600;
      color: #0f172a;
    }

    .once-notice {
      margin: 0;
      padding: 0.75rem 1rem;
      border-radius: 0.5rem;
      background: #fffbeb;
      border: 1px solid #f59e0b;
      color: #92400e;
      font-size: 0.9375rem;
    }

    .dialog-actions {
      display: flex;
      justify-content: flex-end;
    }

    .copy-button {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-height: 2.75rem;
      min-width: 2.75rem;
      padding: 0.5rem 1rem;
      border: 1px solid #1d4ed8;
      border-radius: 0.5rem;
      background: #eff6ff;
      color: #1d4ed8;
      font: inherit;
      font-weight: 600;
      cursor: pointer;
    }

    .copy-button:hover {
      background: #dbeafe;
    }

    .close-button {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-height: 2.75rem;
      min-width: 2.75rem;
      padding: 0.625rem 1.25rem;
      border: none;
      border-radius: 0.5rem;
      background: #1d4ed8;
      color: #ffffff;
      font: inherit;
      font-weight: 600;
      cursor: pointer;
    }

    .close-button:hover {
      background: #1e40af;
    }
  `,
})
export class TemporaryPasswordDialogComponent {
  readonly temporaryPassword = input.required<string>();
  readonly temporaryPasswordExpiresAt = input<string | null>(null);
  readonly accountEmail = input<string>('');
  readonly accountName = input<string>('');

  readonly closed = output<void>();

  protected readonly copied = signal(false);

  @HostListener('window:keydown.escape')
  protected onEscape(): void {
    this.close();
  }

  protected temporaryPasswordValue(): string {
    const raw: unknown = this.temporaryPassword;
    return typeof raw === 'function' ? (raw as () => string)() : String(raw ?? '');
  }

  protected copyPassword(): void {
    const value = this.temporaryPasswordValue();
    void navigator.clipboard?.writeText(value);
    this.copied.set(true);
  }

  protected close(): void {
    this.closed.emit();
  }
}

const dialogProto = TemporaryPasswordDialogComponent.prototype as unknown as Record<string, unknown>;
Input({ required: true })(dialogProto, 'temporaryPassword');
Input()(dialogProto, 'temporaryPasswordExpiresAt');
Input()(dialogProto, 'accountEmail');
Input()(dialogProto, 'accountName');

export { TemporaryPasswordDialogComponent as TemporaryPasswordDialog };
