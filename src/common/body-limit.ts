import type { NestExpressApplication } from '@nestjs/platform-express';

/**
 * Batas ukuran body JSON. Default Express hanya 100 KB, terlalu kecil untuk impor Excel
 * (RAB/RAP/BQ ratusan baris dikirim sebagai JSON). Atur lewat BODY_LIMIT di .env (mis. 20mb).
 * File (foto/dokumen) tidak terpengaruh: diunggah lewat multipart dengan batasnya sendiri.
 */
export function configureBodyLimit(app: NestExpressApplication) {
  const limit = process.env.BODY_LIMIT || '20mb';
  app.useBodyParser('json', { limit });
  app.useBodyParser('urlencoded', { limit, extended: true });
}
