// Bundles the Git app into one ES module for the Docker image, plus the license texts of every
// package that ends up in the bundle. The runtime image then needs Node.js and these two files
// only: no package manager, no node_modules, and none of the SDK's optional peer dependencies.
//
//   node scripts/build-image.mjs [out-directory]   (default dist/image)
//
// Writes <out>/index.mjs and <out>/THIRD_PARTY_NOTICES. Run after `pnpm install`.
// Fails when a bundled package has no license file, so the image never ships code without its
// notice. The one exception is listed in DECLARED_LICENSES below: a package that declares its
// license only in package.json, whose canonical text is then written instead.

import { build } from "esbuild";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outDirectory = resolve(appRoot, process.argv[2] ?? "dist/image");
const licenseName = /^(?:licen[cs]e|copying|notice)(?:[._-].*)?$/i;

/**
 * Packages shipped without a license file whose package.json names the license: name → SPDX id
 * and the license's canonical text. Only exact matches count; any other package without a file
 * still fails the build.
 */
const DECLARED_LICENSES = new Map([
  [
    // postgres.js (the registry's database driver) is released into the public domain.
    "postgres",
    {
      spdx: "Unlicense",
      text: `This is free and unencumbered software released into the public domain.

Anyone is free to copy, modify, publish, use, compile, sell, or distribute this software, either
in source code form or as a compiled binary, for any purpose, commercial or non-commercial, and by
any means.

In jurisdictions that recognize copyright laws, the author or authors of this software dedicate
any and all copyright interest in the software to the public domain. We make this dedication for
the benefit of the public at large and to the detriment of our heirs and successors. We intend
this dedication to be an overt act of relinquishment in perpetuity of all present and future
rights to this software under copyright law.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT
NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN
CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

For more information, please refer to <https://unlicense.org/>`,
    },
  ],
]);

const result = await build({
  absWorkingDir: appRoot,
  entryPoints: ["src/index.ts"],
  outfile: join(outDirectory, "index.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  // CommonJS dependencies call require() for Node built-ins; an ES module has none of its own.
  banner: {
    js: "import { createRequire as __weldallCreateRequire } from 'node:module';\nconst require = __weldallCreateRequire(import.meta.url);",
  },
  legalComments: "none",
  metafile: true,
  logLevel: "warning",
});

/** The package directory (nearest package.json with a name) of a bundled file in node_modules. */
async function packageOf(file) {
  let directory = dirname(file);
  while (directory.includes("node_modules")) {
    try {
      const json = JSON.parse(await readFile(join(directory, "package.json"), "utf8"));
      if (typeof json.name === "string") return { directory, json };
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    directory = dirname(directory);
  }
  return undefined;
}

const packages = new Map();
for (const input of Object.keys(result.metafile.inputs)) {
  if (!input.includes("node_modules")) continue;
  const found = await packageOf(resolve(appRoot, input));
  if (!found) throw new Error(`No package.json for bundled file ${input}`);
  packages.set(`${found.json.name}@${found.json.version}`, found);
}

const sections = [];
for (const [id, { directory, json }] of [...packages].sort(([a], [b]) => a.localeCompare(b))) {
  const files = (await readdir(directory)).filter((name) => licenseName.test(name)).sort();
  const declared = DECLARED_LICENSES.get(json.name);
  let texts;
  if (files.length > 0)
    texts = await Promise.all(
      files.map(async (name) =>
        (await readFile(join(directory, name), "utf8")).replace(/\r\n?/g, "\n").trim(),
      ),
    );
  else if (declared && json.license === declared.spdx) texts = [declared.text];
  else throw new Error(`Bundled package ${id} has no license file`);
  sections.push(
    `${id}\nLicense: ${typeof json.license === "string" ? json.license : "see below"}\n\n${texts.join("\n\n")}`,
  );
}

await mkdir(outDirectory, { recursive: true });
await writeFile(
  join(outDirectory, "THIRD_PARTY_NOTICES"),
  `The Weldall Git app image bundles the following third-party packages.\n\n${sections.join(`\n\n${"-".repeat(72)}\n\n`)}\n`,
);
console.log(`Bundled ${packages.size} third-party packages into ${outDirectory}/index.mjs`);
