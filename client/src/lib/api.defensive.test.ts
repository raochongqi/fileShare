// api.ts 防御性集成测试
// 聚焦于边界情况、网络异常、特殊输入和请求头/URL编码的正确性

import { describe, it, expect, vi, beforeEach } from "vitest";

// 设置环境变量
process.env.VITE_SERVER_URL = "http://test-server:8080";
process.env.VITE_AUTH_TOKEN = "test-token";

// 每个测试前重置所有 mock
beforeEach(() => {
  vi.restoreAllMocks();
});

// ---- 辅助函数 ----

/** 构造一个成功的 fetch mock，支持自定义 status / body / 方法 */
function mockFetchOk(data: unknown, status = 200) {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(data),
    blob: () => Promise.resolve(new Blob([JSON.stringify(data)])),
    arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
    text: () => Promise.resolve(JSON.stringify(data)),
  });
}

/** 构造一个非 2xx 的 fetch mock */
function mockFetchError(status: number, body: unknown = {}) {
  return vi.fn().mockResolvedValue({
    ok: false,
    status,
    json: () => Promise.resolve(body),
    blob: () => Promise.reject(new Error("not ok")),
    arrayBuffer: () => Promise.reject(new Error("not ok")),
    text: () => Promise.resolve(JSON.stringify(body)),
  });
}

// ====================================================================
// 1. 网络级防御性测试
// ====================================================================

describe("网络级防御 - fetch 抛出 TypeError（网络离线）", () => {
  // 当浏览器完全离线时，fetch 会抛出 TypeError("Failed to fetch")
  // API 层应将该异常传播给调用方
  it("listFiles: fetch 抛出 TypeError 时应向上传播", async () => {
    const { listFiles } = await import("../lib/api");
    globalThis.fetch = vi.fn().mockRejectedValue(new TypeError("Failed to fetch"));
    await expect(listFiles("/")).rejects.toThrow(TypeError);
    await expect(listFiles("/")).rejects.toThrow("Failed to fetch");
  });

  it("downloadFile: fetch 抛出 TypeError 时应向上传播", async () => {
    const { downloadFile } = await import("../lib/api");
    globalThis.fetch = vi.fn().mockRejectedValue(new TypeError("Failed to fetch"));
    await expect(downloadFile("/a.txt")).rejects.toThrow("Failed to fetch");
  });

  it("uploadFile: fetch 抛出 TypeError 时应向上传播", async () => {
    const { uploadFile } = await import("../lib/api");
    globalThis.fetch = vi.fn().mockRejectedValue(new TypeError("Failed to fetch"));
    const file = new File(["x"], "a.txt", { type: "text/plain" });
    await expect(uploadFile("/a.txt", file)).rejects.toThrow("Failed to fetch");
  });

  it("acquireLock: fetch 抛出 TypeError 时应向上传播", async () => {
    const { acquireLock } = await import("../lib/api");
    globalThis.fetch = vi.fn().mockRejectedValue(new TypeError("Failed to fetch"));
    await expect(acquireLock("/a.txt", "write")).rejects.toThrow("Failed to fetch");
  });
});

describe("网络级防御 - fetch 返回畸形 JSON", () => {
  // 服务器返回 200 但 body 不是合法 JSON，json() 会抛出 SyntaxError
  it("listFiles: json() 抛出 SyntaxError 时应向上传播", async () => {
    const { listFiles } = await import("../lib/api");
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.reject(new SyntaxError("Unexpected token")),
    });
    await expect(listFiles("/")).rejects.toThrow(SyntaxError);
  });

  it("searchFiles: json() 抛出 SyntaxError 时应向上传播", async () => {
    const { searchFiles } = await import("../lib/api");
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.reject(new SyntaxError("Unexpected token")),
    });
    await expect(searchFiles("test")).rejects.toThrow(SyntaxError);
  });

  it("getFileInfo: json() 抛出 SyntaxError 时应向上传播", async () => {
    const { getFileInfo } = await import("../lib/api");
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.reject(new SyntaxError("Unexpected token")),
    });
    await expect(getFileInfo("/a.txt")).rejects.toThrow(SyntaxError);
  });
});

