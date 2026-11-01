import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { configureApp } from '@toka/nest-common';
import { AppModule } from './app.module';
import { loadEnv } from './infrastructure/config/env';

async function bootstrap(): Promise<void> {
  const env = loadEnv();
  const app = await NestFactory.create(AppModule.forRoot(env), { bufferLogs: true });
  configureApp(app, { trustProxyHops: env.TRUST_PROXY_HOPS });
  await app.listen(env.PORT, '0.0.0.0');
}

void bootstrap();
