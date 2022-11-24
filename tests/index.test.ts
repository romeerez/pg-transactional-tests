import { Client, Pool } from 'pg';
import {
  patchPgForTransactions,
  rollbackTransaction,
  startTransaction,
  unpatchPgForTransactions,
} from '../src';

const config = { connectionString: process.env.DATABASE_URL, max: 1 };
const client = new Client(config);
const pool = new Pool(config);
const { connect: originalConnect } = client;
const { connect: originalPoolConnect } = pool;

patchPgForTransactions();

const insertSql = `INSERT INTO sample("text") VALUES ('value')`;

const getCount = async () => {
  const {
    rows: [{ count }],
  } = await client.query(`SELECT count(*) FROM sample`);
  return +count;
};

describe('pg-transactional-tests', () => {
  describe('patch database client', () => {
    beforeAll(startTransaction);
    beforeEach(startTransaction);
    afterEach(rollbackTransaction);
    afterAll(async () => {
      await rollbackTransaction();
      await client.end();
    });

    it('should leave db empty after running this test', async () => {
      await client.connect();
      const poolClient = await pool.connect();
      await Promise.all([client.query(insertSql), poolClient.query(insertSql)]);
      await poolClient.release();
      await pool.end();
      expect(await getCount()).toBe(2);
    });

    it('should have an empty db now', async () => {
      expect(await getCount()).toBe(0);
    });

    describe('nested describe', () => {
      beforeAll(async () => {
        await startTransaction();
        await client.query(insertSql);
      });

      afterAll(async () => {
        await rollbackTransaction();
      });

      it('should have record created in beforeAll', async () => {
        expect(await getCount()).toBe(1);
      });
    });

    it('should support nested transactions, case insensitive', async () => {
      await client.query('STaRT TRANSaCTION');
      await client.query('COmMIT');
      await client.query('BeGiN');
      await client.query('ROLlBaCK');
    });

    it('should still have an empty db', async () => {
      expect(await getCount()).toBe(0);
    });

    it('should handle errors in pool', async () => {
      await expect(() =>
        pool.query('SELECT * FROM nonExistingTable'),
      ).rejects.toThrow();
    });
  });

  test('unpatch database client', () => {
    expect(client.connect).not.toBe(originalConnect);
    expect(pool.connect).not.toBe(originalPoolConnect);

    unpatchPgForTransactions();

    expect(client.connect).toBe(originalConnect);
    expect(pool.connect).toBe(originalPoolConnect);
  });
});
