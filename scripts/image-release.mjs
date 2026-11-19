// Helpers for .github/workflows/release-image.yml. Node built-ins only: the release jobs run
// without `pnpm install`.
//
//   node scripts/image-release.mjs validate --tag v1.2.3
//   node scripts/image-release.mjs plan-tags --repository seibertgroup/weldall-git-app --version 1.2.3
//   node scripts/image-release.mjs check-image --image local:tag --platform linux/amd64 --version 1.2.3 --revision <sha>
//
// Every subcommand appends its results to $GITHUB_OUTPUT when that variable is set.

import { execFileSync } from "node:child_process";
import { appendFile, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

/** What the published image promises; `check-image` verifies it on the built image. */
export const imageUnit = {
  image: "weldall-git-app",
  title: "Weldall Git app",
  description:
    "Weldall Git app: keeps people's app repositories on one GitHub or Forgejo organisation, registered in Weldall as a resource. Requires PostgreSQL.",
  source: "https://github.com/seibert-external/weldall-git-app",
  entrypoint: ["node", "/app/index.mjs"],
};

const tagPattern = /^v(\d+)\.(\d+)\.(\d+)$/;
const versionPattern = /^(\d+)\.(\d+)\.(\d+)$/;

/** A release tag is exactly `vX.Y.Z`; returns `X.Y.Z`. */
export function parseReleaseTag(tag) {
  const match = tagPattern.exec(tag);
  if (!match) throw new Error(`Expected an exact vX.Y.Z release tag; got ${JSON.stringify(tag)}`);
  return `${match[1]}.${match[2]}.${match[3]}`;
}

export function compareVersions(left, right) {
  const parse = (value) => {
    const match = versionPattern.exec(value);
    if (!match) throw new Error(`Expected an X.Y.Z version; got ${JSON.stringify(value)}`);
    return match.slice(1).map(Number);
  };
  const a = parse(left);
  const b = parse(right);
  for (let index = 0; index < 3; index += 1) if (a[index] !== b[index]) return a[index] - b[index];
  return 0;
}

// The floating tags a release may carry besides its exact X.Y.Z tag: X.Y for the minor
// line, X for the major line, and latest.
export function floatingImageTags(version) {
  const [major, minor] = version.split(".");
  return [`${major}.${minor}`, major, "latest"];
}

// The exact version tag is always written. The floating tags only move forward: each one
// follows the highest version of its line (X.Y, X, or all), so re-releasing an older line
// never rolls a deployment back.
export function planImageTags(version, publishedVersions) {
  if (!versionPattern.test(version))
    throw new Error(`Expected an X.Y.Z version; got ${JSON.stringify(version)}`);
  const published = publishedVersions.filter((value) => versionPattern.test(value));
  const [major, minor] = version.split(".");
  const isHighest = (candidates) =>
    candidates.every((candidate) => compareVersions(version, candidate) >= 0);
  const [minorTag, majorTag, latestTag] = floatingImageTags(version);
  const tags = [version];
  if (isHighest(published.filter((value) => value.startsWith(`${major}.${minor}.`))))
    tags.push(minorTag);
  if (isHighest(published.filter((value) => value.startsWith(`${major}.`)))) tags.push(majorTag);
  if (isHighest(published)) tags.push(latestTag);
  return tags;
}

// Docker Hub's public tag listing; a repository that does not exist yet answers 404. A
// private repository answers 404 as well, so this lookup assumes the image repository stays
// public: for a private one it would report "nothing published" and let the floating tags
// move backwards.
export async function fetchPublishedVersions(repository, fetchImpl = fetch) {
  const versions = [];
  let url = `https://hub.docker.com/v2/repositories/${repository}/tags?page_size=100`;
  while (url) {
    // Docker Hub's edge rejects Node's default user agent with 403.
    const response = await fetchImpl(url, {
      headers: { accept: "application/json", "user-agent": "weldall-git-app-release-image" },
    });
    if (response.status === 404) return versions;
    if (!response.ok)
      throw new Error(
        `Docker Hub tag listing for ${repository} failed with HTTP ${response.status}`,
      );
    const body = await response.json();
    for (const result of body.results ?? []) {
      if (versionPattern.test(result.name)) versions.push(result.name);
    }
    url = body.next ?? null;
  }
  return versions;
}

/** The OCI labels, platform and entrypoint the release promises. */
export function checkImageProblems(inspected, { platform, version, revision, license }) {
  const problems = [];
  if (inspected.platform !== platform)
    problems.push(`platform: expected ${platform}, got ${inspected.platform}`);
  if (JSON.stringify(inspected.entrypoint) !== JSON.stringify(imageUnit.entrypoint))
    problems.push(
      `entrypoint: expected ${JSON.stringify(imageUnit.entrypoint)}, got ${JSON.stringify(inspected.entrypoint)}`,
    );
  const expectedLabels = {
    "org.opencontainers.image.version": version,
    "org.opencontainers.image.revision": revision,
    "org.opencontainers.image.licenses": license,
    "org.opencontainers.image.source": imageUnit.source,
    "org.opencontainers.image.title": imageUnit.title,
  };
  for (const [name, value] of Object.entries(expectedLabels)) {
    if (inspected.labels[name] !== value)
      problems.push(
        `${name}: expected ${JSON.stringify(value)}, got ${JSON.stringify(inspected.labels[name])}`,
      );
  }
  if (!inspected.labels["org.opencontainers.image.created"])
    problems.push("org.opencontainers.image.created: missing");
  return problems;
}

function argument(name) {
  const index = process.argv.indexOf(`--${name}`);
  const value = index === -1 ? undefined : process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`Missing --${name} <value>`);
  return value;
}

