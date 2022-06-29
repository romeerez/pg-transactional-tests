import { Client, Pool } from 'pg';
import {
  patchPgForTransactions,
  rollbackTransaction,
  startTransaction,
} from '../src';

const config = { connectionString: process.env.DATABASE_URL, max: 1 };
const client = new Client(config);
const pool = new Pool(config);

patchPgForTransactions();

const insertSql = `INSERT INTO sample("text") VALUES ('value')`;

const getCount = async () => {
  const {
    rows: [{ count }],
  } = await client.query(`SELECT count(*) FROM sample`);
  return +count;
};

describe('pg-transactional-tests', () => {
  beforeAll(async () => {
    await startTransaction(client);
  });
  beforeEach(async () => {
    await startTransaction(client);
  });
  afterEach(async () => {
    await rollbackTransaction(client);
  });
  afterAll(async () => {
    await rollbackTransaction(client);
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
      await startTransaction(client);
      await client.query(insertSql);
    });

    afterAll(async () => {
      await rollbackTransaction(client);
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
});