describe("网络级防御 - fetch 返回空 body 且 status=200", () => {
  // 服务器返回 200 但 body 为空字符串，json() 会抛出解析错误
  it("listFiles: 空 body 导致 json() 解析失败应向上传播", async () => {
    const { listFiles } = await import("../lib/api");
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.reject(new SyntaxError("Unexpected end of JSON input")),
      text: () => Promise.resolve(""),
    });
    await expect(listFiles("/")).rejects.toThrow();
  });

  it("queryLock: 空 body 但 json() 正常返回空对象", async () => {
    const { queryLock } = await import("../lib/api");
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve(null),
    });
    const result = await queryLock("/a.txt");
    expect(result).toBeNull();
  });
});

describe("网络级防御 - fetch 超时（AbortController signal）", () => {
  // 当 AbortController 触发 abort 时，fetch 会抛出 DOMException/AbortError
  it("listFiles: fetch 被 abort 后应抛出 AbortError", async () => {
    const { listFiles } = await import("../lib/api");
    const abortError = new DOMException("The operation was aborted.", "AbortError");
    globalThis.fetch = vi.fn().mockRejectedValue(abortError);
    await expect(listFiles("/")).rejects.toThrow("The operation was aborted.");
  });
});

describe("网络级防御 - 服务器返回 500 内部错误", () => {
  it("listFiles: 500 时抛出包含状态码的错误", async () => {
    const { listFiles } = await import("../lib/api");
    globalThis.fetch = mockFetchError(500);
    await expect(listFiles("/")).rejects.toThrow("列出目录失败: 500");
  });

  it("downloadFile: 500 时抛出错误", async () => {
    const { downloadFile } = await import("../lib/api");
    globalThis.fetch = mockFetchError(500);
    await expect(downloadFile("/a.txt")).rejects.toThrow("下载文件失败: 500");
  });

  it("deleteEntry: 500 时抛出错误", async () => {
    const { deleteEntry } = await import("../lib/api");
    globalThis.fetch = mockFetchError(500);
    await expect(deleteEntry("/a.txt")).rejects.toThrow("删除失败: 500");
  });
});

describe("网络级防御 - 服务器返回 503 服务不可用", () => {
  it("listFiles: 503 时抛出包含状态码的错误", async () => {
    const { listFiles } = await import("../lib/api");
    globalThis.fetch = mockFetchError(503);
    await expect(listFiles("/")).rejects.toThrow("列出目录失败: 503");
  });

  it("uploadFile: 503 时抛出错误", async () => {
    const { uploadFile } = await import("../lib/api");
    globalThis.fetch = mockFetchError(503);
    const file = new File(["x"], "a.txt", { type: "text/plain" });
    await expect(uploadFile("/a.txt", file)).rejects.toThrow("上传文件失败: 503");
  });
});

describe("网络级防御 - 服务器返回 429 请求过多", () => {
  it("listFiles: 429 时抛出包含状态码的错误", async () => {
    const { listFiles } = await import("../lib/api");
    globalThis.fetch = mockFetchError(429);
    await expect(listFiles("/")).rejects.toThrow("列出目录失败: 429");
  });

  it("acquireLock: 429 时抛出错误", async () => {
    const { acquireLock } = await import("../lib/api");
    globalThis.fetch = mockFetchError(429);
    await expect(acquireLock("/a.txt", "write")).rejects.toThrow("申请锁失败: 429");
  });
});

// ====================================================================
// 2. API 特定防御性测试
// ====================================================================

describe("API 特定防御 - downloadFile: response 没有 blob / blob() 拒绝", () => {
  // 当服务器返回 200 但 blob() 调用失败时（例如 Content-Length 不匹配）
  it("blob() 拒绝时应向上传播错误", async () => {
    const { downloadFile } = await import("../lib/api");
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      blob: () => Promise.reject(new Error("blob read error")),
    });
    await expect(downloadFile("/a.txt")).rejects.toThrow("blob read error");
  });
});

describe("API 特定防御 - downloadFileBuffer: arrayBuffer() 拒绝", () => {
  it("arrayBuffer() 拒绝时应向上传播错误", async () => {
    const { downloadFileBuffer } = await import("../lib/api");
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      arrayBuffer: () => Promise.reject(new Error("arraybuffer read error")),
    });
    await expect(downloadFileBuffer("/a.txt")).rejects.toThrow("arraybuffer read error");
  });
});

