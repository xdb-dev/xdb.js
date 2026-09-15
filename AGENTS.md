# xdb.js

xdb.js is the browser edition of [XDB](https://github.com/xdb-dev/xdb). Data is tuples underneath, with typed collections and live queries on top. See `README.md`.

## Commands

| Command | Purpose |
| --- | --- |
| `pnpm test` | Run the vitest suite |
| `pnpm typecheck` | Type-check the library and the demo |
| `pnpm build` | Write `dist/` |
| `pnpm dx` | Build `dx.html` from `demo/` |
| `pnpm check` | Run typecheck, test, and the headless demo check |

Before you commit, run `pnpm check`.

TypeScript 7 does not accept file arguments while `tsconfig.json` exists. To type-check single files, add `--ignoreConfig`. `CONTRACTS-DX.md` gives the full command.

## Code

- In every relative import, use the `.js` extension, also for a `.ts` file.
- Do not add a runtime dependency.
- Do not import `zod`. `src/collection/schema.ts` reads a Zod schema through `_zod.def`.
- Import `react` only in `src/react/`. Use `React.createElement`, not JSX.
- Put tests next to the code, as `<name>.test.ts`.
- Write TSDoc on every export.
- Keep the data model, URIs, schema modes, and version contract the same as the Go library.

`CONTRACTS.md` and `CONTRACTS-DX.md` define the interfaces between modules. Read them before you change a signature.

## Docs

- `docs/howto/` holds task guides. `docs/concepts/` holds one page per concept.
- Each page starts with YAML frontmatter: `title`, `description`, and `module`. How-to pages also get `read_when`.
- If you change an API or a behavior, update its concept page. Update `docs/concepts/README.md` when you add a page.
- Make sure that each code example matches the current API.
