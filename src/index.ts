import {
  Client,
  Pool,
  PoolClient,
  PoolConfig,
  QueryArrayConfig,
  QueryConfig,
} from 'pg';

let transactionId = 0;
let client: Client | undefined;
let connectPromise: Promise<void> | undefined;
let prependStartTransaction = false;

const { connect, query } = Client.prototype;
const { connect: poolConnect, query: poolQuery } = Pool.prototype;

export const patchPgForTransactions = () => {
  Client.prototype.connect = async function (
    this: Client,
    callback?: (err: Error) => void,
  ) {
    // @types/pg says there is no second parameter, but actually pg itself relies on it
    const cb = callback as (
      err: Error | undefined,
      connection?: Client,
    ) => void;
    if (!client) client = this;

    if (connectPromise) {
      await connectPromise;
      cb?.(undefined, client);
      return;
    }

    connectPromise = new Promise((resolve, reject) => {
      connect.call(client, (err) => {
        if (err) {
          cb?.(err);
          reject(err);
        } else {
          cb?.(undefined, client);
          resolve();
        }
      });
    });

    return connectPromise;
  };

  Pool.prototype.connect = function (
    cb?: (
      err: Error,
      client: PoolClient,
      done: (release?: any) => void,
    ) => void,
  ) {
    (this as unknown as { options: PoolConfig }).options.max = 1;
    if (cb) {
      // @ts-expect-error whatever
      poolConnect.call(this, cb);
      return undefined as unknown as Promise<PoolClient>;
    } else {
      return (poolConnect as () => Promise<PoolClient>).call(this);
    }
  };

  Client.prototype.query = async function (
    inputArg: string | QueryConfig | QueryArrayConfig,
    ...args: any[]
  ) {
    let input = inputArg;
    const sql = (typeof input === 'string' ? input : input.text)
      .trim()
      .toUpperCase();

    // Don't wrap in transactions for selects as they won't mutate
    if (!sql.startsWith('SELECT')) {
      let replacingSql: string | undefined;

      if (prependStartTransaction) {
        prependStartTransaction = false;
        await this.query('BEGIN');
      }

      if (sql.startsWith('START TRANSACTION') || sql.startsWith('BEGIN')) {
        if (transactionId > 0) {
          replacingSql = `SAVEPOINT "${transactionId++}"`;
        } else {
          transactionId = 1;
        }
      } else {
        const isCommit = sql.startsWith('COMMIT');
        const isRollback = !isCommit && sql.startsWith('ROLLBACK');
        if (isCommit || isRollback) {
          if (transactionId === 0) {
            throw new Error(
              `Trying to ${
                isCommit ? 'COMMIT' : 'ROLLBACK'
              } outside of transaction`,
            );
          }

          if (transactionId > 1) {
            const savePoint = --transactionId;
            replacingSql = `${
              isCommit ? 'RELEASE' : 'ROLLBACK TO'
            } SAVEPOINT "${savePoint}"`;
          } else {
            transactionId = 0;
          }
        }
      }

      if (replacingSql) {
        if (typeof input === 'string') {
          input = replacingSql;
        } else {
          input.text = replacingSql;
        }
      }
    }

    await (Client.prototype.connect as () => Promise<void>).call(this);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (query as any).call(client, input, ...args);
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  Pool.prototype.query = async function (...args: any[]) {
    const client = await this.connect();
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (client as any).query(...args);
    } finally {
      client.release();
    }
  };
};

export const unpatchPgForTransactions = () => {
  transactionId = 0;
  client = undefined;
  connectPromise = undefined;

  Client.prototype.connect = connect;
  Client.prototype.query = query;
  Pool.prototype.connect = poolConnect;
  Pool.prototype.query = poolQuery;
};

export const startTransaction = async () => {
  prependStartTransaction = true;
};

export const rollbackTransaction = async () => {
  if (transactionId > 0) {
    await client?.query('ROLLBACK');
  }
};
