import { STATUS_CODES } from 'node:http';
import {
  Catch,
  HttpException,
  HttpStatus,
  Logger,
  type ArgumentsHost,
  type ExceptionFilter,
} from '@nestjs/common';
import type { Response } from 'express';
import { translatePgError, type FieldError } from '../database/pg-errors.js';

export interface ProblemExtra {
  errors?: FieldError[];
  existingId?: string;
  current?: unknown;
}

/** Body of every error response (contract `Problem` schema), served as application/problem+json. */
export interface ProblemBody extends ProblemExtra {
  type: string;
  title: string;
  status: number;
  code: string;
}

/** Domain error with a contract `code` and, optionally, errors[], existingId or current. */
export class ProblemException extends HttpException {
  constructor(
    status: number,
    readonly code: string,
    readonly extra: ProblemExtra = {},
  ) {
    super(code, status);
  }
}

const INTERNAL_ERROR_CODE = 'INTERNAL_ERROR';

function titleOf(status: number): string {
  return STATUS_CODES[status] ?? 'Error';
}

/** Contract code for an HttpException that does not carry one (thrown by Nest or by guards). */
function codeForStatus(status: number): string {
  if (status === 401) return 'UNAUTHORIZED';
  if (status === 404 || status === 405) return 'NOT_FOUND';
  if (status >= 400 && status < 500) return 'VALIDATION_ERROR';
  return INTERNAL_ERROR_CODE;
}

function problem(status: number, code: string, extra: ProblemExtra = {}): ProblemBody {
  const body: ProblemBody = { type: 'about:blank', title: titleOf(status), status, code };
  if (extra.errors !== undefined) body.errors = extra.errors;
  if (extra.existingId !== undefined) body.existingId = extra.existingId;
  if (extra.current !== undefined) body.current = extra.current;
  return body;
}

/** Global filter: every error leaves as application/problem+json (contract `Problem`). */
@Catch()
export class ProblemDetailsFilter implements ExceptionFilter {
  private readonly logger = new Logger(ProblemDetailsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const body = this.toProblem(exception);
    const response = host.switchToHttp().getResponse<Response>();
    response
      .status(body.status)
      .setHeader('Content-Type', 'application/problem+json; charset=utf-8')
      .send(JSON.stringify(body));
  }

  private toProblem(exception: unknown): ProblemBody {
    if (exception instanceof ProblemException) {
      return problem(exception.getStatus(), exception.code, exception.extra);
    }
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      if (status >= 500) this.logger.error(exception.message, exception.stack);
      return problem(status, codeForStatus(status));
    }
    const translated = translatePgError(exception);
    if (translated) {
      return problem(translated.status, translated.code, { errors: translated.errors });
    }
    // Unexpected error: logged on the server, but its message never reaches the client.
    this.logger.error(
      exception instanceof Error ? exception.message : String(exception),
      exception instanceof Error ? exception.stack : undefined,
    );
    return problem(HttpStatus.INTERNAL_SERVER_ERROR, INTERNAL_ERROR_CODE);
  }
}