describe("API 特定防御 - uploadFile: 空文件上传（0 字节）", () => {
  // 上传 0 字节文件是一个合法但特殊的边界情况
  it("0 字节文件上传成功应返回 etag", async () => {
    const { uploadFile } = await import("../lib/api");
    globalThis.fetch = mockFetchOk({ etag: "empty-v1" });
    const emptyFile = new File([], "empty.txt", { type: "text/plain" });
    const etag = await uploadFile("/empty.txt", emptyFile);
    expect(etag).toBe("empty-v1");
  });

  it("0 字节文件上传时 fetch 被正确调用", async () => {
    const { uploadFile } = await import("../lib/api");
    const mockFetch = mockFetchOk({ etag: "empty-v1" });
    globalThis.fetch = mockFetch;
    const emptyFile = new File([], "empty.txt", { type: "text/plain" });
    await uploadFile("/empty.txt", emptyFile);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    // 验证 URL 中 path 参数正确编码
    const calledUrl = mockFetch.mock.calls[0][0] as string;
    expect(calledUrl).toContain("/api/files/content?path=");
  });
});

describe("API 特定防御 - uploadFile: 非常长的文件名", () => {
  // 超长文件名可能导致服务器 414 或 413，验证客户端行为
  it("超长文件名导致服务器 413 时应抛出错误", async () => {
    const { uploadFile } = await import("../lib/api");
    globalThis.fetch = mockFetchError(413);
    const longName = "a".repeat(500) + ".txt";
    const file = new File(["x"], longName, { type: "text/plain" });
    await expect(uploadFile(`/${longName}`, file)).rejects.toThrow("上传文件失败: 413");
  });

  it("超长文件名导致服务器 414 时应抛出错误", async () => {
    const { uploadFile } = await import("../lib/api");
    globalThis.fetch = mockFetchError(414);
    const longName = "a".repeat(500) + ".txt";
    const file = new File(["x"], longName, { type: "text/plain" });
    await expect(uploadFile(`/${longName}`, file)).rejects.toThrow("上传文件失败: 414");
  });
});

describe("API 特定防御 - createEntry: 路径含特殊字符（空格、中文、%、#）", () => {
  // 空格、中文、%、# 都是 URL 中的特殊字符，需要正确编码
  it("路径含空格和中文时创建成功", async () => {
    const { createEntry } = await import("../lib/api");
    const mockFetch = mockFetchOk({ etag: "special-v1" });
    globalThis.fetch = mockFetch;
    const etag = await createEntry("/我的 文件夹", true);
    expect(etag).toBe("special-v1");
    // 验证 URL 中 path 参数正确编码
    const calledUrl = mockFetch.mock.calls[0][0] as string;
    expect(calledUrl).toContain(encodeURIComponent("/我的 文件夹"));
  });

  it("路径含 % 和 # 时创建成功", async () => {
    const { createEntry } = await import("../lib/api");
    const mockFetch = mockFetchOk({ etag: "pct-v1" });
    globalThis.fetch = mockFetch;
    const etag = await createEntry("/100%进度#1", true);
    expect(etag).toBe("pct-v1");
    const calledUrl = mockFetch.mock.calls[0][0] as string;
    expect(calledUrl).toContain(encodeURIComponent("/100%进度#1"));
  });
});

describe("API 特定防御 - renameEntry: new_path 与 old_path 相同", () => {
  // 重命名到相同路径：某些服务器可能返回 200（幂等），某些可能返回 400
  it("服务器返回 200 时视为成功（幂等）", async () => {
    const { renameEntry } = await import("../lib/api");
    globalThis.fetch = mockFetchOk({ etag: "same-v1" });
    const etag = await renameEntry("/a.txt", "/a.txt");
    expect(etag).toBe("same-v1");
  });

  it("服务器返回 400 时抛出错误", async () => {
    const { renameEntry } = await import("../lib/api");
    globalThis.fetch = mockFetchError(400);
    await expect(renameEntry("/a.txt", "/a.txt")).rejects.toThrow("重命名失败: 400");
  });
});

describe("API 特定防御 - renameEntry: 目标路径已存在（409 冲突）", () => {
  it("目标已存在时服务器返回 409 应抛出错误", async () => {
    const { renameEntry } = await import("../lib/api");
    globalThis.fetch = mockFetchError(409);
    await expect(renameEntry("/a.txt", "/b.txt")).rejects.toThrow("重命名失败: 409");
  });
});

