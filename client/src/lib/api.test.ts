// api.ts 防御性单元测试
// 通过 mock fetch 验证各种 API 调用的正确行为和错误处理

import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock 环境变量
vi.mock("../lib/api", async () => {
  const actual = await vi.importActual<typeof import("../lib/api")>("../lib/api");
  return actual;
});

// 设置环境变量
process.env.VITE_SERVER_URL = "http://test-server:8080";
process.env.VITE_AUTH_TOKEN = "test-token";

// 每个测试前重置 fetch mock
beforeEach(() => {
  vi.restoreAllMocks();
});

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

function mockFetchError(status: number) {
  return vi.fn().mockResolvedValue({
    ok: false,
    status,
    json: () => Promise.resolve({}),
    blob: () => Promise.reject(new Error("not ok")),
    arrayBuffer: () => Promise.reject(new Error("not ok")),
    text: () => Promise.resolve("error"),
  });
}

describe("API - listFiles", () => {
  it("成功列出目录", async () => {
    const { listFiles } = await import("../lib/api");
    globalThis.fetch = mockFetchOk({ path: "/", items: [] });
    const result = await listFiles("/");
    expect(result.path).toBe("/");
  });

  it("服务器错误时抛出异常", async () => {
    const { listFiles } = await import("../lib/api");
    globalThis.fetch = mockFetchError(500);
    await expect(listFiles("/")).rejects.toThrow("列出目录失败");
  });

  it("认证失败时抛出异常", async () => {
    const { listFiles } = await import("../lib/api");
    globalThis.fetch = mockFetchError(401);
    await expect(listFiles("/")).rejects.toThrow("列出目录失败");
  });
});

describe("API - downloadFile", () => {
  it("成功下载返回 Blob URL", async () => {
    const { downloadFile } = await import("../lib/api");
    globalThis.fetch = mockFetchOk({ data: "test" });
    // mock URL.createObjectURL
    globalThis.URL.createObjectURL = vi.fn(() => "blob:test");
    const result = await downloadFile("/test.txt");
    expect(result).toBe("blob:test");
  });

  it("文件不存在时抛出异常", async () => {
    const { downloadFile } = await import("../lib/api");
    globalThis.fetch = mockFetchError(404);
    await expect(downloadFile("/notfound.txt")).rejects.toThrow("下载文件失败");
  });
});

describe("API - uploadFile", () => {
  it("成功上传返回 etag", async () => {
    const { uploadFile } = await import("../lib/api");
    globalThis.fetch = mockFetchOk({ etag: "v1" });
    const file = new File(["content"], "test.txt", { type: "text/plain" });
    const etag = await uploadFile("/test.txt", file);
    expect(etag).toBe("v1");
  });

  it("上传失败时抛出异常", async () => {
    const { uploadFile } = await import("../lib/api");
    globalThis.fetch = mockFetchError(413); // Payload Too Large
    const file = new File(["x".repeat(1000)], "big.txt", { type: "text/plain" });
    await expect(uploadFile("/big.txt", file)).rejects.toThrow("上传文件失败");
  });
});

describe("API - createEntry", () => {
  it("成功创建返回 etag", async () => {
    const { createEntry } = await import("../lib/api");
    globalThis.fetch = mockFetchOk({ etag: "v1" });
    const etag = await createEntry("/newdir", true);
    expect(etag).toBe("v1");
  });

  it("已存在时抛出异常", async () => {
    const { createEntry } = await import("../lib/api");
    globalThis.fetch = mockFetchError(400);
    await expect(createEntry("/exists", false)).rejects.toThrow("创建失败");
  });
});

describe("API - deleteEntry", () => {
  it("成功删除无异常", async () => {
    const { deleteEntry } = await import("../lib/api");
    globalThis.fetch = mockFetchOk(null, 204);
    await expect(deleteEntry("/test.txt")).resolves.toBeUndefined();
  });

  it("删除不存在文件时抛出异常", async () => {
    const { deleteEntry } = await import("../lib/api");
    globalThis.fetch = mockFetchError(404);
    await expect(deleteEntry("/ghost.txt")).rejects.toThrow("删除失败");
  });
});

