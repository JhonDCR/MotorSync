// T013: problem+json responses (contract `Problem` schema) through the real HTTP wiring.
// The app is configured with configureApp() (prefix /api/v1, global ValidationPipe and
// ProblemDetailsFilter), the same function main.ts uses, over a test-only controller.
import { randomUUID } from 'node:crypto';
import {
  Body,
  Controller,
  Get,
  HttpCode,
  NotFoundException,
  Post,
  UnauthorizedException,
  type INestApplication,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { IsInt, IsString, Max, MaxLength, Min } from 'class-validator';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { QueryFailedError } from 'typeorm';
import { configureApp } from '../app.setup.js';
import { ProblemDetailsFilter, ProblemException } from './problem-details.filter.js';

class SampleDto {
  @IsString()
  @MaxLength(20)
  name: string;

  @IsInt()
  @Min(0)
  @Max(10)
  amount: number;
}

const EXISTING_ID = randomUUID();
const CURRENT = { id: randomUUID(), version: 3, displayName: 'Ana Pérez' };

@Controller('problems')
class ProblemsTestController {
  @Post('validate')
  @HttpCode(200)
  validate(@Body() dto: SampleDto): { received: SampleDto; isInstance: boolean } {
    return { received: dto, isInstance: dto instanceof SampleDto };
  }

  @Get('unauthorized')
  unauthorized(): never {
    throw new UnauthorizedException();
  }

  @Get('not-found')
  notFound(): never {
    throw new NotFoundException();
  }

  @Get('duplicate')
  duplicate(): never {
    throw new ProblemException(409, 'DOCUMENT_ALREADY_EXISTS', { existingId: EXISTING_ID });
  }

  @Get('version-conflict')
  versionConflict(): never {
    throw new ProblemException(409, 'VERSION_CONFLICT', { current: CURRENT });
  }

  @Get('field-error')
  fieldError(): never {
    throw new ProblemException(400, 'VALIDATION_ERROR', {
      errors: [{ field: 'phone', code: 'INVALID_PHONE', message: 'Teléfono inválido' }],
    });
  }

  @Get('plate-check')
  plateCheck(): never {
    const driverError = Object.assign(
      new Error('new row for relation "vehicles" violates check constraint "vehicles_plate_format"'),
      { code: '23514', constraint: 'vehicles_plate_format' },
    );
    throw new QueryFailedError('INSERT INTO vehicles ...', [], driverError);
  }

  @Get('boom')
  boom(): never {
    throw new Error('secret internal detail: connection string postgres://x');
  }
}

interface ProblemBody {
  type: unknown;
  title: unknown;
  status: unknown;
  code: unknown;
  detail?: unknown;
  errors?: { field: string; code: string; message: string }[];
  existingId?: unknown;
  current?: unknown;
}

function expectProblem(res: request.Response, status: number, code: string): ProblemBody {
  expect(res.status).toBe(status);
  expect(res.headers['content-type']).toMatch(/^application\/problem\+json/);
  const body = res.body as ProblemBody;
  expect(typeof body.type).toBe('string');
  expect((body.type as string).length).toBeGreaterThan(0);
  expect(typeof body.title).toBe('string');
  expect((body.title as string).length).toBeGreaterThan(0);
  expect(body.status).toBe(status);
  expect(body.code).toBe(code);
  return body;
}

describe('ProblemDetailsFilter (T013, contrato Problem)', () => {
  let app: INestApplication<App>;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [ProblemsTestController],
    }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
  });

  it('[T013] ProblemDetailsFilter se exporta como filtro de excepciones', () => {
    expect(typeof ProblemDetailsFilter).toBe('function');
    expect(typeof ProblemDetailsFilter.prototype.catch).toBe('function');
  });

  it('[T013] el prefijo global es /api/v1', async () => {
    const payload = { name: 'Ana', amount: 1 };
    const unprefixed = await request(app.getHttpServer()).post('/problems/validate').send(payload);
    // Outside the prefix the route simply does not exist. The body format there is not part of
    // the contract (Express may answer before the Nest filter), so only the status is checked.
    expect(unprefixed.status).toBe(404);
    const prefixed = await request(app.getHttpServer())
      .post('/api/v1/problems/validate')
      .send(payload);
    expect(prefixed.status).toBe(200);
  });

  it('[T013] un body válido pasa el ValidationPipe y se transforma a la clase del DTO', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/problems/validate')
      .send({ name: 'Ana', amount: 3 });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ received: { name: 'Ana', amount: 3 }, isInstance: true });
  });

  it('[T013][Principio I] una propiedad no permitida (tenantId) produce VALIDATION_ERROR con errors[].code = UNKNOWN_FIELD', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/problems/validate')
      .send({ name: 'Ana', amount: 3, tenantId: randomUUID() });

    const body = expectProblem(res, 400, 'VALIDATION_ERROR');
    expect(body.errors).toEqual([
      expect.objectContaining({ field: 'tenantId', code: 'UNKNOWN_FIELD' }),
    ]);
    expect(typeof body.errors?.[0].message).toBe('string');
    expect(body.errors?.[0].message.length).toBeGreaterThan(0);
  });

  it('[T013] los errores de validación de campos van en errors[] con field, code y message', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/problems/validate')
      .send({ name: 'x'.repeat(21), amount: 99 });

    const body = expectProblem(res, 400, 'VALIDATION_ERROR');
    const fields = (body.errors ?? []).map((error) => error.field).sort();
    expect(fields).toEqual(['amount', 'name']);
    for (const error of body.errors ?? []) {
      expect(typeof error.code).toBe('string');
      expect(error.code.length).toBeGreaterThan(0);
      expect(typeof error.message).toBe('string');
      expect(error.message.length).toBeGreaterThan(0);
    }
  });

  it('[T013] UnauthorizedException → 401 UNAUTHORIZED', async () => {
    const res = await request(app.getHttpServer()).get('/api/v1/problems/unauthorized');
    expectProblem(res, 401, 'UNAUTHORIZED');
  });

  it('[T013] NotFoundException y rutas inexistentes → 404 NOT_FOUND', async () => {
    expectProblem(
      await request(app.getHttpServer()).get('/api/v1/problems/not-found'),
      404,
      'NOT_FOUND',
    );
    expectProblem(
      await request(app.getHttpServer()).get('/api/v1/no-such-route'),
      404,
      'NOT_FOUND',
    );
  });

  it('[T013] *_ALREADY_EXISTS incluye existingId', async () => {
    const res = await request(app.getHttpServer()).get('/api/v1/problems/duplicate');
    const body = expectProblem(res, 409, 'DOCUMENT_ALREADY_EXISTS');
    expect(body.existingId).toBe(EXISTING_ID);
    expect(body.current).toBeUndefined();
  });

  it('[T013] VERSION_CONFLICT incluye current con el estado actual del recurso', async () => {
    const res = await request(app.getHttpServer()).get('/api/v1/problems/version-conflict');
    const body = expectProblem(res, 409, 'VERSION_CONFLICT');
    expect(body.current).toEqual(CURRENT);
    expect(body.existingId).toBeUndefined();
  });

  it('[T013] un ProblemException con errors[] los devuelve tal cual', async () => {
    const res = await request(app.getHttpServer()).get('/api/v1/problems/field-error');
    const body = expectProblem(res, 400, 'VALIDATION_ERROR');
    expect(body.errors).toEqual([
      { field: 'phone', code: 'INVALID_PHONE', message: 'Teléfono inválido' },
    ]);
  });

  it('[T013] un 23514 de vehicles_plate_format sin capturar → 400 VALIDATION_ERROR con INVALID_PLATE', async () => {
    const res = await request(app.getHttpServer()).get('/api/v1/problems/plate-check');
    const body = expectProblem(res, 400, 'VALIDATION_ERROR');
    expect(body.errors).toEqual([expect.objectContaining({ field: 'plate', code: 'INVALID_PLATE' })]);
  });

  it('[T013] un error inesperado → 500 problem+json sin filtrar detalles internos', async () => {
    const res = await request(app.getHttpServer()).get('/api/v1/problems/boom');
    expect(res.status).toBe(500);
    expect(res.headers['content-type']).toMatch(/^application\/problem\+json/);
    const body = res.body as ProblemBody;
    expect(body.status).toBe(500);
    expect(typeof body.title).toBe('string');
    expect(JSON.stringify(body)).not.toContain('secret internal detail');
    expect(JSON.stringify(body)).not.toContain('postgres://');
  });
});
