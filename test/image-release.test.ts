import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  checkImageProblems,
  compareVersions,
  fetchPublishedVersions,
  imageUnit,
  parseReleaseTag,
  planImageTags,
} from "../scripts/image-release.mjs";

const repoRoot = new URL("../", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, repoRoot), "utf8");

describe("release tag", () => {
  it("is exactly vX.Y.Z", () => {
    expect(parseReleaseTag("v0.1.0")).toBe("0.1.0");
    expect(parseReleaseTag("v12.3.45")).toBe("12.3.45");
  });

  it.each([
    "0.1.0",
    "v0.1",
    "v0.1.0-rc.1",
    "v01.0.0x",
    "release-0.1.0",
    "@weldall/git-app@0.1.0",
    "",
  ])("rejects %j", (tag) => {
    expect(() => parseReleaseTag(tag)).toThrow(/Expected an exact vX\.Y\.Z/);
  });
});

describe("floating tag plan", () => {
  it("writes every tag for the first or highest release", () => {
    expect(planImageTags("0.1.0", [])).toEqual(["0.1.0", "0.1", "0", "latest"]);
    expect(planImageTags("1.0.0", ["0.9.9", "0.9.10"])).toEqual(["1.0.0", "1.0", "1", "latest"]);
    expect(planImageTags("1.2.3", ["1.2.3"])).toEqual(["1.2.3", "1.2", "1", "latest"]);
  });

  it("keeps latest and the major tag on the newer line when an older line gets a release", () => {
    expect(planImageTags("0.1.1", ["0.1.0", "0.2.0"])).toEqual(["0.1.1", "0.1"]);
    expect(planImageTags("1.4.1", ["1.4.0", "2.0.0"])).toEqual(["1.4.1", "1.4", "1"]);
  });

  it("never moves X.Y, X or latest backwards", () => {
    expect(planImageTags("0.1.0", ["0.1.1"])).toEqual(["0.1.0"]);
    expect(planImageTags("1.9.9", ["1.10.0"])).toEqual(["1.9.9", "1.9"]);
  });

  it("ignores non-release tags such as commit SHAs, X and latest", () => {
    expect(planImageTags("0.2.0", ["latest", "0.1", "0", "abc123", "0.1.0"])).toEqual([
      "0.2.0",
      "0.2",
      "0",
      "latest",
    ]);
  });

  it("compares versions numerically", () => {
    expect(compareVersions("1.10.0", "1.9.0")).toBeGreaterThan(0);
    expect(compareVersions("1.0.0", "1.0.0")).toBe(0);
    expect(() => compareVersions("1.0", "1.0.0")).toThrow(/X\.Y\.Z/);
  });
});

describe("image check", () => {
  const license = JSON.parse(read("package.json")).license;
  const expected = { platform: "linux/amd64", version: "1.2.3", revision: "abc123", license };
  const good = {
    platform: "linux/amd64",
    entrypoint: ["node", "/app/index.mjs"],
    labels: {
      "org.opencontainers.image.version": "1.2.3",
      "org.opencontainers.image.revision": "abc123",
      "org.opencontainers.image.licenses": license,
      "org.opencontainers.image.source": "https://github.com/seibert-external/weldall-git-app",
      "org.opencontainers.image.title": "Weldall Git app",
      "org.opencontainers.image.created": "2026-01-01T00:00:00Z",
    },
  };

  it("expects the Dockerfile's entrypoint", () => {
    const line = read("Dockerfile")
      .split("\n")
      .find((text) => text.startsWith("ENTRYPOINT "));
    expect(JSON.parse(line!.slice("ENTRYPOINT ".length))).toEqual(imageUnit.entrypoint);
  });

  it("accepts an image with the promised platform, entrypoint and labels", () => {
    expect(checkImageProblems(good, expected)).toEqual([]);
  });

  it("reports every deviation instead of stopping at the first", () => {
    const { "org.opencontainers.image.created": _created, ...labels } = good.labels;
    expect(
      checkImageProblems(
        {
          platform: "linux/arm64",
          entrypoint: ["node", "server.js"],
          labels: { ...labels, "org.opencontainers.image.version": "9.9.9" },
        },
        expected,
      ),
    ).toEqual([
      "platform: expected linux/amd64, got linux/arm64",
      'entrypoint: expected ["node","/app/index.mjs"], got ["node","server.js"]',
      'org.opencontainers.image.version: expected "1.2.3", got "9.9.9"',
      "org.opencontainers.image.created: missing",
    ]);
  });
});

describe("published version lookup", () => {
  const response = (status: number, body?: unknown) => ({
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
  });
  const base = "https://hub.docker.com/v2/repositories/example/git-app/tags";

  it("follows pagination and keeps only X.Y.Z tags", async () => {
    const pages: Record<string, unknown> = {
      [`${base}?page_size=100`]: {
        next: `${base}?page=2`,
        results: [{ name: "latest" }, { name: "0.1.0" }, { name: "0.1" }],
      },
      [`${base}?page=2`]: { next: null, results: [{ name: "0.2.0" }, { name: "deadbeef" }] },
    };
    const calls: string[] = [];
    const fetchImpl = async (url: string) => {
      calls.push(url);
      return response(200, pages[url]);
    };
    await expect(
      fetchPublishedVersions("example/git-app", fetchImpl as unknown as typeof fetch),
    ).resolves.toEqual(["0.1.0", "0.2.0"]);
    expect(calls).toEqual(Object.keys(pages));
  });

  it("treats a repository that does not exist yet as unpublished", async () => {
    const fetchImpl = async () => response(404);
    await expect(
      fetchPublishedVersions("example/new", fetchImpl as unknown as typeof fetch),
    ).resolves.toEqual([]);
  });

  it("fails loudly on any other error instead of guessing", async () => {
    const fetchImpl = async () => response(503);
    await expect(
      fetchPublishedVersions("example/git-app", fetchImpl as unknown as typeof fetch),
    ).rejects.toThrow(/HTTP 503/);
  });
});
