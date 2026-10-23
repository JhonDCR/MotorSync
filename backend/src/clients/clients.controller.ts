import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import { API_PREFIX } from '../app.setup.js';
import {
  ClientsService,
  type ClientDetail,
  type ClientSearchResponse,
} from './clients.service.js';
import { CreateClientDto } from './dto/create-client.dto.js';
import { UpdateClientDto } from './dto/update-client.dto.js';

@Controller('clients')
export class ClientsController {
  constructor(@Inject(ClientsService) private readonly clients: ClientsService) {}

  /** POST /api/v1/clients (US2): 201 with Location /api/v1/clients/{id}. */
  @Post()
  @HttpCode(201)
  async create(
    @Body() dto: CreateClientDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ClientDetail> {
    const client = await this.clients.create(dto);
    res.setHeader('Location', `/${API_PREFIX}/clients/${client.id}`);
    return client;
  }

  /**
   * GET /api/v1/clients/search?q= (US4). Declared before :clientId so that "search" is never
   * taken as a client id. 400 SEARCH_TERM_TOO_SHORT when q is missing or shorter than 2.
   */
  @Get('search')
  search(@Query('q') q?: string | string[]): Promise<ClientSearchResponse> {
    return this.clients.search(q);
  }

  /** GET /api/v1/clients/{clientId}: 404 NOT_FOUND for missing, foreign or malformed ids. */
  @Get(':clientId')
  getById(@Param('clientId') clientId: string): Promise<ClientDetail> {
    return this.clients.getById(clientId);
  }

  /**
   * PATCH /api/v1/clients/{clientId} (US4-AC4, AC5, AC11, AC12): 200 ClientDetail with
   * version + 1; 409 VERSION_CONFLICT with current; 404 NOT_FOUND for missing or foreign ids.
   */
  @Patch(':clientId')
  update(@Param('clientId') clientId: string, @Body() dto: UpdateClientDto): Promise<ClientDetail> {
    return this.clients.update(clientId, dto);
  }
}
