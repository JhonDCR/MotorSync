import { ChangeDetectionStrategy, Component, signal } from '@angular/core';
import { AUTH_TOKEN_STORAGE_KEY, readAuthToken } from './auth-token.interceptor';

// Pantalla mínima de desarrollo (research.md R2): se pega el JWT emitido con `npm run token:dev`.
// La ruta /dev-token solo se registra cuando isDevMode() es verdadero (ver app.routes.ts).
@Component({
  selector: 'app-dev-token-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './dev-token.page.scss',
  template: `
    <main class="dev-token">
      <h1>Token de desarrollo</h1>
      <form (submit)="save($event, tokenInput.value)">
        <label for="dev-token-input">JWT de desarrollo</label>
        <textarea
          id="dev-token-input"
          #tokenInput
          rows="6"
          autocomplete="off"
          spellcheck="false"
          [value]="token()"
        ></textarea>
        <div class="actions">
          <button type="submit">Guardar token</button>
          <button type="button" (click)="clear(tokenInput)">Borrar token</button>
        </div>
      </form>
      <p role="status" aria-live="polite">{{ status() }}</p>
    </main>
  `,
})
export class DevTokenPage {
  protected readonly token = signal(readAuthToken() ?? '');
  protected readonly status = signal(this.token() ? 'Hay un token guardado.' : 'No hay token guardado.');

  protected save(event: Event, value: string): void {
    event.preventDefault();
    const token = value.trim();
    if (!token) {
      this.status.set('Pegue un token antes de guardar.');
      return;
    }
    localStorage.setItem(AUTH_TOKEN_STORAGE_KEY, token);
    this.token.set(token);
    this.status.set('Token guardado.');
  }

  protected clear(input: HTMLTextAreaElement): void {
    localStorage.removeItem(AUTH_TOKEN_STORAGE_KEY);
    input.value = '';
    this.token.set('');
    this.status.set('Token borrado.');
  }
}
