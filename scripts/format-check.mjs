import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

function gitFiles(args) {
  try {
    return execFileSync("git", args, { encoding: "utf8" })
      .split(/\r?\n/)
      .filter(Boolean);
  } catch {
    return [];
  }
}

const sourceFile = /^src\/.*\.(?:ts|tsx|css)$/;
let files = [
  ...gitFiles(["diff", "--name-only", "--diff-filter=ACMR", "HEAD"]),
  ...gitFiles(["ls-files", "--others", "--exclude-standard"]),
].filter((file) => sourceFile.test(file));

if (files.length === 0) {
  files = gitFiles(["diff", "--name-only", "--diff-filter=ACMR", "HEAD^", "HEAD"])
    .filter((file) => sourceFile.test(file));
}

files = [...new Set(files)];
if (files.length === 0) {
  process.stdout.write("No changed TypeScript or CSS files to format-check.\n");
  process.exit(0);
}

const prettierCli = fileURLToPath(
  new URL("../node_modules/prettier/bin/prettier.cjs", import.meta.url),
);
const result = spawnSync(process.execPath, [prettierCli, "--check", ...files], {
  stdio: "inherit",
});
process.exit(result.status ?? 1);
