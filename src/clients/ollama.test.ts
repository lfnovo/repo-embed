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

describe("embedWithFallback", () => {
  it("returns embedding on first call with no retries (1 fetch call)", async () => {
    let callCount = 0;
    mockFetch(async () => {
      callCount++;
      return makeOkResponse([MOCK_VECTOR]);
    });
    const result = await embedWithFallback("hello world");
    expect(result).toEqual(MOCK_VECTOR);
    expect(callCount).toBe(1);
  });

  it("halves text once on context-length error then succeeds (2 fetch calls)", async () => {
    let callCount = 0;
    mockFetch(async () => {
      callCount++;
      if (callCount === 1)
        return makeErrorResponse("input length exceeds the context length");
      return makeOkResponse([MOCK_VECTOR]);
    });
    const text = "a".repeat(8000);
    const result = await embedWithFallback(text);
    expect(result).toEqual(MOCK_VECTOR);
    expect(callCount).toBe(2);
  });

  it("halves text multiple times until success (3 fetch calls)", async () => {
    let callCount = 0;
    mockFetch(async () => {
      callCount++;
      if (callCount < 3)
        return makeErrorResponse("input length exceeds the context length");
      return makeOkResponse([MOCK_VECTOR]);
    });
    const text = "a".repeat(8000);
    const result = await embedWithFallback(text);
    expect(result).toEqual(MOCK_VECTOR);
    expect(callCount).toBe(3);
  });

  it("propagates non-context error immediately without retrying (1 fetch call)", async () => {
    let callCount = 0;
    mockFetch(async () => {
      callCount++;
      return makeErrorResponse("internal error", 500);
    });
    const text = "a".repeat(8000);
    await expect(embedWithFallback(text)).rejects.toThrow("HTTP 500");
    expect(callCount).toBe(1);
  });

  it("throws 'could not embed at any length' after exhausting MIN_FALLBACK_CHARS", async () => {
    let callCount = 0;
    mockFetch(async () => {
      callCount++;
      return makeErrorResponse("input length exceeds the context length");
    });
    // Use a power of 2 so Math.floor halving is exact and the formula holds
    const initialLen = 1024;
    const text = "a".repeat(initialLen);
    await expect(embedWithFallback(text)).rejects.toThrow(
      "could not embed at any length",
    );
    // Each retry halves len; throws after floor(len/2) < 256
    const expectedCalls = Math.ceil(Math.log2(initialLen / 256)) + 1;
    expect(callCount).toBe(expectedCalls);
  });

  it("retries at MIN_FALLBACK_CHARS when halving would skip past it", async () => {
    let callCount = 0;
    mockFetch(async () => {
      callCount++;
      return makeErrorResponse("input length exceeds the context length");
    });
    // 500 chars: halving gives 250 (< 256), but the fallback should clamp to
    // 256 and try once more before giving up.
    const text = "a".repeat(500);
    await expect(embedWithFallback(text)).rejects.toThrow(
      "could not embed at any length",
    );
    expect(callCount).toBe(2);
  });
});
