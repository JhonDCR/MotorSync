import { inject } from '@angular/core';
import {
  type CanActivateFn,
  type CanMatchFn,
  Router,
  type RouterStateSnapshot,
  type UrlSegment,
  type UrlTree,
} from '@angular/router';
import { map, type Observable } from 'rxjs';
import { SessionStore } from './session.store';

export const LOGIN_PATH = '/login';
export const CHANGE_PASSWORD_PATH = '/change-password';

/**
 * Full URL being navigated to, with its query. canMatch only receives the segments of the route, so the target
 * comes from the current navigation; the segments are the fallback.
 */
function requestedUrl(router: Router, segmentsOrState?: UrlSegment[] | RouterStateSnapshot): string {
  if (segmentsOrState && 'url' in segmentsOrState && typeof segmentsOrState.url === 'string') {
    return segmentsOrState.url;
  }
  const target = router.currentNavigation()?.extractedUrl;
  if (target !== undefined) {
    return router.serializeUrl(target);
  }
  if (Array.isArray(segmentsOrState)) {
    return `/${segmentsOrState.map((segment) => segment.path).join('/')}`;
  }
  return router.url;
}

/**
 * Workshop routes (research R13, FR-010). Without a session → /login?returnUrl=<requested url>. With a temporary
 * password still to change, only /change-password opens; any other protected route leads there (US5-AC1, FR-026).
 * The state comes from SessionStore (server responses), never from the JWT.
 */
export const authGuard: CanMatchFn & CanActivateFn = (
  _route,
  segmentsOrState?: UrlSegment[] | RouterStateSnapshot,
): Observable<boolean | UrlTree> => {
  const store = inject(SessionStore);
  const router = inject(Router);
  const url = requestedUrl(router, segmentsOrState);
  return store.restore().pipe(
    map((signedIn) => {
      if (!signedIn) {
        return router.createUrlTree([LOGIN_PATH], { queryParams: { returnUrl: url } });
      }
      if (store.mustChangePassword() && url.split(/[?#]/)[0] !== CHANGE_PASSWORD_PATH) {
        return router.createUrlTree([CHANGE_PASSWORD_PATH]);
      }
      return true;
    }),
  );
};

/** Admin-only routes; goes after authGuard. Any other role returns to the start screen (US4-AC16). */
export const adminGuard: CanMatchFn & CanActivateFn = (): boolean | UrlTree => {
  const store = inject(SessionStore);
  return store.user()?.role === 'admin' ? true : inject(Router).createUrlTree(['/']);
};

/** /login and /register: with a session there is nothing to do there, so they lead to the start screen. */
export const guestGuard: CanMatchFn & CanActivateFn = (): Observable<boolean | UrlTree> => {
  const router = inject(Router);
  return inject(SessionStore)
    .restore()
    .pipe(map((signedIn) => (signedIn ? router.createUrlTree(['/']) : true)));
};