describe("API 特定防御 - deleteEntry: 服务器返回 403 禁止（无权限）", () => {
  it("无权限删除时服务器返回 403 应抛出错误", async () => {
    const { deleteEntry } = await import("../lib/api");
    globalThis.fetch = mockFetchError(403);
    await expect(deleteEntry("/protected.txt")).rejects.toThrow("删除失败: 403");
  });
});

describe("API 特定防御 - searchFiles: 空查询字符串", () => {
  // 空字符串搜索是一个边界情况：应成功发起请求（q= 为空）
  it("空查询字符串应正常发起请求并返回结果", async () => {
    const { searchFiles } = await import("../lib/api");
    const mockFetch = mockFetchOk({ path: "/", items: [] });
    globalThis.fetch = mockFetch;
    const result = await searchFiles("");
    expect(result.items).toEqual([]);
    // 验证 URL 中 q 参数为空
    const calledUrl = mockFetch.mock.calls[0][0] as string;
    expect(calledUrl).toContain("q=");
  });
});

describe("API 特定防御 - searchFiles: 查询含正则特殊字符", () => {
  // 用户可能输入 .*、$、^ 等正则特殊字符，API 层应正确编码
  it("查询含正则特殊字符时应正确编码并返回结果", async () => {
    const { searchFiles } = await import("../lib/api");
    const mockFetch = mockFetchOk({ path: "/", items: [] });
    globalThis.fetch = mockFetch;
    const result = await searchFiles(".*+?^${}()|[]\\");
    expect(result.items).toEqual([]);
    const calledUrl = mockFetch.mock.calls[0][0] as string;
    // 验证特殊字符被 encodeURIComponent 正确编码
    expect(calledUrl).toContain(encodeURIComponent(".*+?^${}()|[]\\"));
  });
});

describe("API 特定防御 - acquireLock: 服务器返回 403（该用户不允许加锁）", () => {
  it("无权限加锁时服务器返回 403 应抛出错误", async () => {
    const { acquireLock } = await import("../lib/api");
    globalThis.fetch = mockFetchError(403);
    await expect(acquireLock("/secret.txt", "write")).rejects.toThrow("申请锁失败: 403");
  });
});

describe("API 特定防御 - releaseLock: 服务器返回 404（锁已释放/过期）", () => {
  // 锁可能已经被其他操作释放或自然过期，服务器返回 404
  it("锁已不存在时服务器返回 404 应抛出错误", async () => {
    const { releaseLock } = await import("../lib/api");
    globalThis.fetch = mockFetchError(404);
    await expect(releaseLock("/a.txt", "expired-token")).rejects.toThrow("释放锁失败: 404");
  });
});

describe("API 特定防御 - renewLock: 服务器返回 410（锁已过期/消失）", () => {
  // 410 Gone 表示资源曾经存在但已被删除
  it("锁已过期时服务器返回 410 应抛出错误", async () => {
    const { renewLock } = await import("../lib/api");
    globalThis.fetch = mockFetchError(410);
    await expect(renewLock("/a.txt", "gone-token")).rejects.toThrow("续租失败: 410");
  });
});

describe("API 特定防御 - queryLock: 服务器返回 500", () => {
  it("查询锁状态时服务器 500 应抛出错误", async () => {
    const { queryLock } = await import("../lib/api");
    globalThis.fetch = mockFetchError(500);
    await expect(queryLock("/a.txt")).rejects.toThrow("查询锁状态失败: 500");
  });
});

// ====================================================================
// 3. Auth 请求头验证测试
// ====================================================================

