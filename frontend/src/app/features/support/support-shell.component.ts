import { ChangeDetectionStrategy, Component, inject, Injector, signal } from '@angular/core';
import { Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { SupportApiService } from '../../core/api/support-api.service';
import { SUPPORT_LOGIN_PATH } from '../../core/support/support.guards';
import { SupportSessionStore } from '../../core/support/support-session.store';

/**
 * Dedicated shell for the `/support` zone (US2, FR-005). Completely independent from the workshop header and
 * navigation so no workshop state or controls leak into the support experience.
 */
@Component({
  selector: 'app-support-shell',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterOutlet, RouterLink, RouterLinkActive],
  templateUrl: './support-shell.component.html',
  styleUrl: './support-shell.component.scss',
})
export class SupportShellComponent {
  private readonly injector = inject(Injector);
  private readonly router = inject(Router);
  protected readonly session = inject(SupportSessionStore);
  protected readonly loggingOut = signal(false);

  protected logout(): void {
    if (this.loggingOut()) return;
    this.loggingOut.set(true);
    const done = (): void => {
      this.session.clear();
      this.loggingOut.set(false);
      void this.router.navigate([SUPPORT_LOGIN_PATH], { queryParams: { reason: 'logout' } });
    };
    this.injector.get(SupportApiService).logout().subscribe({ complete: done, error: done });
  }
}