describe("API - renameEntry", () => {
  it("成功重命名返回 etag", async () => {
    const { renameEntry } = await import("../lib/api");
    globalThis.fetch = mockFetchOk({ etag: "v2" });
    const etag = await renameEntry("/old.txt", "/new.txt");
    expect(etag).toBe("v2");
  });

  it("源文件不存在时抛出异常", async () => {
    const { renameEntry } = await import("../lib/api");
    globalThis.fetch = mockFetchError(400);
    await expect(renameEntry("/ghost.txt", "/new.txt")).rejects.toThrow("重命名失败");
  });
});

describe("API - acquireLock", () => {
  it("成功获取写锁", async () => {
    const { acquireLock } = await import("../lib/api");
    globalThis.fetch = mockFetchOk({ lock_token: "tok-1", lease_until: 1700000000000 });
    const result = await acquireLock("/test.txt", "write");
    expect(result.lock_token).toBe("tok-1");
  });

  it("锁冲突时抛出异常", async () => {
    const { acquireLock } = await import("../lib/api");
    globalThis.fetch = mockFetchError(409);
    await expect(acquireLock("/locked.txt", "write")).rejects.toThrow("申请锁失败");
  });
});

describe("API - releaseLock", () => {
  it("成功释放锁", async () => {
    const { releaseLock } = await import("../lib/api");
    globalThis.fetch = mockFetchOk(null, 204);
    await expect(releaseLock("/test.txt", "tok-1")).resolves.toBeUndefined();
  });

  it("无效 token 时抛出异常", async () => {
    const { releaseLock } = await import("../lib/api");
    globalThis.fetch = mockFetchError(400);
    await expect(releaseLock("/test.txt", "invalid")).rejects.toThrow("释放锁失败");
  });
});

describe("API - renewLock", () => {
  it("成功续租返回新过期时间", async () => {
    const { renewLock } = await import("../lib/api");
    globalThis.fetch = mockFetchOk({ lease_until: 1700000060000 });
    const result = await renewLock("/test.txt", "tok-1");
    expect(result).toBe(1700000060000);
  });

  it("锁已过期时抛出异常", async () => {
    const { renewLock } = await import("../lib/api");
    globalThis.fetch = mockFetchError(409);
    await expect(renewLock("/test.txt", "expired")).rejects.toThrow("续租失败");
  });
});

describe("API - queryLock", () => {
  it("文件无锁返回 null", async () => {
    const { queryLock } = await import("../lib/api");
    globalThis.fetch = mockFetchOk(null);
    const result = await queryLock("/test.txt");
    expect(result).toBeNull();
  });

  it("文件有写锁返回锁信息", async () => {
    const { queryLock } = await import("../lib/api");
    globalThis.fetch = mockFetchOk({
      file_path: "/test.txt",
      lock_type: "write",
      holders: [{ client_id: "c1", user: "张三", acquired_at: 1700000000 }],
      lease_until: 1700000060,
    });
    const result = await queryLock("/test.txt");
    expect(result?.lock_type).toBe("write");
  });
});

describe("API - createEventSource", () => {
  it("创建 EventSource 连接到正确 URL", async () => {
    const mockES = vi.fn();
    globalThis.EventSource = mockES as any;
    const { createEventSource } = await import("../lib/api");
    createEventSource();
    expect(mockES).toHaveBeenCalledWith(expect.stringContaining("/api/events"));
  });
});

describe("API - 错误网络", () => {
  it("fetch 网络错误时抛出异常", async () => {
    const { listFiles } = await import("../lib/api");
    globalThis.fetch = vi.fn().mockRejectedValue(new TypeError("Failed to fetch"));
    await expect(listFiles("/")).rejects.toThrow();
  });
});
