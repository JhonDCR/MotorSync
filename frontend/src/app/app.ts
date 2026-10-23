import { ChangeDetectionStrategy, Component, computed, inject, Injector, signal } from '@angular/core';
import { Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import type { Role } from './core/api/api.models';
import { AuthApiService } from './core/api/auth-api.service';
import { LOGIN_PATH } from './core/auth/auth.guards';
import { SessionStore } from './core/auth/session.store';

const ROLE_LABELS: Record<Role, string> = { admin: 'Administrador', asesor: 'Asesor' };

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterOutlet, RouterLink, RouterLinkActive],
  selector: 'app-root',
  styleUrl: './app.scss',
  templateUrl: './app.html',
})
export class App {
  private readonly injector = inject(Injector);
  private readonly router = inject(Router);
  protected readonly session = inject(SessionStore);

  protected readonly roleLabel = computed(() => {
    const role = this.session.user()?.role;
    return role === undefined ? '' : ROLE_LABELS[role];
  });
  protected readonly loggingOut = signal(false);

  /**
   * US3-AC3: closes the session on the server and always ends signed out on /login, even if the server fails
   * (logout is idempotent, US3-AC6).
   */
  protected logout(): void {
    if (this.loggingOut()) return;
    this.loggingOut.set(true);
    const done = (): void => {
      this.session.clear();
      this.loggingOut.set(false);
      void this.router.navigate([LOGIN_PATH], { queryParams: { reason: 'logout' } });
    };
    this.injector.get(AuthApiService).logout().subscribe({ complete: done, error: done });
  }
}
