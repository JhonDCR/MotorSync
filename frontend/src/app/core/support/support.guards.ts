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
import { SupportSessionStore } from './support-session.store';

export const SUPPORT_HOME_PATH = '/support';
export const SUPPORT_LOGIN_PATH = '/support/login';
export const SUPPORT_CHANGE_PASSWORD_PATH = '/support/change-password';

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
 * Support panel routes (research R4, R13, FR-008, US2-AC4, US2-AC5).
 * Without a support session → `/support/login` (even when a workshop session is active).
 * With `mustChangePassword()` → only `/support/change-password` opens.
 */
export const supportAuthGuard: CanMatchFn & CanActivateFn = (
  _route,
  segmentsOrState?: UrlSegment[] | RouterStateSnapshot,
): Observable<boolean | UrlTree> => {
  const store = inject(SupportSessionStore);
  const router = inject(Router);
  const url = requestedUrl(router, segmentsOrState);
  return store.restore().pipe(
    map((signedIn) => {
      if (!signedIn) {
        return router.createUrlTree([SUPPORT_LOGIN_PATH], { queryParams: { returnUrl: url } });
      }
      if (store.mustChangePassword() && url.split(/[?#]/)[0] !== SUPPORT_CHANGE_PASSWORD_PATH) {
        return router.createUrlTree([SUPPORT_CHANGE_PASSWORD_PATH]);
      }
      return true;
    }),
  );
};

/** `/support/login`: with a support session redirects to `/support`; without one allows access. */
export const supportGuestGuard: CanMatchFn & CanActivateFn = (): Observable<boolean | UrlTree> => {
  const router = inject(Router);
  return inject(SupportSessionStore)
    .restore()
    .pipe(map((signedIn) => (signedIn ? router.createUrlTree(['/support']) : true)));
};
