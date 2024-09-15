import { change } from '../dbScript';

change(async (db) => {
  await db.createTable('sample', { noPrimaryKey: true }, (t) => ({
    text: t.text(),
  }));
});
