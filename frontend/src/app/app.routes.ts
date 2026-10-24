import { isDevMode } from '@angular/core';
import { Routes } from '@angular/router';
import { adminGuard, authGuard, guestGuard } from './core/auth/auth.guards';

/**
 * Route table. `devMode` decides whether /dev-token exists (research R2 and R13: never outside development).
 * Public routes (/login, /register) use guestGuard; every workshop route and /change-password use authGuard in
 * canMatch, so without a session nothing of the workshop is loaded or shown (FR-010).
 */
export function buildRoutes(devMode: boolean): Routes {
  const devRoutes: Routes = devMode
    ? [
        {
          path: 'dev-token',
          title: 'Token de desarrollo',
          loadComponent: () => import('./core/auth/dev-token.page').then((m) => m.DevTokenPage),
        },
      ]
    : [];

  return [
    // Public routes of the 002 (US1, US2): with a session they lead to the start screen.
    {
      path: 'register',
      title: 'Registrar taller',
      canMatch: [guestGuard],
      loadComponent: () => import('./features/auth/register.page').then((m) => m.RegisterPage),
    },
    {
      path: 'login',
      title: 'Iniciar sesión',
      canMatch: [guestGuard],
      loadComponent: () => import('./features/auth/login.page').then((m) => m.LoginPage),
    },
    // US5: the only screen open while a temporary password is pending.
    {
      path: 'change-password',
      title: 'Cambiar contraseña',
      canMatch: [authGuard],
      loadComponent: () => import('./features/auth/change-password.page').then((m) => m.ChangePasswordPage),
    },
    // FR-026: the start screen is the vehicle search by plate, one tap away from anywhere.
    {
      path: '',
      pathMatch: 'full',
      title: 'Buscar vehículo',
      canMatch: [authGuard],
      loadComponent: () => import('./features/vehicles/vehicle-search.page').then((m) => m.VehicleSearchPage),
    },
    {
      path: 'clients',
      title: 'Clientes',
      canMatch: [authGuard],
      loadComponent: () => import('./features/clients/client-search.page').then((m) => m.ClientSearchPage),
    },
    // clients/new va antes de clients/:id para que "new" no se lea como un id.
    {
      path: 'clients/new',
      title: 'Nuevo cliente',
      canMatch: [authGuard],
      loadComponent: () => import('./features/clients/client-form.page').then((m) => m.ClientFormPage),
    },
    // clients/:id/edit va antes de clients/:id (US4).
    {
      path: 'clients/:id/edit',
      title: 'Editar cliente',
      canMatch: [authGuard],
      loadComponent: () => import('./features/clients/client-form.page').then((m) => m.ClientFormPage),
    },
    {
      path: 'clients/:id',
      title: 'Ficha del cliente',
      canMatch: [authGuard],
      loadComponent: () => import('./features/clients/client-detail.page').then((m) => m.ClientDetailPage),
    },
    // vehicles/new va antes de vehicles/:id para que "new" no se lea como un id.
    {
      path: 'vehicles/new',
      title: 'Nuevo vehículo',
      canMatch: [authGuard],
      loadComponent: () => import('./features/vehicles/vehicle-form.page').then((m) => m.VehicleFormPage),
    },
    // vehicles/:id/edit va antes de vehicles/:id (US4).
    {
      path: 'vehicles/:id/edit',
      title: 'Editar vehículo',
      canMatch: [authGuard],
      loadComponent: () => import('./features/vehicles/vehicle-form.page').then((m) => m.VehicleFormPage),
    },
    {
      path: 'vehicles/:id',
      title: 'Ficha del vehículo',
      canMatch: [authGuard],
      loadComponent: () => import('./features/vehicles/vehicle-detail.page').then((m) => m.VehicleDetailPage),
    },
    // users/new va antes de users/:id para que "new" no se lea como un id.
    {
      path: 'users',
      title: 'Usuarios',
      canMatch: [authGuard, adminGuard],
      loadComponent: () => import('./features/users/users-list.page').then((m) => m.UsersListPage),
    },
    {
      path: 'users/new',
      title: 'Nuevo usuario',
      canMatch: [authGuard, adminGuard],
      loadComponent: () => import('./features/users/user-form.page').then((m) => m.UserFormPage),
    },
    {
      path: 'users/:id',
      title: 'Ficha de usuario',
      canMatch: [authGuard, adminGuard],
      loadComponent: () => import('./features/users/user-detail.page').then((m) => m.UserDetailPage),
    },
    ...devRoutes,
  ];
}

export const routes: Routes = buildRoutes(isDevMode());
