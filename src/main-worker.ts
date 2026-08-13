import { WorkerModule } from './app/WorkerModule';
import { bootstrap } from './bootstrap';

void bootstrap({ module: WorkerModule, serviceName: 'wagering-worker' }).catch((error: unknown) => {
  console.error('falha ao iniciar o worker:', error instanceof Error ? error.stack : error);
  process.exit(1);
});
