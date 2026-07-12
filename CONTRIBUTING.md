Install dependencies:

```sh
pnpm i
```

Copy `.env.example` to `.env`, change `DATABASE_URLS` and `DATABASE_URL` if needed:

```sh
cp .env.example .env
```

Create and migrate local databases:

```sh
pnpm db create # works only if DATABASE_URL has admin role
pnpm db up
```

Run tests:

```sh
pnpm t index # watch mode
pnpm check # no watch mode
```
