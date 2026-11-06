/**
 * Where multer puts an upload: straight to `<UPLOAD_DIR>/.incoming/<uuid>`,
 * through an inspector that hashes it and keeps only its head, so a 20 MB
 * upload costs the API one stream buffer (64 KB), not 20 MB per request.
 *
 * The file is judged after it lands (`sniffInspection` on what the inspector
 * gathered) and then adopted by rename or removed by the service. multer
 * calls `_removeFile` itself when it aborts (size limit, a dropped
 * connection), and anything a crash leaves behind is swept by the ingest
 * worker (`sweepUploads`, older than ten minutes).
 */
import { createWriteStream } from 'node:fs';
import { rm } from 'node:fs/promises';
import { Transform, type TransformCallback } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { createInspector, incomingFilePath, type Inspection } from '@rag/shared/server';
import type { Request } from 'express';
import type { StorageEngine } from 'multer';

/** What the service receives in place of multer's `buffer`. */
export interface IncomingUpload {
  readonly originalname: string;
  /** The staged file; the service adopts or removes it. */
  readonly path: string;
  readonly inspection: Inspection;
}

type MulterFile = Express.Multer.File & { inspection?: Inspection };

export function uploadStorage(uploadDir: string): StorageEngine {
  return {
    _handleFile(_req: Request, file: MulterFile, done) {
      const inspector = createInspector();
      void (async () => {
        const path = await incomingFilePath(uploadDir);
        try {
          await pipeline(
            file.stream,
            new Transform({
              transform(chunk: Buffer, _encoding: BufferEncoding, next: TransformCallback) {
                inspector.push(chunk);
                next(null, chunk);
              },
            }),
            createWriteStream(path, { flags: 'wx' }),
          );
        } catch (error) {
          await rm(path, { force: true });
          throw error;
        }
        const inspection = inspector.finish();
        return { path, size: inspection.bytes, inspection };
      })().then(
        (info) => done(null, info),
        (error: unknown) => done(error instanceof Error ? error : new Error('upload failed')),
      );
    },
    _removeFile(_req: Request, file: MulterFile, done) {
      if (typeof file.path !== 'string') return done(null);
      rm(file.path, { force: true }).then(
        () => done(null),
        (error: unknown) => done(error instanceof Error ? error : new Error('remove failed')),
      );
    },
  };
}
