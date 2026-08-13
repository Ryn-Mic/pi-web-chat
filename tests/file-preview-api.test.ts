import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { getAuthStatus, setAuthStatus, setSessionToken } from "../src/lib/auth.ts";

beforeEach(() => {
  setSessionToken("test-token");
  setAuthStatus("authenticated");
});

afterEach(() => {
  setSessionToken(null);
  setAuthStatus("unauthenticated");
});

function collectHeaders(init?: RequestInit): Headers {
  if (!init?.headers) return new Headers();
  if (init.headers instanceof Headers) return init.headers;
  return new Headers(init.headers as Record<string, string>);
}

test("HEAD then GET returns File with name, type and content", async () => {
  const requests: Array<{
    method: string;
    url: string;
    authorization: string | null;
    ifMatch: string | null;
    signal: AbortSignal | null;
  }> = [];

  const fetchImpl: typeof fetch = async (input, init) => {
    const url = input.toString();
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = collectHeaders(init);
    requests.push({
      method,
      url,
      authorization: headers.get("authorization"),
      ifMatch: headers.get("if-match"),
      signal: init?.signal ?? null,
    });

    if (method === "HEAD") {
      return new Response(null, {
        status: 200,
        headers: {
          etag: 'W/"v1"',
          "content-type": "text/markdown",
          "content-length": "5",
        },
      });
    }

    return new Response(new Blob(["hello"], { type: "text/markdown" }), {
      status: 200,
    });
  };

  const { loadDesktopPreviewFile } = await import(
    "../src/lib/file-preview-api.ts"
  );

  const file = await loadDesktopPreviewFile({
    cwd: "/p",
    path: "docs/a.md",
    fetchImpl,
  });

  assert.equal(file.name, "a.md");
  assert.equal(file.type, "text/markdown");
  assert.equal(await file.text(), "hello");
  assert.deepEqual(
    requests.map((r) => [r.method, r.ifMatch]),
    [["HEAD", null], ["GET", 'W/"v1"']],
  );
  assert.ok(requests.every((r) => r.authorization === "Bearer test-token"));
  assert.equal(requests[0]?.url, requests[1]?.url);
});

test("409 on GET retries HEAD→GET once; second 409 yields changed error", async () => {
  const requests: Array<{ method: string; ifMatch: string | null }> = [];
  let headCount = 0;

  const fetchImpl: typeof fetch = async (input, init) => {
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = collectHeaders(init);
    requests.push({ method, ifMatch: headers.get("if-match") });

    if (method === "HEAD") {
      headCount += 1;
      return new Response(null, {
        status: 200,
        headers: { etag: `W/"v${headCount}"` },
      });
    }

    return new Response(null, { status: 409 });
  };

  const { loadDesktopPreviewFile, FilePreviewError } = await import(
    "../src/lib/file-preview-api.ts"
  );

  await assert.rejects(
    () => loadDesktopPreviewFile({ cwd: "/p", path: "docs/a.md", fetchImpl }),
    (err) =>
      err instanceof FilePreviewError &&
      err.code === "changed" &&
      /changed/i.test(err.message),
  );

  assert.deepEqual(
    requests.map((r) => [r.method, r.ifMatch]),
    [
      ["HEAD", null],
      ["GET", 'W/"v1"'],
      ["HEAD", null],
      ["GET", 'W/"v2"'],
    ],
  );
});

test("HEAD 413 stops without issuing GET", async () => {
  let getIssued = false;

  const fetchImpl: typeof fetch = async (input, init) => {
    const method = (init?.method ?? "GET").toUpperCase();
    if (method === "GET") getIssued = true;
    return new Response(null, { status: 413 });
  };

  const { loadDesktopPreviewFile, FilePreviewError } = await import(
    "../src/lib/file-preview-api.ts"
  );

  await assert.rejects(
    () => loadDesktopPreviewFile({ cwd: "/p", path: "big.bin", fetchImpl }),
    (err) => err instanceof FilePreviewError && err.code === "too-large",
  );
  assert.equal(getIssued, false);
});

test("HEAD without ETag fails without issuing GET", async () => {
  let getIssued = false;

  const fetchImpl: typeof fetch = async (input, init) => {
    if ((init?.method ?? "GET").toUpperCase() === "GET") getIssued = true;
    return new Response(null, { status: 200 });
  };

  const { loadDesktopPreviewFile, FilePreviewError } = await import(
    "../src/lib/file-preview-api.ts"
  );

  await assert.rejects(
    () => loadDesktopPreviewFile({ cwd: "/p", path: "docs/a.md", fetchImpl }),
    (err) => err instanceof FilePreviewError && err.code === "failed",
  );
  assert.equal(getIssued, false);
});

