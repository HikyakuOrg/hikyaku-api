

Refer to `infra` folder for setting up spatial services using Docker. See `.env.example` for environment variables. 

Currently required stack:
- Supabase
- Valhalla
- VROOM
- Stripe
- SMTP service

## Project setup

```bash
$ pnpm install
```

## Compile and run the project

```bash
# development
$ pnpm run start

# watch mode
$ pnpm run start:dev

# production mode
$ pnpm run start:prod
```

## Run tests

```bash
# unit tests
$ pnpm run test

# e2e tests
$ pnpm run test:e2e

# test coverage
$ pnpm run test:cov
```
