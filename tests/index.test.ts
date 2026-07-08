import { Client, Pool } from 'pg';
import { testTransaction } from '../src';
import { dbUrls } from './config';

const configs = dbUrls.map((url) => ({
  connectionString: url,
  max: 2,
}));

const clients = configs.map((config) => new Client(config));
const pools = configs.map((config) => new Pool(config));
const originalConnects = clients.map((client) => client.connect);
const originalPoolConnects = pools.map((pool) => pool.connect);

const insertSql = `INSERT INTO sample("text") VALUES ('value')`;
const insertWithSleepSql = `INSERT INTO sample("text") SELECT $1 FROM pg_sleep(0.05)`;
const pgClientQueryWarning =
  'Calling client.query() when the client is already executing a query is deprecated';

const failOnPgClientQueryWarning = () =>
  jest.spyOn(process, 'emitWarning').mockImplementation(((
    warning: string | Error,
  ) => {
    const message = warning instanceof Error ? warning.message : warning;

    if (typeof message === 'string' && message.includes(pgClientQueryWarning)) {
      throw new Error(message);
    }
  }) as typeof process.emitWarning);

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
  describe('single started transaction', () => {
    afterEach(testTransaction.close);

    it('should start the transaction before concurrent queued queries', async () => {
      const setupClient = new Client(configs[0]);
      const client = new Client(configs[0]);
      const emitWarning = failOnPgClientQueryWarning();

      try {
        await setupClient.connect();
        await setupClient.query('TRUNCATE sample');

        testTransaction.start();

        await Promise.all([
          client.query(insertWithSleepSql, ['single-a']),
          client.query(insertWithSleepSql, ['single-b']),
        ]);

        await testTransaction.rollback();

        const {
          rows: [{ count: countAfterRollback }],
        } = await setupClient.query('SELECT count(*) FROM sample');
        expect(+countAfterRollback).toBe(0);
      } finally {
        emitWarning.mockRestore();
        await Promise.allSettled([setupClient.end(), client.end()]);
      }
    });
  });

  describe('patch database client', () => {
    beforeAll(testTransaction.start);
    beforeEach(testTransaction.start);
    afterEach(testTransaction.rollback);
    afterAll(testTransaction.close);

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

    it('should serialize concurrent queries on the transaction client', async () => {
      const emitWarning = failOnPgClientQueryWarning();

      try {
        await clients[0].connect();
        await Promise.all([
          clients[0].query(insertWithSleepSql, ['a']),
          clients[0].query(insertWithSleepSql, ['b']),
        ]);
      } finally {
        emitWarning.mockRestore();
      }

      expect(await getCounts()).toEqual([2, 0]);

      await testTransaction.rollback();
      expect(await getCounts()).toEqual([0, 0]);
      testTransaction.start();
    });

    it('should serialize concurrent callback queries on the transaction client', async () => {
      const emitWarning = failOnPgClientQueryWarning();

      const insert = (value: string) =>
        new Promise((resolve, reject) => {
          clients[0].query(insertWithSleepSql, [value], (err, result) => {
            if (err) {
              reject(err);
            } else {
              resolve(result);
            }
          });
        });

      try {
        await clients[0].connect();
        await Promise.all([insert('callback-a'), insert('callback-b')]);
      } finally {
        emitWarning.mockRestore();
      }

      expect(await getCounts()).toEqual([2, 0]);
    });

    describe('nested describe', () => {
      beforeAll(async () => {
        await testTransaction.start();
        await Promise.all(clients.map((client) => client.query(insertSql)));
      });

      afterAll(async () => {
        await testTransaction.rollback();
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

    describe('parallel transaction', () => {
      it('should run two transactions in parallel', async () => {
        const client = clients[0];

        const error = new Error('error');

        const promise1 = testTransaction.parallel(async () => {
          await client.query(`SELECT 1 value`);
          throw error;
        });

        const promise2 = testTransaction.parallel(async () => {
          const {
            rows: [{ value }],
          } = await client.query(`SELECT 1 value`);

          return value;
        });

        const results = await Promise.allSettled([promise1, promise2]);

        expect(results).toEqual([
          {
            status: 'rejected',
            reason: error,
          },
          {
            status: 'fulfilled',
            value: 1,
          },
        ]);
      });
    });
  });

  describe('unpatch database client', () => {
    describe('patch in start', () => {
      beforeAll(testTransaction.start);
      afterAll(testTransaction.rollback);

      it('should be patched', () => {
        clients.forEach((client, i) =>
          expect(client.connect).not.toBe(originalConnects[i]),
        );

        pools.forEach((pool, i) =>
          expect(pool.connect).not.toBe(originalPoolConnects[i]),
        );
      });
    });

    it('should be unpatched by rollback', () => {
      clients.forEach((client, i) =>
        expect(client.connect).toBe(originalConnects[i]),
      );

      pools.forEach((pool, i) =>
        expect(pool.connect).toBe(originalPoolConnects[i]),
      );
    });
  });
});
