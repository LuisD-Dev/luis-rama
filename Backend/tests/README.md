Backend tests for Teclia Academia

Prereqs
- Node >= 18
- PostgreSQL database for tests (Supabase branch or local Postgres)
- From the repository root run `npm install` inside `Backend/` to install dev dependencies.

Setup
- Set `TEST_DATABASE_URL` in `Backend/.env` (recommended) or reuse `DATABASE_URL`.
- Apply migrations before running tests: `npm run prisma:deploy`
- Do NOT run tests against production databases.

Scripts
- `npm run test` — run tests once
- `npm run test:watch` — run tests in watch mode
- `npm run test:coverage` — run with coverage
- `npm run test:payments:concurrency` — run deterministic payment interleavings (under the CI time budget)

Structure
- `tests/` contains `auth.test.js`, `content.test.js`, `stats.test.js`.
- `tests/helpers/db.setup.js` connects via Prisma and cleans data between tests.
- `tests/fixtures/` holds sample users and content used across tests.

Notes
- Some endpoints (e.g. `/api/auth/refresh`) are not implemented in the current backend; tests will reflect actual behavior.
- Tests are built to be isolated and remove created users/content between tests.

See also: [PRISMA_MIGRATION_GUIDE.md](../PRISMA_MIGRATION_GUIDE.md)

## How to add an invariant

Add the assertion to `tests/concurrency/harness.js` so it is checked after every
schedule, then add a focused test to `tests/concurrency/invariants.test.js`.
Keep the invariant about observable payment state, and include a test-only
mutation that would violate it when the invariant is safety-critical. A failing
run prints the seed and compact barrier schedule; replay it with the same seed
when extending the harness, for example with
`npm run test:payments:concurrency -- --seed=12345`.