describe("Auth 请求头 - Authorization 格式", () => {
  // 所有 API 调用都应包含 Authorization: Bearer {token} 头

  it("listFiles: 请求头包含 Authorization Bearer token", async () => {
    const { listFiles } = await import("../lib/api");
    const mockFetch = mockFetchOk({ path: "/", items: [] });
    globalThis.fetch = mockFetch;
    await listFiles("/");
    const opts = mockFetch.mock.calls[0][1] as RequestInit;
    expect(opts.headers).toHaveProperty("Authorization", "Bearer test-token");
  });

  it("downloadFile: 请求头包含 Authorization Bearer token", async () => {
    const { downloadFile } = await import("../lib/api");
    const mockFetch = mockFetchOk({ data: "test" });
    globalThis.fetch = mockFetch;
    globalThis.URL.createObjectURL = vi.fn(() => "blob:test");
    await downloadFile("/a.txt");
    const opts = mockFetch.mock.calls[0][1] as RequestInit;
    expect(opts.headers).toHaveProperty("Authorization", "Bearer test-token");
  });

  it("uploadFile: 请求头包含 Authorization Bearer token", async () => {
    const { uploadFile } = await import("../lib/api");
    const mockFetch = mockFetchOk({ etag: "v1" });
    globalThis.fetch = mockFetch;
    const file = new File(["x"], "a.txt", { type: "text/plain" });
    await uploadFile("/a.txt", file);
    const opts = mockFetch.mock.calls[0][1] as RequestInit;
    expect(opts.headers).toHaveProperty("Authorization", "Bearer test-token");
  });

  it("deleteEntry: 请求头包含 Authorization Bearer token", async () => {
    const { deleteEntry } = await import("../lib/api");
    const mockFetch = mockFetchOk(null, 204);
    globalThis.fetch = mockFetch;
    await deleteEntry("/a.txt");
    const opts = mockFetch.mock.calls[0][1] as RequestInit;
    expect(opts.headers).toHaveProperty("Authorization", "Bearer test-token");
  });

  it("searchFiles: 请求头包含 Authorization Bearer token", async () => {
    const { searchFiles } = await import("../lib/api");
    const mockFetch = mockFetchOk({ path: "/", items: [] });
    globalThis.fetch = mockFetch;
    await searchFiles("test");
    const opts = mockFetch.mock.calls[0][1] as RequestInit;
    expect(opts.headers).toHaveProperty("Authorization", "Bearer test-token");
  });

  it("getFileInfo: 请求头包含 Authorization Bearer token", async () => {
    const { getFileInfo } = await import("../lib/api");
    const mockFetch = mockFetchOk({
      path: "/a.txt",
      is_dir: false,
      size: 10,
      modified_at: "2024-01-01",
      created_at: "2024-01-01",
      etag: "v1",
      mime_type: "text/plain",
      lock: null,
    });
    globalThis.fetch = mockFetch;
    await getFileInfo("/a.txt");
    const opts = mockFetch.mock.calls[0][1] as RequestInit;
    expect(opts.headers).toHaveProperty("Authorization", "Bearer test-token");
  });

  it("queryLock: 请求头包含 Authorization Bearer token", async () => {
    const { queryLock } = await import("../lib/api");
    const mockFetch = mockFetchOk(null);
    globalThis.fetch = mockFetch;
    await queryLock("/a.txt");
    const opts = mockFetch.mock.calls[0][1] as RequestInit;
    expect(opts.headers).toHaveProperty("Authorization", "Bearer test-token");
  });
});

describe("Auth 请求头 - X-Lock-Token 头", () => {
  // 锁操作（renewLock、releaseLock）应包含 X-Lock-Token 头

  it("renewLock: 请求头包含 X-Lock-Token", async () => {
    const { renewLock } = await import("../lib/api");
    const mockFetch = mockFetchOk({ lease_until: 1700000060000 });
    globalThis.fetch = mockFetch;
    await renewLock("/a.txt", "my-lock-token");
    const opts = mockFetch.mock.calls[0][1] as RequestInit;
    expect(opts.headers).toHaveProperty("X-Lock-Token", "my-lock-token");
  });

  it("releaseLock: 请求头包含 X-Lock-Token", async () => {
    const { releaseLock } = await import("../lib/api");
    const mockFetch = mockFetchOk(null, 204);
    globalThis.fetch = mockFetch;
    await releaseLock("/a.txt", "my-lock-token");
    const opts = mockFetch.mock.calls[0][1] as RequestInit;
    expect(opts.headers).toHaveProperty("X-Lock-Token", "my-lock-token");
  });

  // acquireLock 不需要 X-Lock-Token（是申请锁，不是操作已有的锁）
  it("acquireLock: 请求头不包含 X-Lock-Token", async () => {
    const { acquireLock } = await import("../lib/api");
    const mockFetch = mockFetchOk({ lock_token: "tok-1", lease_until: 1700000000000 });
    globalThis.fetch = mockFetch;
    await acquireLock("/a.txt", "write");
    const opts = mockFetch.mock.calls[0][1] as RequestInit;
    expect(opts.headers).not.toHaveProperty("X-Lock-Token");
  });
});

