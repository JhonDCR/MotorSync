// T017 (specs/003-soporte-plataforma): new contract codes of ProblemDetailsFilter
// (HELP_RATE_LIMITED, TICKET_NOT_OPEN, ACCOUNT_INACTIVE) and the 001/002 regression.
// The real filter runs over a fake ArgumentsHost that captures the status, the Content-Type
// header and the JSON body, as in session-validator.spec.ts. No module mocks.
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  NotFoundException,
  UnauthorizedException,
  type ArgumentsHost,
} from '@nestjs/common';
import {
  ProblemDetailsFilter,
  ProblemException,
} from './problem-details.filter.js';

interface ProblemBody {
  type: string;
  title: string;
  status: number;
  code: string;
}

interface CapturedProblem {
  status: number;
  contentType: string | undefined;
  body: ProblemBody;
}

interface FakeResponse {
  status: (value: number) => FakeResponse;
  setHeader: (name: string, value: string) => FakeResponse;
  send: (body: string) => FakeResponse;
}

/** Runs the real filter and captures what it would send over HTTP. */
function problemOf(exception: unknown): CapturedProblem {
  let status = 0;
  let contentType: string | undefined;
  let sent = '';
  const response: FakeResponse = {
    status: (value) => {
      status = value;
      return response;
    },
    setHeader: (name, value) => {
      if (name.toLowerCase() === 'content-type') contentType = value;
      return response;
    },
    send: (body) => {
      sent = body;
      return response;
    },
  };
  const host = {
    switchToHttp: () => ({
      getResponse: () => response,
      getRequest: () => ({}),
    }),
  } as unknown as ArgumentsHost;

  new ProblemDetailsFilter().catch(exception, host);

  return { status, contentType, body: JSON.parse(sent) as ProblemBody };
}

function expectProblem(
  exception: unknown,
  status: number,
  code: string,
): ProblemBody {
  const captured = problemOf(exception);
  expect(captured.status).toBe(status);
  expect(captured.contentType).toMatch(/^application\/problem\+json/);
  const { body } = captured;
  expect(body.type).toBe('about:blank');
  expect(typeof body.title).toBe('string');
  expect(body.title.length).toBeGreaterThan(0);
  expect(body.status).toBe(status);
  expect(body.code).toBe(code);
  return body;
}

describe('ProblemDetailsFilter: códigos de soporte (T017, contrato Problem)', () => {
  it('[T017][US1-AC6] HELP_RATE_LIMITED → 429 problem+json con su code', () => {
    expectProblem(
      new ProblemException(429, 'HELP_RATE_LIMITED'),
      429,
      'HELP_RATE_LIMITED',
    );
  });

  it('[T017][US2-AC13] TICKET_NOT_OPEN → 409 problem+json con su code', () => {
    expectProblem(
      new ProblemException(409, 'TICKET_NOT_OPEN'),
      409,
      'TICKET_NOT_OPEN',
    );
  });

  it('[T017][US3-AC8] ACCOUNT_INACTIVE → 409 problem+json con su code', () => {
    expectProblem(
      new ProblemException(409, 'ACCOUNT_INACTIVE'),
      409,
      'ACCOUNT_INACTIVE',
    );
  });

  it('[T017] los códigos de la 001 y la 002 no cambian', () => {
    expectProblem(new UnauthorizedException(), 401, 'UNAUTHORIZED');
    expectProblem(new ForbiddenException(), 403, 'FORBIDDEN');
    expectProblem(new HttpException('x', 429), 429, 'ACCOUNT_LOCKED');
    expectProblem(new NotFoundException(), 404, 'NOT_FOUND');
    expectProblem(new BadRequestException(), 400, 'VALIDATION_ERROR');
    expectProblem(new ConflictException(), 409, 'VALIDATION_ERROR');
    expectProblem(
      new ProblemException(409, 'EMAIL_UNAVAILABLE'),
      409,
      'EMAIL_UNAVAILABLE',
    );
    expectProblem(new ProblemException(409, 'LAST_ADMIN'), 409, 'LAST_ADMIN');
  });

  it('[T017] un error inesperado → 500 INTERNAL_ERROR sin filtrar su mensaje', () => {
    const body = expectProblem(new Error('boom'), 500, 'INTERNAL_ERROR');
    expect(JSON.stringify(body)).not.toContain('boom');
  });
});