async function writeOutputs(outputs) {
  const lines = Object.entries(outputs).map(([key, value]) => `${key}=${value}`);
  console.log(lines.join("\n"));
  if (process.env.GITHUB_OUTPUT)
    await appendFile(process.env.GITHUB_OUTPUT, `${lines.join("\n")}\n`);
}

async function packageJson() {
  return JSON.parse(await readFile(join(repoRoot, "package.json"), "utf8"));
}

// The tag must name the version package.json declares, so the image's version label and its
// tags never disagree with the code.
async function validate() {
  const tag = argument("tag");
  const version = parseReleaseTag(tag);
  const manifest = await packageJson();
  if (manifest.version !== version)
    throw new Error(
      `Release tag ${tag} differs from the package.json version ${JSON.stringify(manifest.version)}`,
    );
  if (typeof manifest.license !== "string" || manifest.license.length === 0)
    throw new Error("package.json declares no license");
  await writeOutputs({
    version,
    image: imageUnit.image,
    title: imageUnit.title,
    description: imageUnit.description,
    source: imageUnit.source,
    license: manifest.license,
  });
}

async function planTags() {
  const repository = argument("repository");
  const version = argument("version");
  const tags = planImageTags(version, await fetchPublishedVersions(repository));
  const skipped = floatingImageTags(version).filter((tag) => !tags.includes(tag));
  if (skipped.length > 0)
    console.log(
      `Not moving ${skipped.join(", ")}: ${repository} already publishes a higher version than ${version}`,
    );
  await writeOutputs({ tags: tags.join(",") });
}

async function checkImage() {
  const image = argument("image");
  const [inspected] = JSON.parse(
    execFileSync("docker", ["image", "inspect", image], { encoding: "utf8" }),
  );
  const problems = checkImageProblems(
    {
      platform: `${inspected.Os}/${inspected.Architecture}`,
      entrypoint: inspected.Config?.Entrypoint ?? [],
      labels: inspected.Config?.Labels ?? {},
    },
    {
      platform: argument("platform"),
      version: argument("version"),
      revision: argument("revision"),
      license: (await packageJson()).license,
    },
  );
  if (problems.length > 0) throw new Error(`Image ${image} is wrong:\n${problems.join("\n")}`);
  console.log(`Platform, entrypoint and OCI labels on ${image} verified`);
}

const commands = { validate, "plan-tags": planTags, "check-image": checkImage };
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const command = commands[process.argv[2]];
  if (!command)
    throw new Error(
      `Usage: node scripts/image-release.mjs <${Object.keys(commands).join("|")}> ...`,
    );
  await command();
}
