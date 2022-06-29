import { Migration } from 'rake-db';

export const change = (db: Migration) => {
  db.createTable('sample', { id: false }, (t) => {
    t.text('text');
  });
};
