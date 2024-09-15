import {
  Client,
  Pool,
  PoolClient,
  PoolConfig,
  QueryArrayConfig,
  QueryConfig,
} from 'pg';

const { connect, query } = Client.prototype;
const { connect: poolConnect, query: poolQuery } = Pool.prototype;

interface ConnectionParameters {
  user: string;
  database: string;
  port: number;
  host: string;
}

interface ClientWithNeededTypes extends Client {
  connectionParameters: ConnectionParameters;
}

const getClientId = (client: Client) => {
  const { connectionParameters: p } = client as ClientWithNeededTypes;
  return `${p.host} ${p.port} ${p.user} ${p.database}`;
};

let prependStartTransaction = false;

let clientStates: Record<
  string,
  {
    transactionId: number;
    client: Client;
    connectPromise?: Promise<void>;
    prependStartTransaction?: boolean;
  }
> = {};

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

    const thisId = getClientId(this);

    let state = clientStates[thisId];
    if (!state) {
      clientStates[thisId] = state = {
        client: this,
        transactionId: 0,
        prependStartTransaction,
      };
    }

    if (state.connectPromise) {
      await state.connectPromise;
      cb?.(undefined, state.client);
      return;
    }

    return (state.connectPromise = new Promise((resolve, reject) => {
      connect.call(state.client, (err) => {
        if (err) {
          cb?.(err);
          reject(err);
        } else {
          cb?.(undefined, state.client);
          resolve();
        }
      });
    }));
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
    const state = clientStates[getClientId(this)];

    let input = inputArg;
    const sql = (typeof input === 'string' ? input : input.text)
      .trim()
      .toUpperCase();

    // Don't wrap in transactions for selects as they won't mutate
    if (!sql.startsWith('SELECT')) {
      let replacingSql: string | undefined;

      if (state.prependStartTransaction) {
        state.prependStartTransaction = false;
        await this.query('BEGIN');
      }

      if (sql.startsWith('START TRANSACTION') || sql.startsWith('BEGIN')) {
        if (state.transactionId > 0) {
          replacingSql = `SAVEPOINT "${state.transactionId++}"`;
        } else {
          state.transactionId = 1;
        }
      } else {
        const isCommit = sql.startsWith('COMMIT');
        const isRollback = !isCommit && sql.startsWith('ROLLBACK');
        if (isCommit || isRollback) {
          if (state.transactionId === 0) {
            throw new Error(
              `Trying to ${
                isCommit ? 'COMMIT' : 'ROLLBACK'
              } outside of transaction`,
            );
          }

          if (state.transactionId > 1) {
            const savePoint = --state.transactionId;
            replacingSql = `${
              isCommit ? 'RELEASE' : 'ROLLBACK TO'
            } SAVEPOINT "${savePoint}"`;
          } else {
            state.transactionId = 0;
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
    return (query as any).call(state.client, input, ...args);
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
  clientStates = {};
  Client.prototype.connect = connect;
  Client.prototype.query = query;
  Pool.prototype.connect = poolConnect;
  Pool.prototype.query = poolQuery;
};

export const startTransaction = () => {
  prependStartTransaction = true;
  for (const state of Object.values(clientStates)) {
    state.prependStartTransaction = true;
  }
};

export const rollbackTransaction = () => {
  return Promise.all(
    Object.values(clientStates).map(async (state) => {
      if (state.transactionId > 0) {
        await state.client?.query('ROLLBACK');
      }
    }),
  );
};

export const close = () =>
  Promise.all(Object.values(clientStates).map((state) => state.client.end()));
