import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // .claude/worktrees/ holds full checkouts of other commits. Without this
    // exclude, `vitest run` also collects their copies of the test suite and
    // reports failures from code that is not this checkout.
    exclude: [...configDefaults.exclude, '**/.claude/**'],
  },
});
