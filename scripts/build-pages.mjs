import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const root = process.cwd();
const outDir = join(root, "out");

const result = spawnSync("npx", ["next", "build"], {
  cwd: root,
  stdio: "inherit",
  shell: true,
  env: {
    ...process.env,
    GITHUB_PAGES: "true",
  },
});

if (result.status !== 0) {
  process.exit(result.status ?? 1);
}

if (!existsSync(outDir)) {
  mkdirSync(outDir, { recursive: true });
}

// Prevent GitHub Pages Jekyll from ignoring `_next`.
writeFileSync(join(outDir, ".nojekyll"), "");
