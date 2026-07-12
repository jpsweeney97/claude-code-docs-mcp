# Extraction Provenance

Extracted from the `claude-code-tool-dev` monorepo (github.com/jpsweeney97/claude-code-tool-dev) on 2026-07-12.

- Source path: `packages/mcp-servers/claude-code-docs/` (previously `packages/mcp-servers/extension-docs/` until monorepo commit `73a0d852`).
- Monorepo `main` commit at extraction: `9d9cd9e6ccf7b320b09915db7188330c29061150`.
- Method: history-preserving `git filter-repo` over both historical paths, hoisted to repo root. Commits touching only out-of-package files were pruned; commit hashes differ from the monorepo's.
- First standalone adaptations (branch `chore/standalone-init`):
  - `tsconfig.json`: inlined compiler options from the monorepo's `tsconfig.base.json`; dropped `extends`.
  - `package-lock.json`: generated standalone (deps were previously hoisted into the monorepo root lockfile via npm workspaces).
  - `.github/workflows/ci.yml`: adapted from the monorepo's `claude-code-docs-production.yml` (dropped `--workspace` flags and path filters).
  - `CLAUDE.md`/`AGENTS.md`: registration example updated to the standalone path; dead `DOCS_PATH` env var removed (no source file reads it — the server fetches via `DOCS_URL`); working-directory notes updated.
  - `.gitignore`: added `.claude/` (local session state).
- No version bump: no runtime behavior changed (v1.1.0 was released the same day, immediately before extraction).
- Monorepo redirect stub: `packages/deprecated/claude-code-docs/MIGRATED.md` in `claude-code-tool-dev`.
