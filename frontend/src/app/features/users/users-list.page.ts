import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  OnInit,
  signal,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import type { UserAccount } from '../../core/api/api.models';
import { isProblem, problemMessage } from '../../core/api/problem';
import { UsersApiService } from '../../core/api/users-api.service';
import { SessionStore } from '../../core/auth/session.store';

@Component({
  selector: 'app-users-list-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink],
  templateUrl: './users-list.page.html',
  styleUrl: './users-list.page.scss',
})
export class UsersListPage implements OnInit {
  private readonly usersApi = inject(UsersApiService);
  protected readonly sessionStore = inject(SessionStore);

  protected readonly users = signal<UserAccount[]>([]);
  protected readonly loading = signal(true);
  protected readonly error = signal<string | null>(null);

  protected readonly isAdmin = computed(() => this.sessionStore.user()?.role === 'admin');

  ngOnInit(): void {
    if (!this.isAdmin()) {
      this.error.set('No tiene permisos para gestionar usuarios');
      this.loading.set(false);
      return;
    }
    this.loadUsers();
  }

  protected loadUsers(): void {
    this.loading.set(true);
    this.error.set(null);

    this.usersApi.list().subscribe({
      next: (res) => {
        this.users.set(res.items);
        this.loading.set(false);
      },
      error: (err: unknown) => {
        this.loading.set(false);
        if (isProblem(err)) {
          this.error.set(problemMessage(err));
        } else {
          this.error.set('No se pudo cargar la lista de usuarios. Revise su conexión');
        }
      },
    });
  }
}
