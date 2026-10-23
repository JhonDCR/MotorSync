import { isDevMode } from '@angular/core';
import { Routes } from '@angular/router';

// /dev-token solo existe en desarrollo (research.md R2).
const devRoutes: Routes = isDevMode()
  ? [
      {
        path: 'dev-token',
        title: 'Token de desarrollo',
        loadComponent: () => import('./core/auth/dev-token.page').then((m) => m.DevTokenPage),
      },
    ]
  : [];

export const routes: Routes = [
  // Public routes of the 002 (US1, US2): no session needed.
  {
    path: 'register',
    title: 'Registrar taller',
    loadComponent: () => import('./features/auth/register.page').then((m) => m.RegisterPage),
  },
  {
    path: 'login',
    title: 'Iniciar sesión',
    loadComponent: () => import('./features/auth/login.page').then((m) => m.LoginPage),
  },
  // FR-026: the start screen is the vehicle search by plate, one tap away from anywhere.
  {
    path: '',
    pathMatch: 'full',
    title: 'Buscar vehículo',
    loadComponent: () => import('./features/vehicles/vehicle-search.page').then((m) => m.VehicleSearchPage),
  },
  {
    path: 'clients',
    title: 'Clientes',
    loadComponent: () => import('./features/clients/client-search.page').then((m) => m.ClientSearchPage),
  },
  // clients/new va antes de clients/:id para que "new" no se lea como un id.
  {
    path: 'clients/new',
    title: 'Nuevo cliente',
    loadComponent: () => import('./features/clients/client-form.page').then((m) => m.ClientFormPage),
  },
  // clients/:id/edit va antes de clients/:id (US4).
  {
    path: 'clients/:id/edit',
    title: 'Editar cliente',
    loadComponent: () => import('./features/clients/client-form.page').then((m) => m.ClientFormPage),
  },
  {
    path: 'clients/:id',
    title: 'Ficha del cliente',
    loadComponent: () => import('./features/clients/client-detail.page').then((m) => m.ClientDetailPage),
  },
  // vehicles/new va antes de vehicles/:id para que "new" no se lea como un id.
  {
    path: 'vehicles/new',
    title: 'Nuevo vehículo',
    loadComponent: () => import('./features/vehicles/vehicle-form.page').then((m) => m.VehicleFormPage),
  },
  // vehicles/:id/edit va antes de vehicles/:id (US4).
  {
    path: 'vehicles/:id/edit',
    title: 'Editar vehículo',
    loadComponent: () => import('./features/vehicles/vehicle-form.page').then((m) => m.VehicleFormPage),
  },
  {
    path: 'vehicles/:id',
    title: 'Ficha del vehículo',
    loadComponent: () => import('./features/vehicles/vehicle-detail.page').then((m) => m.VehicleDetailPage),
  },
  ...devRoutes,
];