describe("Auth 请求头 - Content-Type 设置", () => {
  // 带 JSON body 的请求应设置 Content-Type: application/json
  // uploadFile 使用 FormData，不应手动设置 Content-Type（浏览器自动设置 multipart boundary）

  it("renameEntry: 请求头包含 Content-Type application/json", async () => {
    const { renameEntry } = await import("../lib/api");
    const mockFetch = mockFetchOk({ etag: "v2" });
    globalThis.fetch = mockFetch;
    await renameEntry("/old.txt", "/new.txt");
    const opts = mockFetch.mock.calls[0][1] as RequestInit;
    expect(opts.headers).toHaveProperty("Content-Type", "application/json");
  });

  it("acquireLock: 请求头包含 Content-Type application/json", async () => {
    const { acquireLock } = await import("../lib/api");
    const mockFetch = mockFetchOk({ lock_token: "tok-1", lease_until: 1700000000000 });
    globalThis.fetch = mockFetch;
    await acquireLock("/a.txt", "write");
    const opts = mockFetch.mock.calls[0][1] as RequestInit;
    expect(opts.headers).toHaveProperty("Content-Type", "application/json");
  });

  it("renewLock: 请求头包含 Content-Type application/json", async () => {
    const { renewLock } = await import("../lib/api");
    const mockFetch = mockFetchOk({ lease_until: 1700000060000 });
    globalThis.fetch = mockFetch;
    await renewLock("/a.txt", "tok-1");
    const opts = mockFetch.mock.calls[0][1] as RequestInit;
    expect(opts.headers).toHaveProperty("Content-Type", "application/json");
  });

  it("uploadFile: 请求头不包含手动设置的 Content-Type（FormData 自动处理）", async () => {
    const { uploadFile } = await import("../lib/api");
    const mockFetch = mockFetchOk({ etag: "v1" });
    globalThis.fetch = mockFetch;
    const file = new File(["x"], "a.txt", { type: "text/plain" });
    await uploadFile("/a.txt", file);
    const opts = mockFetch.mock.calls[0][1] as RequestInit;
    expect(opts.headers).not.toHaveProperty("Content-Type");
  });

  it("listFiles: GET 请求不包含 Content-Type", async () => {
    const { listFiles } = await import("../lib/api");
    const mockFetch = mockFetchOk({ path: "/", items: [] });
    globalThis.fetch = mockFetch;
    await listFiles("/");
    const opts = mockFetch.mock.calls[0][1] as RequestInit;
    expect(opts.headers).not.toHaveProperty("Content-Type");
  });
});

// ====================================================================
// 4. URL 编码防御性测试
// ====================================================================

describe("URL 编码防御 - 路径含中文字符", () => {
  // 中文字符在 URL 中必须被 encodeURIComponent 编码
  it("listFiles: 中文路径被正确编码", async () => {
    const { listFiles } = await import("../lib/api");
    const mockFetch = mockFetchOk({ path: "/文档", items: [] });
    globalThis.fetch = mockFetch;
    await listFiles("/文档");
    const calledUrl = mockFetch.mock.calls[0][0] as string;
    expect(calledUrl).toContain(encodeURIComponent("/文档"));
  });

  it("downloadFile: 中文路径被正确编码", async () => {
    const { downloadFile } = await import("../lib/api");
    const mockFetch = mockFetchOk({ data: "test" });
    globalThis.fetch = mockFetch;
    globalThis.URL.createObjectURL = vi.fn(() => "blob:test");
    await downloadFile("/文档/报告.txt");
    const calledUrl = mockFetch.mock.calls[0][0] as string;
    expect(calledUrl).toContain(encodeURIComponent("/文档/报告.txt"));
  });

  it("deleteEntry: 中文路径被正确编码", async () => {
    const { deleteEntry } = await import("../lib/api");
    const mockFetch = mockFetchOk(null, 204);
    globalThis.fetch = mockFetch;
    await deleteEntry("/文档/旧文件.txt");
    const calledUrl = mockFetch.mock.calls[0][0] as string;
    expect(calledUrl).toContain(encodeURIComponent("/文档/旧文件.txt"));
  });

  it("getFileInfo: 中文路径被正确编码", async () => {
    const { getFileInfo } = await import("../lib/api");
    const mockFetch = mockFetchOk({
      path: "/文档/信息.txt",
      is_dir: false,
      size: 10,
      modified_at: "2024-01-01",
      created_at: "2024-01-01",
      etag: "v1",
      mime_type: "text/plain",
      lock: null,
    });
    globalThis.fetch = mockFetch;
    await getFileInfo("/文档/信息.txt");
    const calledUrl = mockFetch.mock.calls[0][0] as string;
    expect(calledUrl).toContain(encodeURIComponent("/文档/信息.txt"));
  });

  it("queryLock: 中文路径被正确编码", async () => {
    const { queryLock } = await import("../lib/api");
    const mockFetch = mockFetchOk(null);
    globalThis.fetch = mockFetch;
    await queryLock("/文档/共享.txt");
    const calledUrl = mockFetch.mock.calls[0][0] as string;
    expect(calledUrl).toContain(encodeURIComponent("/文档/共享.txt"));
  });

  it("releaseLock: 中文路径被正确编码", async () => {
    const { releaseLock } = await import("../lib/api");
    const mockFetch = mockFetchOk(null, 204);
    globalThis.fetch = mockFetch;
    await releaseLock("/文档/共享.txt", "tok-1");
    const calledUrl = mockFetch.mock.calls[0][0] as string;
    expect(calledUrl).toContain(encodeURIComponent("/文档/共享.txt"));
  });
});

