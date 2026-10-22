import { Body, Controller, Get, HttpCode, Inject, Param, Post, Res } from '@nestjs/common';
import type { Response } from 'express';
import { API_PREFIX } from '../app.setup.js';
import { ClientsService, type ClientDetail } from './clients.service.js';
import { CreateClientDto } from './dto/create-client.dto.js';

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

  /** GET /api/v1/clients/{clientId}: 404 NOT_FOUND for missing, foreign or malformed ids. */
  @Get(':clientId')
  getById(@Param('clientId') clientId: string): Promise<ClientDetail> {
    return this.clients.getById(clientId);
  }
}
