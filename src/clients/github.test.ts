import { describe, it, expect, mock, beforeEach } from "bun:test";

// Mutable reference so each test can control what the mock returns/throws
let mockImpl: (query: string, params?: unknown) => Promise<unknown> = async () => ({});

const mockGqlFn = Object.assign(
  (query: string, params?: unknown) => mockImpl(query, params),
  { defaults: (_opts: unknown) => mockGqlFn },
);

mock.module("@octokit/graphql", () => ({ graphql: mockGqlFn }));
mock.module("../config.ts", () => ({
  requireGithubToken: () => "fake-token",
  config: {
    GITHUB_TOKEN: "fake-token",
    SURREAL_URL: "http://localhost:8018/rpc",
    SURREAL_NS: "githubembed",
    SURREAL_DB: "main",
    SURREAL_USER: "root",
    SURREAL_PASS: "root",
    OLLAMA_URL: "http://localhost:11434",
    OLLAMA_EMBED_MODEL: "nomic-embed-text",
    EMBED_DIM: 768,
  },
}));

const { gh } = await import("./github.ts");

function makeHttpError(status: number, message: string): Error {
  const err = new Error(message);
  (err as unknown as { status: number }).status = status;
  return err;
}

beforeEach(() => {
  mockImpl = async () => ({});
});

describe("gh() 401/403 diagnostic wrapping", () => {
  it("returns response on success", async () => {
    mockImpl = async () => ({ repository: { name: "test" } });
    const result = await gh<{ repository: { name: string } }>("query { }");
    expect(result).toEqual({ repository: { name: "test" } });
  });

  it("wraps 401 error with diagnostic hint", async () => {
    mockImpl = async () => {
      throw makeHttpError(401, "Bad credentials");
    };
    await expect(gh("query { }")).rejects.toThrow(
      "token may be expired, missing required scope, or not authorized",
    );
  });

  it("wraps 403 error with diagnostic hint", async () => {
    mockImpl = async () => {
      throw makeHttpError(403, "Forbidden");
    };
    await expect(gh("query { }")).rejects.toThrow(
      "token may be expired, missing required scope, or not authorized",
    );
  });

  it("includes repo identifier when owner and name params present", async () => {
    mockImpl = async () => {
      throw makeHttpError(401, "Bad credentials");
    };
    await expect(
      gh("query { }", { owner: "myorg", name: "myrepo" }),
    ).rejects.toThrow("GitHub access denied for myorg/myrepo");
  });

  it("omits repo identifier when params are absent", async () => {
    mockImpl = async () => {
      throw makeHttpError(401, "Bad credentials");
    };
    let caught: Error | null = null;
    try {
      await gh("query { }");
    } catch (e) {
      caught = e as Error;
    }
    expect(caught).not.toBeNull();
    expect(caught!.message).toContain("GitHub access denied:");
    expect(caught!.message).not.toMatch(/for \S+\/\S+/);
  });

  it("chains original error as cause", async () => {
    const original = makeHttpError(401, "Bad credentials");
    mockImpl = async () => {
      throw original;
    };
    let caught: unknown = null;
    try {
      await gh("query { }");
    } catch (e) {
      caught = e;
    }
    expect(caught).not.toBeNull();
    expect((caught as { cause: unknown }).cause).toBe(original);
  });

  it("re-throws 500 errors unchanged", async () => {
    const err500 = makeHttpError(500, "Internal server error");
    mockImpl = async () => {
      throw err500;
    };
    await expect(gh("query { }")).rejects.toBe(err500);
  });

  it("re-throws errors without status unchanged", async () => {
    const plainErr = new Error("Something went wrong");
    mockImpl = async () => {
      throw plainErr;
    };
    await expect(gh("query { }")).rejects.toBe(plainErr);
  });

  it("re-throws GraphqlResponseError (no status field) unchanged", async () => {
    // GraphqlResponseError has no numeric status — only request/headers/response/errors/data
    const graphqlErr = Object.assign(new Error("Request failed due to response errors"), {
      name: "GraphqlResponseError",
      errors: [{ message: "Could not resolve to a Repository" }],
      data: { repository: null },
    });
    mockImpl = async () => {
      throw graphqlErr;
    };
    await expect(gh("query { }")).rejects.toBe(graphqlErr);
  });
});
