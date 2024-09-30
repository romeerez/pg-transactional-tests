import { AsyncLocalStorage } from 'node:async_hooks';
import {
  Client,
  Pool,
  PoolClient,
  PoolConfig,
  QueryArrayConfig,
  QueryConfig,
} from 'pg';

interface ConnectionParameters {
  user: string;
  database: string;
  port: number;
  host: string;
}

interface ClientWithNeededTypes extends Client {
  connectionParameters: ConnectionParameters;
}

const { connect, query } = Client.prototype;
const { connect: poolConnect, query: poolQuery } = Pool.prototype;

let asyncLocalStorage: AsyncLocalStorage<number> | undefined;
let parallelId = 0;

const getClientId = (client: Client) => {
  const { connectionParameters: p } = client as ClientWithNeededTypes;
  const parallelId = asyncLocalStorage?.getStore();
  return `${p.host} ${p.port} ${p.user} ${p.database}${
    parallelId ? ' parallel:' + parallelId : ''
  }`;
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

const getState = (self: Client) => {
  const thisId = getClientId(self);

  let state = clientStates[thisId];
  if (!state) {
    const parallelId = asyncLocalStorage?.getStore();

    let client;
    if (parallelId) {
      client = new Client();
      (
        client as unknown as { connectionParameters: unknown }
      ).connectionParameters = (
        self as unknown as { connectionParameters: unknown }
      ).connectionParameters;
    } else {
      client = self;
    }

    clientStates[thisId] = state = {
      client,
      transactionId: 0,
      prependStartTransaction,
    };
  }

  return state;
};

async function patchedConnect(
  this: Client,
  callback?: (err: Error) => void,
): Promise<void> {
  // @types/pg says there is no second parameter, but actually pg itself relies on it
  const cb = callback as (err: Error | undefined, connection?: Client) => void;

  const state = getState(this);

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
}

function patchedPoolConnect(
  this: Pool,
  cb?: (err: Error, client: PoolClient, done: (release?: any) => void) => void,
): Promise<PoolClient> {
  (this as unknown as { options: PoolConfig }).options.max = 1;
  if (cb) {
    // @ts-expect-error whatever
    poolConnect.call(this, cb);
    return undefined as unknown as Promise<PoolClient>;
  } else {
    return (poolConnect as () => Promise<PoolClient>).call(this);
  }
}

async function patchedQuery(
  this: Client,
  inputArg: string | QueryConfig | QueryArrayConfig,
  ...args: any[]
) {
  const state = getState(this);

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
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function patchedPoolQuery(this: Pool, ...args: any[]) {
  const client = await this.connect();
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (client as any).query(...args);
  } finally {
    client.release();
  }
}

let started = 0;

export const testTransaction = {
  patch() {
    Client.prototype.connect = patchedConnect;
    Pool.prototype.connect = patchedPoolConnect;
    Client.prototype.query = patchedQuery;
    Pool.prototype.query = patchedPoolQuery;
  },

  unpatch() {
    clientStates = {};
    Client.prototype.connect = connect;
    Client.prototype.query = query;
    Pool.prototype.connect = poolConnect;
    Pool.prototype.query = poolQuery;
  },

  start() {
    started++;

    if (Client.prototype.connect !== patchedConnect) {
      testTransaction.patch();
    }

    prependStartTransaction = true;
    for (const state of Object.values(clientStates)) {
      state.prependStartTransaction = true;
    }
  },

  async rollback() {
    await Promise.all(
      Object.entries(clientStates).map(async ([id, state]) => {
        if (state.transactionId > 0) {
          await state.client?.query('ROLLBACK');
        } else if (state.transactionId === 0 && / parallel:\d+$/.test(id)) {
          await state.client?.end();
        }
      }),
    );

    if (!--started) {
      testTransaction.unpatch();
    }
  },

  parallel<T>(fn: () => T): T {
    testTransaction.patch();

    asyncLocalStorage ??= new AsyncLocalStorage<number>();
    return asyncLocalStorage.run(parallelId++, fn);
  },

  async close() {
    started = 0;

    await Promise.all(
      Object.values(clientStates).map((state) => state.client.end()),
    );

    testTransaction.unpatch();
  },
};
