import { rakeDb } from 'rake-db';
import { dbUrls } from './config';

export const change = rakeDb(
  dbUrls.map((url) => ({ databaseURL: url })),
  {
    migrationsPath: './migrations',
    import: (path) => import(path),
  },
);