test("a stale GET retries the complete exchange and can then succeed", async () => {
  const requests: string[] = [];
  let getCount = 0;

  const fetchImpl: typeof fetch = async (input, init) => {
    const method = (init?.method ?? "GET").toUpperCase();
    requests.push(method);
    if (method === "HEAD") {
      return new Response(null, {
        status: 200,
        headers: { etag: `W/\"v${requests.length}\"`, "content-type": "text/plain" },
      });
    }
    getCount += 1;
    if (getCount === 1) return new Response(null, { status: 409 });
    return new Response(new Blob(["fresh"], { type: "text/plain" }), { status: 200 });
  };

  const { loadDesktopPreviewFile } = await import(
    "../src/lib/file-preview-api.ts"
  );

  const file = await loadDesktopPreviewFile({
    cwd: "/p",
    path: "docs/a.txt",
    fetchImpl,
  });

  assert.equal(await file.text(), "fresh");
  assert.deepEqual(requests, ["HEAD", "GET", "HEAD", "GET"]);
});

test("AbortError is not mapped and prevents further requests", async () => {
  let requestCount = 0;
  const controller = new AbortController();

  const fetchImpl: typeof fetch = async (input, init) => {
    requestCount += 1;
    controller.abort();
    throw new DOMException("The operation was aborted", "AbortError");
  };

  const { loadDesktopPreviewFile, isAbortError } = await import(
    "../src/lib/file-preview-api.ts"
  );

  await assert.rejects(
    () =>
      loadDesktopPreviewFile({
        cwd: "/p",
        path: "x.txt",
        signal: controller.signal,
        fetchImpl,
      }),
    (err) => err instanceof DOMException && err.name === "AbortError",
  );
  assert.equal(requestCount, 1);
  assert.equal(isAbortError(Object.assign(new Error("aborted"), { name: "AbortError" })), true);
  assert.equal(isAbortError(new Error("other failure")), false);
});

test("401 on HEAD sets auth status to unauthenticated", async () => {
  const fetchImpl: typeof fetch = async () =>
    new Response(null, { status: 401 });

  const { loadDesktopPreviewFile, FilePreviewError } = await import(
    "../src/lib/file-preview-api.ts"
  );

  await assert.rejects(
    () => loadDesktopPreviewFile({ cwd: "/p", path: "x.txt", fetchImpl }),
    (err) => err instanceof FilePreviewError && err.code === "failed",
  );
  assert.equal(getAuthStatus(), "unauthenticated");
});

test("401 on GET sets auth status to unauthenticated", async () => {
  const fetchImpl: typeof fetch = async (input, init) => {
    const method = (init?.method ?? "GET").toUpperCase();
    if (method === "HEAD") {
      return new Response(null, {
        status: 200,
        headers: { etag: 'W/"v1"', "content-type": "text/plain" },
      });
    }
    return new Response(null, { status: 401 });
  };

  const { loadDesktopPreviewFile, FilePreviewError } = await import(
    "../src/lib/file-preview-api.ts"
  );

  await assert.rejects(
    () => loadDesktopPreviewFile({ cwd: "/p", path: "x.txt", fetchImpl }),
    (err) => err instanceof FilePreviewError && err.code === "failed",
  );
  assert.equal(getAuthStatus(), "unauthenticated");
});

test("HTTP status mapping for GET errors", async () => {
  const { loadDesktopPreviewFile, FilePreviewError } = await import(
    "../src/lib/file-preview-api.ts"
  );

  const cases: Array<{ status: number; code: string }> = [
    { status: 403, code: "forbidden" },
    { status: 404, code: "missing" },
    { status: 410, code: "expired" },
    { status: 500, code: "failed" },
  ];

  for (const { status, code } of cases) {
    const fetchImpl: typeof fetch = async (input, init) => {
      const method = (init?.method ?? "GET").toUpperCase();
      if (method === "HEAD") {
        return new Response(null, {
          status: 200,
          headers: { etag: 'W/"v1"', "content-type": "text/plain" },
        });
      }
      return new Response(null, { status });
    };

    await assert.rejects(
      () => loadDesktopPreviewFile({ cwd: "/p", path: "x.txt", fetchImpl }),
      (err) => err instanceof FilePreviewError && err.code === code,
      `expected ${code} for status ${status}`,
    );
  }
});

