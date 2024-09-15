import { Client, Pool } from 'pg';
import {
  patchPgForTransactions,
  rollbackTransaction,
  startTransaction,
  unpatchPgForTransactions,
} from '../src';
import { dbUrls } from './config';

const configs = dbUrls.map((url) => ({
  connectionString: url,
  max: 1,
}));

const clients = configs.map((config) => new Client(config));
const pools = configs.map((config) => new Pool(config));
const originalConnects = clients.map((client) => client.connect);
const originalPoolConnects = pools.map((pool) => pool.connect);

patchPgForTransactions();

const insertSql = `INSERT INTO sample("text") VALUES ('value')`;

const getCounts = () => {
  return Promise.all(
    clients.map(async (client) => {
      const {
        rows: [{ count }],
      } = await client.query(`SELECT count(*) FROM sample`);

      return +count;
    }),
  );
};

describe('pg-transactional-tests', () => {
  describe('patch database client', () => {
    beforeAll(startTransaction);
    beforeEach(startTransaction);
    afterEach(rollbackTransaction);
    afterAll(async () => {
      await rollbackTransaction();
      await Promise.all(clients.map((client) => client.end()));
    });

    it('should leave db empty after running this test', async () => {
      await Promise.all(clients.map((client) => client.connect()));
      const poolClients = await Promise.all(
        pools.map((pool) => pool.connect()),
      );
      await Promise.all([
        ...clients.map((client) => client.query(insertSql)),
        ...poolClients.map((poolClient) => poolClient.query(insertSql)),
      ]);
      await Promise.all(poolClients.map((poolClient) => poolClient.release()));
      await Promise.all(pools.map((pool) => pool.end()));
      expect(await getCounts()).toEqual([2, 2]);
    });

    it('should have an empty db now', async () => {
      expect(await getCounts()).toEqual([0, 0]);
    });

    describe('nested describe', () => {
      beforeAll(async () => {
        await startTransaction();
        await Promise.all(clients.map((client) => client.query(insertSql)));
      });

      afterAll(async () => {
        await rollbackTransaction();
      });

      it('should have record created in beforeAll', async () => {
        expect(await getCounts()).toEqual([1, 1]);
      });
    });

    it('should support nested transactions, case insensitive', async () => {
      await Promise.all(
        clients.map((client) => client.query('STaRT TRANSaCTION')),
      );
      await Promise.all(clients.map((client) => client.query('COmMIT')));
      await Promise.all(clients.map((client) => client.query('BeGiN')));
      await Promise.all(clients.map((client) => client.query('ROLlBaCK')));
    });

    it('should still have an empty db', async () => {
      expect(await getCounts()).toEqual([0, 0]);
    });

    it('should handle errors in pool', async () => {
      await Promise.all(
        pools.map((pool) =>
          expect(() =>
            pool.query('SELECT * FROM nonExistingTable'),
          ).rejects.toThrow(),
        ),
      );
    });
  });

  test('unpatch database client', () => {
    clients.forEach((client, i) =>
      expect(client.connect).not.toBe(originalConnects[i]),
    );

    pools.forEach((pool, i) =>
      expect(pool.connect).not.toBe(originalPoolConnects[i]),
    );

    unpatchPgForTransactions();

    clients.forEach((client, i) =>
      expect(client.connect).toBe(originalConnects[i]),
    );

    pools.forEach((pool, i) =>
      expect(pool.connect).toBe(originalPoolConnects[i]),
    );
  });
});
