import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { embedWithFallback } from "./ollama.ts";

const EMBED_DIM = 768;
const MOCK_VECTOR = new Array(EMBED_DIM).fill(0.1);

function makeOkResponse(vectors: number[][]): Response {
  return new Response(JSON.stringify({ embeddings: vectors }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function makeErrorResponse(body: string, status = 400): Response {
  return new Response(body, { status });
}

let originalFetch: typeof fetch;

beforeEach(() => {
  originalFetch = global.fetch;
});

afterEach(() => {
  global.fetch = originalFetch;
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mockFetch(fn: (...args: any[]) => Promise<Response>): void {
  global.fetch = fn as typeof fetch;
}

describe("embedWithFallback — success on first try", () => {
  it("returns the embedding vector directly", async () => {
    mockFetch(async () => makeOkResponse([MOCK_VECTOR]));
    const result = await embedWithFallback("hello world");
    expect(result).toEqual(MOCK_VECTOR);
  });
});

describe("embedWithFallback — context-length error triggers halving", () => {
  it("retries with half the text after context-length error and returns embedding", async () => {
    let callCount = 0;
    mockFetch(async () => {
      callCount++;
      if (callCount === 1)
        return makeErrorResponse("input length exceeds the context length");
      return makeOkResponse([MOCK_VECTOR]);
    });
    const text = "a".repeat(600);
    const result = await embedWithFallback(text);
    expect(result).toEqual(MOCK_VECTOR);
    expect(callCount).toBe(2);
  });

  it("throws minimum-length error when len drops below 256", async () => {
    mockFetch(async () =>
      makeErrorResponse("input length exceeds the context length"),
    );
    const text = "a".repeat(600);
    await expect(embedWithFallback(text)).rejects.toThrow(
      "could not embed at any length: text exceeds context even at minimum",
    );
  });
});

describe("embedWithFallback — non-context errors propagate immediately", () => {
  it("rethrows connection-refused error without retrying", async () => {
    let callCount = 0;
    mockFetch(async () => {
      callCount++;
      return makeErrorResponse("connection refused", 503);
    });
    const text = "a".repeat(600);
    await expect(embedWithFallback(text)).rejects.toThrow("HTTP 503");
    expect(callCount).toBe(1);
  });
});

describe("isContextLengthError — verified through embedWithFallback behavior", () => {
  it("treats 'input length exceeds the context length' as a context-length error (retries)", async () => {
    let callCount = 0;
    mockFetch(async () => {
      callCount++;
      if (callCount < 3)
        return makeErrorResponse("input length exceeds the context length");
      return makeOkResponse([MOCK_VECTOR]);
    });
    const text = "a".repeat(1200);
    await embedWithFallback(text);
    expect(callCount).toBeGreaterThan(1);
  });

  it("treats 'connection refused' as a non-context error (no retry)", async () => {
    let callCount = 0;
    mockFetch(async () => {
      callCount++;
      return makeErrorResponse("connection refused", 503);
    });
    await expect(embedWithFallback("a".repeat(600))).rejects.toThrow();
    expect(callCount).toBe(1);
  });
});
