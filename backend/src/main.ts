import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import { loadEnv } from './config/env.js';
import { loadRootEnvFile } from './config/env-file.js';

async function bootstrap() {
  loadRootEnvFile();
  // Fails fast with a clear message if the configuration is missing or invalid.
  const env = loadEnv();
  const app = await NestFactory.create(AppModule);
  await app.listen(env.port);
}
await bootstrap();