describe("URL 编码防御 - 路径含空格", () => {
  // 空格在 URL 中必须被编码为 %20，而非 + 号
  it("listFiles: 含空格路径被正确编码", async () => {
    const { listFiles } = await import("../lib/api");
    const mockFetch = mockFetchOk({ path: "/my folder", items: [] });
    globalThis.fetch = mockFetch;
    await listFiles("/my folder");
    const calledUrl = mockFetch.mock.calls[0][0] as string;
    expect(calledUrl).toContain(encodeURIComponent("/my folder"));
    // encodeURIComponent 将空格编码为 %20 而非 +
    expect(calledUrl).not.toContain("+");
  });

  it("uploadFile: 含空格路径被正确编码", async () => {
    const { uploadFile } = await import("../lib/api");
    const mockFetch = mockFetchOk({ etag: "v1" });
    globalThis.fetch = mockFetch;
    const file = new File(["x"], "a.txt", { type: "text/plain" });
    await uploadFile("/my folder/a.txt", file);
    const calledUrl = mockFetch.mock.calls[0][0] as string;
    expect(calledUrl).toContain(encodeURIComponent("/my folder/a.txt"));
  });
});

describe("URL 编码防御 - 路径含 # 和 ? 字符", () => {
  // # 在 URL 中是片段分隔符，? 是查询分隔符
  // 必须被 encodeURIComponent 编码，否则会截断 URL
  it("listFiles: 含 # 的路径被正确编码", async () => {
    const { listFiles } = await import("../lib/api");
    const mockFetch = mockFetchOk({ path: "/file#1", items: [] });
    globalThis.fetch = mockFetch;
    await listFiles("/file#1");
    const calledUrl = mockFetch.mock.calls[0][0] as string;
    expect(calledUrl).toContain(encodeURIComponent("/file#1"));
  });

  it("listFiles: 含 ? 的路径被正确编码", async () => {
    const { listFiles } = await import("../lib/api");
    const mockFetch = mockFetchOk({ path: "/file?v=1", items: [] });
    globalThis.fetch = mockFetch;
    await listFiles("/file?v=1");
    const calledUrl = mockFetch.mock.calls[0][0] as string;
    expect(calledUrl).toContain(encodeURIComponent("/file?v=1"));
  });

  it("searchFiles: 含 # 和 ? 的查询被正确编码", async () => {
    const { searchFiles } = await import("../lib/api");
    const mockFetch = mockFetchOk({ path: "/", items: [] });
    globalThis.fetch = mockFetch;
    await searchFiles("what?#1");
    const calledUrl = mockFetch.mock.calls[0][0] as string;
    expect(calledUrl).toContain(encodeURIComponent("what?#1"));
  });

  it("downloadFile: 含 # 的路径被正确编码", async () => {
    const { downloadFile } = await import("../lib/api");
    const mockFetch = mockFetchOk({ data: "test" });
    globalThis.fetch = mockFetch;
    globalThis.URL.createObjectURL = vi.fn(() => "blob:test");
    await downloadFile("/file#1.txt");
    const calledUrl = mockFetch.mock.calls[0][0] as string;
    expect(calledUrl).toContain(encodeURIComponent("/file#1.txt"));
  });
});