test("resolves filename from Content-Disposition filename*", async () => {
  const fetchImpl: typeof fetch = async (input, init) => {
    const method = (init?.method ?? "GET").toUpperCase();
    if (method === "HEAD") {
      return new Response(null, {
        status: 200,
        headers: {
          etag: 'W/"v1"',
          "content-disposition":
            "attachment; filename*=UTF-8''%E4%B8%AD%E6%96%87.md",
        },
      });
    }
    return new Response(new Blob(["x"], { type: "text/markdown" }), {
      status: 200,
    });
  };

  const { loadDesktopPreviewFile } = await import(
    "../src/lib/file-preview-api.ts"
  );

  const file = await loadDesktopPreviewFile({
    cwd: "/p",
    path: "docs/a.md",
    fetchImpl,
  });
  assert.equal(file.name, "中文.md");
});

test("Content-Disposition path injection is sanitized to basename", async () => {
  const fetchImpl: typeof fetch = async (input, init) => {
    const method = (init?.method ?? "GET").toUpperCase();
    if (method === "HEAD") {
      return new Response(null, {
        status: 200,
        headers: {
          etag: 'W/"v1"',
          "content-disposition":
            "attachment; filename*=UTF-8''..%2F..%2F..%2Fetc%2Fsecret.txt",
        },
      });
    }
    return new Response(new Blob(["x"], { type: "text/plain" }), {
      status: 200,
    });
  };

  const { loadDesktopPreviewFile } = await import(
    "../src/lib/file-preview-api.ts"
  );

  const file = await loadDesktopPreviewFile({
    cwd: "/p",
    path: "docs/a.md",
    fetchImpl,
  });
  assert.equal(file.name, "secret.txt");
});

test("Content-Disposition preserves semicolons inside a quoted filename", async () => {
  const fetchImpl: typeof fetch = async (input, init) => {
    if ((init?.method ?? "GET").toUpperCase() === "HEAD") {
      return new Response(null, {
        status: 200,
        headers: {
          etag: 'W/"v1"',
          "content-disposition": 'attachment; ignored; filename="semi;colon.md"',
        },
      });
    }
    return new Response(new Blob(["x"], { type: "text/plain" }), { status: 200 });
  };

  const { loadDesktopPreviewFile } = await import(
    "../src/lib/file-preview-api.ts"
  );
  const file = await loadDesktopPreviewFile({ cwd: "/p", path: "docs/a.md", fetchImpl });

  assert.equal(file.name, "semi;colon.md");
});

test("Content-Disposition removes control characters from the filename", async () => {
  const fetchImpl: typeof fetch = async (input, init) => {
    if ((init?.method ?? "GET").toUpperCase() === "HEAD") {
      return new Response(null, {
        status: 200,
        headers: {
          etag: 'W/"v1"',
          "content-disposition": "attachment; filename=sa\u007Ffe.txt",
        },
      });
    }
    return new Response(new Blob(["x"], { type: "text/plain" }), { status: 200 });
  };

  const { loadDesktopPreviewFile } = await import(
    "../src/lib/file-preview-api.ts"
  );
  const file = await loadDesktopPreviewFile({ cwd: "/p", path: "docs/a.md", fetchImpl });

  assert.equal(file.name, "safe.txt");
  assert.doesNotMatch(file.name, /[\u0000-\u001f\u007f-\u009f]/);
});

test("falls back to path basename and handles Windows-style separators", async () => {
  const fetchImpl: typeof fetch = async (input, init) => {
    const method = (init?.method ?? "GET").toUpperCase();
    if (method === "HEAD") {
      return new Response(null, {
        status: 200,
        headers: { etag: 'W/"v1"' },
      });
    }
    return new Response(new Blob(["x"], { type: "text/plain" }), {
      status: 200,
    });
  };

  const { loadDesktopPreviewFile } = await import(
    "../src/lib/file-preview-api.ts"
  );

  const file = await loadDesktopPreviewFile({
    cwd: "/p",
    path: "dir\\file.txt",
    fetchImpl,
  });
  assert.equal(file.name, "file.txt");
});

test("uses HEAD content-type when GET response blob has no type", async () => {
  const fetchImpl: typeof fetch = async (input, init) => {
    const method = (init?.method ?? "GET").toUpperCase();
    if (method === "HEAD") {
      return new Response(null, {
        status: 200,
        headers: { etag: 'W/"v1"', "content-type": "text/markdown" },
      });
    }
    return new Response(new Uint8Array([104, 105]).buffer, { status: 200 });
  };

  const { loadDesktopPreviewFile } = await import(
    "../src/lib/file-preview-api.ts"
  );

  const file = await loadDesktopPreviewFile({
    cwd: "/p",
    path: "docs/a.md",
    fetchImpl,
  });
  assert.equal(file.type, "text/markdown");
});
