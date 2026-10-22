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
  {
    path: 'clients/new',
    title: 'Nuevo cliente',
    loadComponent: () => import('./features/clients/client-form.page').then((m) => m.ClientFormPage),
  },
  ...devRoutes,
];
