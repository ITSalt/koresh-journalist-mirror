<!-- pepper:shared:start -->

## Project rules

- Stack: TypeScript (Node 22), Fastify, zod, vitest; ESLint and Prettier.
- Commands: `npm run lint`, `npm test`, `npm run build`. All must pass before a PR.
- TDD: write the test first (tests in `test/`, mirroring `src/`).
- No secrets in files, logs or commits: env names only, values come from the deploy environment.
- Never merge a PR and never deploy; deploys run only from the GitHub Actions workflow after the owner merges.

<!-- pepper:shared:end -->
