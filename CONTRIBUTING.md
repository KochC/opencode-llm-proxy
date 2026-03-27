# Contributing

Thanks for your interest in contributing to opencode-llm-proxy.

## Getting started

```bash
git clone https://github.com/KochC/opencode-llm-proxy.git
cd opencode-llm-proxy
npm install
```

Run the tests:

```bash
npm test
```

Run the linter:

```bash
npm run lint
```

## How to contribute

### Reporting bugs

Open a [bug report](https://github.com/KochC/opencode-llm-proxy/issues/new?template=bug_report.yml). Include:

- What you did
- What you expected
- What actually happened
- Your Node.js / Bun version and OS

### Suggesting features

Open a [feature request](https://github.com/KochC/opencode-llm-proxy/issues/new?template=feature_request.yml) describing the use case.

### Submitting a pull request

1. Fork the repo and create a branch from `dev` (not `main`)
2. Make your changes
3. Add or update tests in `index.test.js` — all 112+ tests must pass
4. Lint passes: `npm run lint`
5. Commit using [Conventional Commits](https://www.conventionalcommits.org/):
   - `fix:` for bug fixes (triggers a patch release)
   - `feat:` for new features (triggers a minor release)
   - `docs:` / `chore:` / `test:` for everything else (no release)
6. Open a PR against the `dev` branch

## Branch model

```
dev  ──►  main  ──►  npm (via Release Please)
```

- All work goes on `dev`
- `main` is release-only — only Release Please PRs merge directly there
- Do not open PRs against `main`

## Tests

Tests use the Node.js built-in test runner — no external framework needed.

```bash
node --test                          # run once
node --test --watch                  # watch mode
node --test --experimental-test-coverage  # with coverage
```

Tests mock the OpenCode SDK client entirely — no real LLM calls are made.

## Code style

ESLint enforces style. Run `npm run lint` before pushing. The config is in `eslint.config.js`.

Key conventions in the codebase:

- Pure functions are exported for testability (`normalizeMessages`, `buildPrompt`, etc.)
- Each API format (OpenAI, Anthropic, Gemini) has its own section in `index.js`
- Error responses mirror the format of the target API (OpenAI errors for `/v1/*`, Anthropic errors for `/v1/messages`, etc.)
