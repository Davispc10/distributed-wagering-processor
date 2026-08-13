import { ApiModule } from './app/ApiModule';
import { bootstrap } from './bootstrap';

void bootstrap({ module: ApiModule, serviceName: 'wagering-api' }).catch((error: unknown) => {
  console.error('falha ao iniciar a API:', error instanceof Error ? error.stack : error);
  process.exit(1);
});
