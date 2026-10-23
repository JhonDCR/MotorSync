// T016 (specs/002-autenticacion): new codes of ProblemDetailsFilter.codeForStatus (research R12).
// Same wiring as problem-details.filter.spec.ts of the 001 (configureApp over a test-only
// controller), which is not touched.
import {
  BadRequestException,
  ConflictException,
  Controller,
  ForbiddenException,
  Get,
  HttpException,
  HttpStatus,
  NotFoundException,
  UnauthorizedException,
  type INestApplication,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { QueryFailedError } from 'typeorm';
import { configureApp } from '../app.setup.js';
import { ProblemException } from './problem-details.filter.js';

function pgFailure(code: string, constraint: string): QueryFailedError {
  const driverError = Object.assign(new Error(`violates constraint "${constraint}"`), {
    code,
    constraint,
  });
  return new QueryFailedError('INSERT ...', [], driverError);
}

@Controller('auth-problems')
class AuthProblemsTestController {
  @Get('forbidden')
  forbidden(): never {
    throw new ForbiddenException();
  }

  @Get('forbidden-raw')
  forbiddenRaw(): never {
    throw new HttpException('Forbidden resource', HttpStatus.FORBIDDEN);
  }

  @Get('too-many')
  tooMany(): never {
    throw new HttpException('Too Many Requests', HttpStatus.TOO_MANY_REQUESTS);
  }

  @Get('password-change-required')
  passwordChangeRequired(): never {
    throw new ProblemException(403, 'PASSWORD_CHANGE_REQUIRED');
  }

  @Get('session-expired')
  sessionExpired(): never {
    throw new ProblemException(401, 'SESSION_EXPIRED');
  }

  @Get('unauthorized')
  unauthorized(): never {
    throw new UnauthorizedException();
  }

  @Get('not-found')
  notFound(): never {
    throw new NotFoundException();
  }

  @Get('bad-request')
  badRequest(): never {
    throw new BadRequestException();
  }

  @Get('conflict')
  conflict(): never {
    throw new ConflictException();
  }

  @Get('ruc-duplicate')
  rucDuplicate(): never {
    throw pgFailure('23505', 'tenants_ruc_key');
  }

  @Get('email-duplicate')
  emailDuplicate(): never {
    throw pgFailure('23505', 'users_email_key');
  }

  @Get('last-admin')
  lastAdmin(): never {
    throw pgFailure('23514', 'users_last_admin');
  }
}

interface Body {
  type: unknown;
  title: unknown;
  status: unknown;
  code: unknown;
}

function expectProblem(res: request.Response, status: number, code: string): Body {
  expect(res.status).toBe(status);
  expect(res.headers['content-type']).toMatch(/^application\/problem\+json/);
  const body = res.body as Body;
  expect(typeof body.type).toBe('string');
  expect(typeof body.title).toBe('string');
  expect(body.status).toBe(status);
  expect(body.code).toBe(code);
  return body;
}

describe('ProblemDetailsFilter: códigos de autenticación (T016, research R12)', () => {
  let app: INestApplication<App>;

  const get = (path: string): Promise<request.Response> =>
    request(app.getHttpServer()).get(`/api/v1/auth-problems/${path}`);

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [AuthProblemsTestController],
    }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
  });

  it('[R12][US4-AC16] un 403 sin code (ForbiddenException) → FORBIDDEN', async () => {
    expectProblem(await get('forbidden'), 403, 'FORBIDDEN');
  });

  it('[R12] un HttpException 403 genérico → FORBIDDEN', async () => {
    expectProblem(await get('forbidden-raw'), 403, 'FORBIDDEN');
  });

  it('[R12][US2-AC5] un 429 sin code → ACCOUNT_LOCKED', async () => {
    expectProblem(await get('too-many'), 429, 'ACCOUNT_LOCKED');
  });

  it('[R12][FR-026] un ProblemException 403 conserva su propio code (PASSWORD_CHANGE_REQUIRED)', async () => {
    expectProblem(await get('password-change-required'), 403, 'PASSWORD_CHANGE_REQUIRED');
  });

  it('[R12][FR-012] un ProblemException 401 conserva su propio code (SESSION_EXPIRED)', async () => {
    expectProblem(await get('session-expired'), 401, 'SESSION_EXPIRED');
  });

  it('[R12][US1-AC5] un 23505 de tenants_ruc_key sin capturar → 409 RUC_ALREADY_REGISTERED', async () => {
    expectProblem(await get('ruc-duplicate'), 409, 'RUC_ALREADY_REGISTERED');
  });

  it('[R12][FR-023] un 23505 de users_email_key sin capturar → 409 EMAIL_UNAVAILABLE', async () => {
    const body = expectProblem(await get('email-duplicate'), 409, 'EMAIL_UNAVAILABLE');
    expect(JSON.stringify(body)).not.toContain('users_email_key');
  });

  it('[R12][FR-018] un 23514 de users_last_admin sin capturar → 409 LAST_ADMIN', async () => {
    expectProblem(await get('last-admin'), 409, 'LAST_ADMIN');
  });

  it('[T016] los códigos de la 001 no cambian: 401, 404, 400 y 409 sin code', async () => {
    expectProblem(await get('unauthorized'), 401, 'UNAUTHORIZED');
    expectProblem(await get('not-found'), 404, 'NOT_FOUND');
    expectProblem(await get('bad-request'), 400, 'VALIDATION_ERROR');
    expectProblem(await get('conflict'), 409, 'VALIDATION_ERROR');
  });
});
