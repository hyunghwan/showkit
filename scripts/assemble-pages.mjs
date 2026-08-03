import { cp, mkdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);
const destination = path.resolve(
  process.argv[2] ?? path.join(repositoryRoot, "output", "pages")
);

if (
  destination === repositoryRoot ||
  repositoryRoot.startsWith(`${destination}${path.sep}`)
) {
  throw new Error("The Pages destination must not contain the repository.");
}

const temporary = `${destination}.tmp-${process.pid}`;
await rm(temporary, { recursive: true, force: true });
await mkdir(path.join(temporary, "assets"), { recursive: true });
await cp(path.join(repositoryRoot, "examples", "gallery"), temporary, {
  recursive: true
});
await cp(
  path.join(repositoryRoot, "assets", "showkit-logo.png"),
  path.join(temporary, "assets", "showkit-logo.png")
);
await rm(destination, { recursive: true, force: true });
await mkdir(path.dirname(destination), { recursive: true });
await rename(temporary, destination);

process.stdout.write(`Assembled GitHub Pages site at ${destination}\n`);
