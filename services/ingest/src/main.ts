/**
 * The ingest worker's entry point. Config is parsed before anything connects,
 * so a missing variable is a sentence naming it, not a stack trace.
 *
 * SIGTERM closes the consumer gracefully: BullMQ lets the running job finish
 * (or its lock expire and another worker take it), which is what makes a
 * restart during an ingestion safe.
 */
import { startIngest } from './app';
import { loadConfig } from './config';

async function main(): Promise<void> {
  const config = loadConfig();
  const running = await startIngest(config);
  let closing = false;
  const stop = () => {
    if (closing) return;
    closing = true;
    running.close().then(
      () => process.exit(0),
      (error: unknown) => {
        console.error(error instanceof Error ? error.message : String(error));
        process.exit(1);
      },
    );
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
