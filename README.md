# PG Transactional tests

Patches [pg](https://npmjs.com/package/pg) to enable transactional tests.

The purpose of this lib is to make each of your test to run in a separate transaction, rollback after each test, so every change you're making in database disappears.

This allows to focus on testing logic without thinking about clearing database, and this is performed much faster than clearing tables.

`pg` is used by many ORMs, and this test approach worked fine with Sequelize, TypeORM, MikroORM, Objection and Knex.

I have a repo [ORMs overview](https://github.com/romeerez/orms-overview) where I was developing API with all ORMs mentioned above and everything was testing using this approach.

This **does not** work only with Prisma because its implementation is very different.

If a test doesn't perform any query, it won't start a transaction in vain.

Supports testing multiple databases in parallel. Transaction state is tracked by connection parameters.
If there are different connection parameters, it will run different transactions.

## Get started

Install:

```sh
pnpm i -D pg-transactional-tests
```

## Use for all tests

If you're using Jest, create a script for setup, add it to jest config file, or to "jest" section in package.json:

(if you're using any other test framework than Jest, it should be possible to configure it in similar way)

```js
{
  // ...
  "jest": {
    // ...
    "setupFilesAfterEnv": [
      "./jest-setup.ts"
    ]
  }
}
```

Write setup code in the script:

```ts
import { testTransaction } from 'pg-transactional-tests';

// start transaction before all tests (only when there are queries):
beforeAll(testTransaction.start)

// start transaction before each test (only when there are queries):
beforeEach(testTransaction.start);

// rollback transaction after each test (if transaction started):
afterEach(testTransaction.rollback);

// closes all connections in the end, pending transactions (if any) are discarded 
afterAll(testTransaction.close);
```

## Use it only in some tests

You can define a test "hook" instead, and use it only in test suites which works with a database:

```ts
import { testTransaction } from 'pg-transactional-tests'

export const useTestDatabase = () => {
  beforeAll(testTransaction.start)
  beforeEach(testTransaction.start)
  afterEach(testTransaction.rollback)
  afterAll(testTransaction.close)
}
```

Example:

```ts
import { useTestDatabase } from './my/test/utils'

describe('my test', () => {
  describe('testing db', () => {
    useTestDatabase()
    
    it('should save record', async () => {
      await someORM.sampleThing.create({ key: 'value' })
      
      const count = await someORM.sampleThing.count()
      // count will always be 1, because the record is rolled back
      expect(count).toBe(1)
    })
  })
  
  it('not using test transactions', async () => {
    // `useTestDatabase` is in the nested `describe`, it's not applied here.
    // The following line creates a record without transaction.
    await someORM.otherThing.create({ key: 'value' })
    
    // count increments on every test run.
    const count = await someORM.otherThing.count()
  })
})
```

## How it works

Every test that performs a query is wrapped into a transaction:

```ts
test('create record', async () => {
  await db.query('INSERT INTO sample(...) VALUES (...)')
  const sample = await db.query('SELECT * FROM sample WHERE ...')
})
```

Producing such SQL:

```sql
BEGIN;
  INSERT INTO sample(...) VALUES (...);
  SELECT * FROM sample WHERE ...;
ROLLBACK;
```

Under the hood this lib is replacing some of SQL commands:

- `START TRANSACTION` and `BEGIN` command is replaced with `SAVEPOINT "id"`, where id is an incremented number
- `COMMIT` becomes `RELEASE SAVEPOINT "id"`
- `ROLLBACK` becomes `ROLLBACK TO SAVEPOINT "id"`

So this library handles even nested transactions:

```ts
test('nested transactions', async () => {
  await db.transaction(async (t) => {
    await t.query('INSERT INTO two(...) VALUES (...)')
  })
})
```

Becomes:

```sql
BEGIN;
  SAVEPOINT "1";
  INSERT INTO sample(...) VALUES (...);
  RELEASE SAVEPOINT "1";
ROLLBACK;
```

Note that the `testTransaction.start` in `beforeEach` hook doesn't start it immediately, but it waits for a non-select query to prepend it with `BEGIN` statement.

As the result, if a test case doesn't perform inserts or updates, it won't make transactions in vain.

## Parallel transactions

In case you ever want to run two or more test transactions in parallel:

```ts
import { testTransaction } from 'pg-transactional-tests'

function runSomeQueries() { /* run some queries */ }

it('run transactions in parallel', async () => {
  const promise1 = await testTransaction.parallel(runSomeQueries)
  const promise2 = await testTransaction.parallel(() => runSomeQueries())
  const promise3 = await testTransaction.parallel(async () => {
    return await runSomeQueries()
  })
  
  const results = await Promise.allSettled([promise1, promise2, promise3])
})
```

The first `testTransaction.parallel` opens a new or utilizes an existing db connection.
Following calls to `testTransaction.parallel` are going to open a new connection to start an independent transactions.

All the queries inside the second `testTransaction.parallel` are going to be executed in the second transaction,
not interfering with the queries in the 1st or 3rd transaction.

`testTransaction.parallel` re-returns what your function returns.

## Parallel queries

Except for parallel transactions described above, this library ensures a single connection per a single database,
because a transaction has to operate on a single connection.

This may introduce an unexpected surprise, consider such code:

```ts
await db.transaction(async (transaction /* not used */) => {
  await db.select('SELECT ...')
})
```

Here we started a transaction, but we forgot to use the `transaction` variable, we're performing a query using the `db` variable instead.

In the first line we started a transaction, which consumes 1 connection, and it will be released only in the end of a transaction.

In line 2 we perform a query with `db`, and db client here has to wait for a free connection to execute, but there is only 1 connection which is already taken.

As a result, such a code will hang.

But it's not as bad as it may seem, in contrary, when the test hangs this means there was such a mistake.
This limitation helps to identify mistakes of this kind.

## Why to choose it over truncating tables?

Transactions are faster than truncating, but we are talking about milliseconds which doesn't really count.

Main benefit is that it is simpler to use. With this library you can create persisted seed data, such as record of current user to use across the tests, while if you choose truncating, you'll also need to recreate seed data for each test.
