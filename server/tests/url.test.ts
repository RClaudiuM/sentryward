import { describe, expect, it } from "vitest";
import { parseChangeUrl } from "../src/review/forge/url.ts";
import { normalizeHost } from "../src/schemas/connections.schema.ts";

describe("parseChangeUrl", () => {
  it.each([
    [
      "https://github.com/acme/web/pull/42",
      { provider: "github", host: "github.com", project: "acme/web", number: 42 },
    ],
    [
      "https://github.com/acme/web/pull/42/files",
      { provider: "github", host: "github.com", project: "acme/web", number: 42 },
    ],
    [
      "https://gitlab.com/acme/platform/web/-/merge_requests/298",
      { provider: "gitlab", host: "gitlab.com", project: "acme/platform/web", number: 298 },
    ],
    [
      "https://gitlab.acme.com/team/app/-/merge_requests/7/diffs",
      { provider: "gitlab", host: "gitlab.acme.com", project: "team/app", number: 7 },
    ],
    [
      "https://github.com/acme/web/pull/2147483647",
      { provider: "github", host: "github.com", project: "acme/web", number: 2147483647 },
    ],
    [
      "http://gl.local:8080/team/app/-/merge_requests/7",
      { provider: "gitlab", host: "http://gl.local:8080", project: "team/app", number: 7 },
    ],
  ])("parses %s", (url, expected) => {
    expect(parseChangeUrl(url)).toEqual(expected);
  });

  it.each([
    "not a url",
    "https://github.com/acme/web",
    "https://github.com/acme/web/issues/42",
    "ftp://github.com/acme/web/pull/42",
    // Numbers no change can have: zero, past the integer column, past safe integers.
    "https://github.com/acme/web/pull/0",
    "https://github.com/acme/web/pull/2147483648",
    "https://gitlab.com/team/app/-/merge_requests/9999999999999999999999",
  ])("rejects %s", (url) => {
    expect(parseChangeUrl(url)).toBeNull();
  });
});

describe("normalizeHost", () => {
  it.each([
    ["gitlab.com", "gitlab.com"],
    ["https://gitlab.acme.com/", "gitlab.acme.com"],
    ["http://gl.local:8080", "http://gl.local:8080"],
  ])("normalizes %s", (input, expected) => {
    expect(normalizeHost(input)).toBe(expected);
  });

  it("rejects a host with a path", () => {
    expect(normalizeHost("gitlab.com/group")).toBeNull();
  });
});
