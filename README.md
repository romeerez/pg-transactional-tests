# PG Transactional tests

Patches [pg](https://npmjs.com/package/pg) to allow transactional tests.

The purpose of this lib is to make each of your test to run in a separate transaction, rollback after each test, so every change you're making in database disappears.

This allows to focus on testing logic without thinking about clearing database, and this is performed much faster than clearing tables.

`pg` is used by many ORMs, and this test approach worked fine with Sequelize, TypeORM, MikroORM, Objection and Knex.

I have a repo [ORMs overview](https://github.com/romeerez/orms-overview) where I was developing API with all ORMs mentioned above and everything was testing using this approach.

This **does not** work only with Prisma because its implementation is very different.

## Get started

Install:

```sh
pnpm i -D pg-transactional-tests
```

## Use for all tests

If you're using Jest, create a script for setup, add it to jest config ("jest" section in package.json):

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
import {
  patchPgForTransactions,
  startTransaction,
  rollbackTransaction,
} from 'pg-transactional-tests';

// import instance of your query builder, ORM, something which has `.close` or `.end` or `.destroy` method
import db from './path-to-your-db'

// patch client, this is changing prototype of Client and Pool of `pg`,
// so every instance of `pg` in your app becomes patched
patchPgForTransactions();

// start transaction before all tests:
beforeAll(startTransaction)

// start transaction before each test:
beforeEach(startTransaction);

// rollback transaction after each test:
afterEach(rollbackTransaction);

// rollback transaction after all and stop the db connection:
afterAll(async () => {
  // rollback transaction after all tests:
  await rollbackTransaction()
  // end database connection:
  await db.close()
});
```

## Use it only in some tests

You can define a test "hook" instead, and use it only in test suites which works with a database:

```ts
import {
  patchPgForTransactions,
  startTransaction,
  rollbackTransaction,
} from 'pg-transactional-tests';

// import instance of your query builder, ORM, something which has `.close` or `.end` or `.destroy` method
import db from './path-to-your-db'

export const useTestDatabase = () => {
  beforeAll(async () => {
    patchPgForTransactions()
    await startTransaction()
  })
  beforeEach(startTransaction)
  afterEach(rollbackTransaction)
  afterAll(async () => {
    await rollbackTransaction()
    unpatchPgForTransactions()
    await db.close()
  })
}
```

## How it works

Every test which performs a query is wrapped into a transaction:

```ts
test('create record', async () => {
  await db.query('INSERT INTO sample(...) VALUES (...)')
  const sample = await db.query('SELECT * FROM sample WHERE ...')
})
```

This test is producing such SQL:

```sql
BEGIN;
  INSERT INTO sample(...) VALUES (...);
  SELECT * FROM sample WHERE ...;
ROLLBACK;
```

Under the hood this lib is replacing some of SQL commands:

- `START TRANSACTION` and `BEGIN` command is replaced with `SAVEPOINT "id"`, where id is incremented number
- `COMMIN` becomes `RELEASE SAVEPOINT "id"`
- `ROLLBACK` becomes `ROLLBACK TO SAVEPOINT "id"`

This allows to handle even nested transactions:

```ts
test('nested transactions', async () => {
  await db.transaction(async (t) => {
    await t.query('INSERT INTO sample(...) VALUES (...)')
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

Note that `startTransaction` in `beforeEach` hook doesn't start it immediately, but it waits for a non-select query to prepend it with `BEGIN` statement.

As the result, if a test case doesn't perform inserts or updates, it won't make transactions in vain.

## Parallel queries

Since every test has own transaction, this library ensures that only 1 connection will be created, because single transaction requires single connection.

This may introduce an unexpected surprise, consider such code:

```ts
await db.transaction(async (transaction) => {
  await db.select('SELECT ...')
})
```

Here we started a transaction, but we forgot to use `transaction` variable and used `db` instead to perform a query.

In the first line we started a transaction, which consumes 1 connection, and it will be released only in the end of transaction.

In line 2 we perform a query with `db`, and db client here has to wait for a free connection to execute, but there is only 1 connection which is already taken.

As the result, such code will hang.

But it's not a bad thing, in contrary, when test code hangs this means there was such mistake, and the limitation only helps to find such mistakes.

## Why to choose it over truncating tables?

Transactions are faster than truncating, but we are talking about milliseconds which doesn't really count.

Main benefit is that it is simpler to use. With this library you can create persisted seed data, such as record of current user to use across the tests, while if you choose truncating, you'll also need to recreate seed data for each test.
