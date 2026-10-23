import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { ApplicationConfig, inject, provideAppInitializer, provideBrowserGlobalErrorListeners } from '@angular/core';
import { provideRouter } from '@angular/router';
import { environment } from '../environments/environment';
import { routes } from './app.routes';
import { mockApiInterceptor } from './core/api/mock-api.interceptor';
import { USE_MOCK_API } from './core/api/use-mock-api';
import { authRefreshInterceptor } from './core/auth/auth-refresh.interceptor';
import { authTokenInterceptor } from './core/auth/auth-token.interceptor';
import { SessionStore } from './core/auth/session.store';

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideRouter(routes),
    { provide: USE_MOCK_API, useValue: environment.useMockApi },
    // Order: the token first, then the refresh (it sees the 401 of the real request and retries with the new token),
    // and the mock last: with USE_MOCK_API false it does nothing.
    provideHttpClient(withInterceptors([authTokenInterceptor, authRefreshInterceptor, mockApiInterceptor])),
    // Restores the session after a page reload (GET /auth/me only when a token is stored). It does not wait for
    // the answer, so the shell renders at once; the guard of the first navigation shares the same request.
    provideAppInitializer(() => {
      inject(SessionStore).restore().subscribe();
    }),
  ],
};
