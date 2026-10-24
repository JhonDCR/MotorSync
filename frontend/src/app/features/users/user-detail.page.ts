import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  OnInit,
  signal,
} from '@angular/core';
import { ActivatedRoute, RouterLink } from '@angular/router';
import type { Role, UserAccount, UserAuditEntry } from '../../core/api/api.models';
import { isProblem, problemMessage } from '../../core/api/problem';
import { UsersApiService } from '../../core/api/users-api.service';
import { SessionStore } from '../../core/auth/session.store';
import { ResetPasswordDialog } from './reset-password.dialog';

const ACTION_LABELS: Record<UserAuditEntry['action'], string> = {
  'user.role_changed': 'Cambio de rol',
  'user.deactivated': 'Desactivación de cuenta',
  'user.reactivated': 'Reactivación de cuenta',
  'user.password_reset': 'Restablecimiento de contraseña',
};

@Component({
  selector: 'app-user-detail-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, ResetPasswordDialog],
  templateUrl: './user-detail.page.html',
  styleUrl: './user-detail.page.scss',
})
export class UserDetailPage implements OnInit {
  private readonly route = inject(ActivatedRoute);
  private readonly usersApi = inject(UsersApiService);
  protected readonly sessionStore = inject(SessionStore);

  protected readonly userId = this.route.snapshot.paramMap.get('id') ?? '';

  protected readonly user = signal<UserAccount | null>(null);
  protected readonly history = signal<UserAuditEntry[]>([]);
  protected readonly loading = signal(true);
  protected readonly loadError = signal<string | null>(null);

  protected readonly actionError = signal<string | null>(null);
  protected readonly actionSuccess = signal<string | null>(null);
  protected readonly confirmAction = signal<'role' | 'deactivate' | 'reactivate' | null>(null);
  protected readonly processing = signal(false);
  protected readonly showResetDialog = signal(false);

  protected readonly isOwnAccount = computed(() => {
    const sessionUserId = this.sessionStore.user()?.id;
    return !!sessionUserId && sessionUserId === this.user()?.id;
  });

  protected readonly targetRole = computed<Role>(() => (this.user()?.role === 'admin' ? 'asesor' : 'admin'));
  protected readonly targetRoleLabel = computed(() => (this.user()?.role === 'admin' ? 'asesor' : 'administrador'));

  ngOnInit(): void {
    this.loadData();
  }

  protected loadData(): void {
    this.loading.set(true);
    this.loadError.set(null);

    this.usersApi.getById(this.userId).subscribe({
      next: (userData) => {
        this.user.set(userData);
        this.loading.set(false);
        this.loadHistory();
      },
      error: (err: unknown) => {
        this.loading.set(false);
        if (isProblem(err)) {
          this.loadError.set(problemMessage(err));
        } else {
          this.loadError.set('No se pudo cargar la información de la cuenta');
        }
      },
    });
  }

  protected loadHistory(): void {
    this.usersApi.getHistory(this.userId).subscribe({
      next: (res) => {
        this.history.set(res.items);
      },
      error: () => {
        // history error does not block the main page
      },
    });
  }

  protected actionLabel(action: UserAuditEntry['action']): string {
    return ACTION_LABELS[action] ?? action;
  }

  protected promptChangeRole(): void {
    this.actionError.set(null);
    this.actionSuccess.set(null);
    this.confirmAction.set('role');
  }

  protected confirmChangeRole(): void {
    if (this.processing()) return;
    this.processing.set(true);
    this.actionError.set(null);

    this.usersApi.changeRole(this.userId, this.targetRole()).subscribe({
      next: (updated) => {
        this.user.set(updated);
        this.processing.set(false);
        this.confirmAction.set(null);
        this.actionSuccess.set('Rol actualizado correctamente');
        this.loadHistory();
      },
      error: (err: unknown) => {
        this.processing.set(false);
        if (isProblem(err) && err.code === 'LAST_ADMIN') {
          this.actionError.set('El taller debe tener al menos un administrador activo');
        } else if (isProblem(err)) {
          this.actionError.set(problemMessage(err));
        } else {
          this.actionError.set('No se pudo cambiar el rol');
        }
      },
    });
  }

  protected promptDeactivate(): void {
    this.actionError.set(null);
    this.actionSuccess.set(null);
    this.confirmAction.set('deactivate');
  }

  protected confirmDeactivate(): void {
    if (this.processing()) return;
    this.processing.set(true);
    this.actionError.set(null);

    this.usersApi.deactivate(this.userId).subscribe({
      next: (updated) => {
        this.user.set(updated);
        this.processing.set(false);
        this.confirmAction.set(null);
        this.actionSuccess.set('Cuenta desactivada correctamente');
        this.loadHistory();
      },
      error: (err: unknown) => {
        this.processing.set(false);
        if (isProblem(err) && err.code === 'LAST_ADMIN') {
          this.actionError.set('El taller debe tener al menos un administrador activo');
        } else if (isProblem(err)) {
          this.actionError.set(problemMessage(err));
        } else {
          this.actionError.set('No se pudo desactivar la cuenta');
        }
      },
    });
  }

  protected promptReactivate(): void {
    this.actionError.set(null);
    this.actionSuccess.set(null);
    this.confirmAction.set('reactivate');
  }

  protected confirmReactivate(): void {
    if (this.processing()) return;
    this.processing.set(true);
    this.actionError.set(null);

    this.usersApi.reactivate(this.userId).subscribe({
      next: (updated) => {
        this.user.set(updated);
        this.processing.set(false);
        this.confirmAction.set(null);
        this.actionSuccess.set('Cuenta reactivada correctamente');
        this.loadHistory();
      },
      error: (err: unknown) => {
        this.processing.set(false);
        if (isProblem(err)) {
          this.actionError.set(problemMessage(err));
        } else {
          this.actionError.set('No se pudo reactivar la cuenta');
        }
      },
    });
  }

  protected cancelConfirm(): void {
    this.confirmAction.set(null);
    this.actionError.set(null);
  }

  protected openResetPasswordDialog(): void {
    this.actionError.set(null);
    this.actionSuccess.set(null);
    this.showResetDialog.set(true);
  }

  protected onResetDialogSuccess(updated: UserAccount): void {
    this.user.set(updated);
    this.showResetDialog.set(false);
    this.actionSuccess.set('Contraseña temporal restablecida correctamente');
    this.loadHistory();
  }

  protected onResetDialogClosed(): void {
    this.showResetDialog.set(false);
  }
}
