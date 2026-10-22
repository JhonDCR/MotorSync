import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { ApplicationConfig, provideBrowserGlobalErrorListeners } from '@angular/core';
import { provideRouter } from '@angular/router';
import { environment } from '../environments/environment';
import { routes } from './app.routes';
import { mockApiInterceptor } from './core/api/mock-api.interceptor';
import { USE_MOCK_API } from './core/api/use-mock-api';
import { authTokenInterceptor } from './core/auth/auth-token.interceptor';

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideRouter(routes),
    { provide: USE_MOCK_API, useValue: environment.useMockApi },
    // mockApiInterceptor va después de authTokenInterceptor: con USE_MOCK_API en false no hace nada.
    provideHttpClient(withInterceptors([authTokenInterceptor, mockApiInterceptor])),
  ],
};
