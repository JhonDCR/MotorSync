import { HttpErrorResponse } from '@angular/common/http';
import { catchError, Observable, throwError } from 'rxjs';
import { isProblem } from './problem';

/**
 * Errors with a Problem body (application/problem+json) fail with that Problem. Any other error
 * (for example a network failure with status 0) fails with the original HttpErrorResponse.
 */
export function toProblem<T>(source: Observable<T>): Observable<T> {
  return source.pipe(
    catchError((error: unknown) =>
      throwError(() => (error instanceof HttpErrorResponse && isProblem(error.error) ? error.error : error)),
    ),
  );
}
