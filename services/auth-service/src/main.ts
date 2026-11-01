import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { configureApp } from '@toka/nest-common';
import cookieParser from 'cookie-parser';
import { AppModule } from './app.module';
import { loadEnv } from './infrastructure/config/env';

async function bootstrap(): Promise<void> {
  const env = loadEnv();
  const app = await NestFactory.create(AppModule.forRoot(env), { bufferLogs: true });
  configureApp(app, { trustProxyHops: env.TRUST_PROXY_HOPS });
  // Sin firma: la cookie de refresh es un token opaco de 32 bytes aleatorios, su valor ya es
  // imposible de adivinar y la base guarda solo su hash. Firmarla no agregaría seguridad.
  app.use(cookieParser());
  await app.listen(env.PORT, '0.0.0.0');
}

void bootstrap();
