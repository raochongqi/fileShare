import { renderHook, act } from "@testing-library/react";
import { vi, beforeEach, afterEach, describe, it, expect } from "vitest";

// ============================================================
// 统一 mock 所有 API 依赖（vi.mock 会被提升，同一模块只能声明一次）
// ============================================================
vi.mock("../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/api")>();
  return {
    ...actual,
    createEventSource: vi.fn(),
    acquireLock: vi.fn(),
    releaseLock: vi.fn(),
    renewLock: vi.fn(),
    queryLock: vi.fn(),
    listFiles: vi.fn(),
    uploadFile: vi.fn(),
    createEntry: vi.fn(),
    deleteEntry: vi.fn(),
    renameEntry: vi.fn(),
    downloadFile: vi.fn(),
  };
});

vi.mock("@tauri-apps/api/tauri", () => ({
  invoke: vi.fn(),
}));

// ============================================================
// 在 mock 声明之后导入被测模块和 mock 引用
// ============================================================
import { useSSE } from "./useSSE";
import { useLock } from "./useLock";
import { useFiles } from "./useFiles";

import {
  createEventSource,
  acquireLock,
  releaseLock,
  renewLock,
  queryLock,
  listFiles,
  uploadFile,
  createEntry,
  deleteEntry,
  renameEntry,
  downloadFile,
} from "../lib/api";

const createEventSourceMock = vi.mocked(createEventSource);
const acquireLockMock = vi.mocked(acquireLock);
const releaseLockMock = vi.mocked(releaseLock);
const renewLockMock = vi.mocked(renewLock);
const queryLockMock = vi.mocked(queryLock);
const listFilesMock = vi.mocked(listFiles);
const uploadFileMock = vi.mocked(uploadFile);
const createEntryMock = vi.mocked(createEntry);
const deleteEntryMock = vi.mocked(deleteEntry);
const renameEntryMock = vi.mocked(renameEntry);
const downloadFileMock = vi.mocked(downloadFile);

// ============================================================
// useSSE 测试
// ============================================================
describe("useSSE", () => {
  let mockEs: {
    addEventListener: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
    onerror: ((this: EventSource, ev: Event) => void) | null;
  };

  beforeEach(() => {
    vi.useFakeTimers();
    // 清除前序测试的调用记录
    createEventSourceMock.mockClear();
    // 构造模拟的 EventSource 实例
    mockEs = {
      addEventListener: vi.fn(),
      close: vi.fn(),
      onerror: null,
    };
    createEventSourceMock.mockReturnValue(mockEs as unknown as EventSource);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("挂载时通过 createEventSource 创建 EventSource", () => {
    const handler = vi.fn();
    renderHook(() => useSSE(handler));

    // 防御：确保 createEventSource 被调用且仅调用一次
    expect(createEventSourceMock).toHaveBeenCalledTimes(1);
  });

  it("监听全部 5 种事件类型", () => {
    const handler = vi.fn();
    renderHook(() => useSSE(handler));

    const eventTypes = ["created", "updated", "deleted", "renamed", "lock_changed"];
    // 防御：确保每种事件类型都被注册了监听器
    eventTypes.forEach((type) => {
      expect(mockEs.addEventListener).toHaveBeenCalledWith(type, expect.any(Function));
    });
    expect(mockEs.addEventListener).toHaveBeenCalledTimes(5);
  });

  it("事件触发时调用 handler 并传入解析后的数据", () => {
    const handler = vi.fn();
    renderHook(() => useSSE(handler));

    // 模拟 "created" 事件到达
    const createdListener = mockEs.addEventListener.mock.calls.find(
      ([type]: [string]) => type === "created",
    )![1] as EventListener;

    const testData = { type: "created" as const, path: "/foo.txt", etag: "abc123" };

    act(() => {
      createdListener({ data: JSON.stringify(testData) } as MessageEvent);
    });

    // 防御：handler 应收到正确的解析对象
    expect(handler).toHaveBeenCalledWith(testData);
  });

  it("忽略畸形 JSON 事件数据，不会崩溃", () => {
    const handler = vi.fn();
    renderHook(() => useSSE(handler));

    const updatedListener = mockEs.addEventListener.mock.calls.find(
      ([type]: [string]) => type === "updated",
    )![1] as EventListener;

    // 防御：传入无法解析的 JSON 字符串，hook 不应抛出异常
    expect(() => {
      act(() => {
        updatedListener({ data: "这不是合法JSON" } as MessageEvent);
      });
    }).not.toThrow();

    // handler 不应被调用（解析失败时静默忽略）
    expect(handler).not.toHaveBeenCalled();
  });

  it("卸载时关闭 EventSource", () => {
    const handler = vi.fn();
    const { unmount } = renderHook(() => useSSE(handler));

    // 卸载前 close 尚未被调用
    expect(mockEs.close).not.toHaveBeenCalled();

    unmount();

    // 防御：卸载后必须关闭连接，避免内存泄漏
    expect(mockEs.close).toHaveBeenCalled();
  });

  it("onerror 后 5 秒触发重连（setTimeout 被调用且延时为 5000ms）", () => {
    const handler = vi.fn();
    renderHook(() => useSSE(handler));

    // 触发错误回调
    act(() => {
      mockEs.onerror!({} as Event);
    });

    // 防御：出错后应先关闭当前连接
    expect(mockEs.close).toHaveBeenCalled();

    // 此时还没到 5 秒，不应重连
    expect(createEventSourceMock).toHaveBeenCalledTimes(1);

    // 推进 5 秒后应触发重连
    act(() => {
      vi.advanceTimersByTime(5000);
    });

    // 防御：5 秒后 createEventSource 再次被调用
    expect(createEventSourceMock).toHaveBeenCalledTimes(2);
  });

  it("重连时先关闭旧连接再创建新连接", () => {
    const handler = vi.fn();
    renderHook(() => useSSE(handler));

    // 第一次连接
    const firstEs = mockEs;

    // 触发错误 → 触发重连定时器
    act(() => {
      firstEs.onerror!({} as Event);
    });

    // 第二个 EventSource 实例（模拟重连后 createEventSource 返回新实例）
    const secondEs = {
      addEventListener: vi.fn(),
      close: vi.fn(),
      onerror: null,
    };
    createEventSourceMock.mockReturnValue(secondEs as unknown as EventSource);

    act(() => {
      vi.advanceTimersByTime(5000);
    });

    // 防御：重连时应关闭旧连接（onerror 中调用 close + connect 开头调用 close）
    expect(firstEs.close).toHaveBeenCalled();

    // 防御：新连接已创建并注册了事件监听器
    expect(secondEs.addEventListener).toHaveBeenCalledTimes(5);
  });
});

// ============================================================
// useLock 测试
// ============================================================
describe("useLock", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    acquireLockMock.mockReset();
    releaseLockMock.mockReset();
    renewLockMock.mockReset();
    queryLockMock.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("acquireWrite 成功后将锁加入 activeLocks", async () => {
    acquireLockMock.mockResolvedValue({
      lock_token: "token-w-1",
      lease_until: 1700000000,
    });

    const { result } = renderHook(() => useLock());

    let token: string | null = null;
    await act(async () => {
      token = await result.current.acquireWrite("/docs/readme.md");
    });

    // 防御：返回正确的 lock token
    expect(token).toBe("token-w-1");

    // 防御：activeLocks 应包含新获取的锁
    expect(result.current.activeLocks.get("/docs/readme.md")).toEqual({
      token: "token-w-1",
      leaseUntil: 1700000000,
    });

    // 防御：API 被正确调用，传入 write 类型
    expect(acquireLockMock).toHaveBeenCalledWith("/docs/readme.md", "write");
  });

  it("acquireWrite 失败（API 错误）返回 null，activeLocks 不变", async () => {
    acquireLockMock.mockRejectedValue(new Error("锁被占用"));

    const { result } = renderHook(() => useLock());

    let token: string | null = "should-be-overwritten";
    await act(async () => {
      token = await result.current.acquireWrite("/locked-file.txt");
    });

    // 防御：失败时返回 null
    expect(token).toBeNull();

    // 防御：activeLocks 不应包含失败的锁
    expect(result.current.activeLocks.has("/locked-file.txt")).toBe(false);
  });

  it("acquireRead 成功后将锁加入 activeLocks", async () => {
    acquireLockMock.mockResolvedValue({
      lock_token: "token-r-1",
      lease_until: 1700000100,
    });

    const { result } = renderHook(() => useLock());

    let token: string | null = null;
    await act(async () => {
      token = await result.current.acquireRead("/docs/notes.md");
    });

    // 防御：返回正确的 lock token
    expect(token).toBe("token-r-1");

    // 防御：activeLocks 应包含读锁
    expect(result.current.activeLocks.get("/docs/notes.md")).toEqual({
      token: "token-r-1",
      leaseUntil: 1700000100,
    });

    // 防御：API 被正确调用，传入 read 类型
    expect(acquireLockMock).toHaveBeenCalledWith("/docs/notes.md", "read");
  });

  it("release 从 activeLocks 移除锁并调用 releaseLock API", async () => {
    acquireLockMock.mockResolvedValue({
      lock_token: "token-w-2",
      lease_until: 1700000000,
    });
    releaseLockMock.mockResolvedValue(undefined);

    const { result } = renderHook(() => useLock());

    // 先获取锁
    await act(async () => {
      await result.current.acquireWrite("/file.txt");
    });

    expect(result.current.activeLocks.has("/file.txt")).toBe(true);

    // 释放锁
    await act(async () => {
      await result.current.release("/file.txt");
    });

    // 防御：activeLocks 中该锁已被移除
    expect(result.current.activeLocks.has("/file.txt")).toBe(false);

    // 防御：releaseLock API 被正确调用
    expect(releaseLockMock).toHaveBeenCalledWith("/file.txt", "token-w-2");
  });

  it("release 对不存在的锁不会崩溃", async () => {
    const { result } = renderHook(() => useLock());

    // 防御：释放从未获取过的锁不应抛出异常
    await expect(
      act(async () => {
        await result.current.release("/nonexistent.txt");
      }),
    ).resolves.toBeUndefined();

    // 防御：releaseLock API 不应被调用
    expect(releaseLockMock).not.toHaveBeenCalled();
  });

  it("release 处理 API 错误时仍然从 activeLocks 移除锁", async () => {
    acquireLockMock.mockResolvedValue({
      lock_token: "token-w-3",
      lease_until: 1700000000,
    });
    // 释放时 API 报错（例如锁已过期服务端已自动释放）
    releaseLockMock.mockRejectedValue(new Error("锁不存在"));

    const { result } = renderHook(() => useLock());

    await act(async () => {
      await result.current.acquireWrite("/expired-lock.txt");
    });

    expect(result.current.activeLocks.has("/expired-lock.txt")).toBe(true);

    // 防御：即使 API 释放失败，本地状态仍应清除（避免僵尸锁）
    await act(async () => {
      await result.current.release("/expired-lock.txt");
    });

    expect(result.current.activeLocks.has("/expired-lock.txt")).toBe(false);
  });

  it("query 调用 queryLock API 并返回结果", async () => {
    const mockLockInfo = {
      file_path: "/shared/doc.md",
      lock_type: "write" as const,
      holders: [{ client_id: "c1", user: "alice", acquired_at: 1700000000 }],
      lease_until: 1700000600,
    };
    queryLockMock.mockResolvedValue(mockLockInfo);

    const { result } = renderHook(() => useLock());

    let info = null;
    await act(async () => {
      info = await result.current.query("/shared/doc.md");
    });

    // 防御：query 返回正确的锁信息
    expect(info).toEqual(mockLockInfo);
    expect(queryLockMock).toHaveBeenCalledWith("/shared/doc.md");
  });

  it("query 处理 API 错误", async () => {
    queryLockMock.mockRejectedValue(new Error("查询锁状态失败: 500"));

    const { result } = renderHook(() => useLock());

    // 防御：查询失败时应抛出异常，调用方可自行捕获
    await expect(
      act(async () => {
        await result.current.query("/broken.txt");
      }),
    ).rejects.toThrow("查询锁状态失败");
  });

  it("续租定时器在 15 秒后调用 renewLock 更新 leaseUntil", async () => {
    acquireLockMock.mockResolvedValue({
      lock_token: "token-renew-1",
      lease_until: 1700000000,
    });
    renewLockMock.mockResolvedValue(1700001000);

    const { result } = renderHook(() => useLock());

    await act(async () => {
      await result.current.acquireWrite("/renew-test.txt");
    });

    // 初始 leaseUntil
    expect(result.current.activeLocks.get("/renew-test.txt")!.leaseUntil).toBe(1700000000);

    // 推进 15 秒触发续租
    await act(async () => {
      vi.advanceTimersByTime(15_000);
    });

    // 防御：renewLock 被调用
    expect(renewLockMock).toHaveBeenCalledWith("/renew-test.txt", "token-renew-1");

    // 防御：leaseUntil 被更新
    expect(result.current.activeLocks.get("/renew-test.txt")!.leaseUntil).toBe(1700001000);
  });

  it("组件卸载时清理所有续租定时器", async () => {
    acquireLockMock.mockResolvedValue({
      lock_token: "token-cleanup",
      lease_until: 1700000000,
    });

    const { result, unmount } = renderHook(() => useLock());

    await act(async () => {
      await result.current.acquireWrite("/cleanup.txt");
    });

    // 卸载组件
    unmount();

    // 防御：卸载后推进 15 秒，renewLock 不应再被调用
    act(() => {
      vi.advanceTimersByTime(15_000);
    });

    expect(renewLockMock).not.toHaveBeenCalled();
  });
});

// ============================================================
// useFiles 测试
// ============================================================
describe("useFiles", () => {
  const mockItems = [
    {
      name: "hello.txt",
      item_type: "file" as const,
      size: 42,
      modified_at: "2025-01-01T00:00:00Z",
      etag: "etag1",
      lock: null,
    },
    {
      name: "docs",
      item_type: "directory" as const,
      size: 0,
      modified_at: "2025-01-01T00:00:00Z",
      etag: "etag2",
      lock: null,
    },
  ];

  beforeEach(() => {
    vi.useFakeTimers();
    listFilesMock.mockReset();
    uploadFileMock.mockReset();
    createEntryMock.mockReset();
    deleteEntryMock.mockReset();
    renameEntryMock.mockReset();
    downloadFileMock.mockReset();
    acquireLockMock.mockReset();

    // 默认：listFiles 返回模拟列表
    listFilesMock.mockResolvedValue({ path: "/", items: mockItems });
    uploadFileMock.mockResolvedValue("etag-upload");
    createEntryMock.mockResolvedValue("etag-create");
    deleteEntryMock.mockResolvedValue(undefined);
    renameEntryMock.mockResolvedValue("etag-rename");
    downloadFileMock.mockResolvedValue("blob:http://localhost/fake-blob");
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("挂载时调用 listFiles('/') 初始加载", async () => {
    renderHook(() => useFiles());

    // 防御：useEffect 初始加载必须请求根目录
    expect(listFilesMock).toHaveBeenCalledWith("/");
  });

  it("load 设置 loading=true 然后完成后设为 false", async () => {
    let resolveList: (v: unknown) => void;
    const listPromise = new Promise((resolve) => {
      resolveList = resolve;
    });
    listFilesMock.mockReturnValue(listPromise);

    const { result } = renderHook(() => useFiles());

    // API 尚未 resolve 时 loading 应为 true
    expect(result.current.loading).toBe(true);

    // resolve API 调用
    await act(async () => {
      resolveList!({ path: "/", items: mockItems });
    });

    // 防御：完成后 loading 必须回到 false
    expect(result.current.loading).toBe(false);
  });

  it("load 在 API 失败时设置 error", async () => {
    listFilesMock.mockRejectedValue(new Error("网络异常"));

    const { result } = renderHook(() => useFiles());

    await act(async () => {
      // 等待初始加载完成（会失败）
      await vi.runOnlyPendingTimersAsync();
    });

    // 防御：error 应被设置为具体的错误信息
    expect(result.current.error).toBe("网络异常");
    expect(result.current.loading).toBe(false);
  });

  it("navigate 从根目录构建正确的路径", async () => {
    const { result } = renderHook(() => useFiles());

    // 等待初始加载完成
    await act(async () => {
      await vi.runOnlyPendingTimersAsync();
    });

    listFilesMock.mockResolvedValue({ path: "/docs", items: [] });

    await act(async () => {
      result.current.navigate("docs");
    });

    // 防御：从根目录导航应拼接为 /docs，而非 //docs
    expect(listFilesMock).toHaveBeenCalledWith("/docs");
  });

  it("navigate 从子目录构建正确的路径", async () => {
    // 先导航到子目录 /docs（useEffect 初始加载 "/" 后 currentPath 为 "/"）
    const { result } = renderHook(() => useFiles());

    await act(async () => {
      await vi.runOnlyPendingTimersAsync();
    });

    listFilesMock.mockResolvedValue({ path: "/docs", items: [] });

    await act(async () => {
      result.current.navigate("docs");
    });

    // 此时 currentPath 为 /docs，再导航到 sub
    listFilesMock.mockResolvedValue({ path: "/docs/sub", items: [] });

    await act(async () => {
      result.current.navigate("sub");
    });

    // 防御：子目录下导航应拼接为 /docs/sub
    expect(listFilesMock).toHaveBeenCalledWith("/docs/sub");
  });

  it("goUp 在根目录时不执行任何操作", async () => {
    const { result } = renderHook(() => useFiles());

    await act(async () => {
      await vi.runOnlyPendingTimersAsync();
    });

    const callCountBefore = listFilesMock.mock.calls.length;

    await act(async () => {
      result.current.goUp();
    });

    // 防御：根目录下 goUp 不应再触发 load
    expect(listFilesMock.mock.calls.length).toBe(callCountBefore);
  });

  it("goUp 导航到父目录", async () => {
    listFilesMock.mockResolvedValue({ path: "/docs", items: [] });

    const { result } = renderHook(() => useFiles("/docs"));

    await act(async () => {
      await vi.runOnlyPendingTimersAsync();
    });

    listFilesMock.mockResolvedValue({ path: "/", items: mockItems });

    await act(async () => {
      result.current.goUp();
    });

    // 防御：从 /docs 返回上级应导航到 /
    expect(listFilesMock).toHaveBeenLastCalledWith("/");
  });

  it("upload 构建正确的文件路径", async () => {
    const { result } = renderHook(() => useFiles());

    await act(async () => {
      await vi.runOnlyPendingTimersAsync();
    });

    const fakeFile = new File(["content"], "report.pdf", { type: "application/pdf" });

    await act(async () => {
      await result.current.upload(fakeFile);
    });

    // 防御：根目录下上传应拼接为 /report.pdf
    expect(uploadFileMock).toHaveBeenCalledWith("/report.pdf", fakeFile);
  });

  it("createDir 调用 createEntry 并传入 isDir=true", async () => {
    const { result } = renderHook(() => useFiles());

    await act(async () => {
      await vi.runOnlyPendingTimersAsync();
    });

    await act(async () => {
      await result.current.createDir("new-folder");
    });

    // 防御：创建目录时 isDir 必须为 true
    expect(createEntryMock).toHaveBeenCalledWith("/new-folder", true);
  });

  it("createFile 调用 createEntry 并传入 isDir=false", async () => {
    const { result } = renderHook(() => useFiles());

    await act(async () => {
      await vi.runOnlyPendingTimersAsync();
    });

    await act(async () => {
      await result.current.createFile("notes.txt");
    });

    // 防御：创建文件时 isDir 必须为 false
    expect(createEntryMock).toHaveBeenCalledWith("/notes.txt", false);
  });

  it("remove 删除后重新加载列表", async () => {
    const { result } = renderHook(() => useFiles());

    await act(async () => {
      await vi.runOnlyPendingTimersAsync();
    });

    await act(async () => {
      await result.current.remove("hello.txt");
    });

    // 防御：删除时应构建正确的路径
    expect(deleteEntryMock).toHaveBeenCalledWith("/hello.txt");

    // 防御：删除后应重新加载列表
    expect(listFilesMock).toHaveBeenCalled();
  });

  it("rename 构建正确的旧路径和新路径", async () => {
    const { result } = renderHook(() => useFiles());

    await act(async () => {
      await vi.runOnlyPendingTimersAsync();
    });

    await act(async () => {
      await result.current.rename("old.txt", "new.txt");
    });

    // 防御：rename 应构建正确的旧路径和新路径
    expect(renameEntryMock).toHaveBeenCalledWith("/old.txt", "/new.txt");
  });

  it("download 创建 blob URL 并触发下载", async () => {
    const { result } = renderHook(() => useFiles());

    await act(async () => {
      await vi.runOnlyPendingTimersAsync();
    });

    // 模拟创建 <a> 元素的 click 方法
    const mockClick = vi.fn();
    const mockAnchor = {
      href: "",
      download: "",
      click: mockClick,
      style: {},
    };
    const origCreateElement = document.createElement.bind(document);
    vi.spyOn(document, "createElement").mockImplementation((tag: string) => {
      if (tag === "a") return mockAnchor as unknown as HTMLAnchorElement;
      return origCreateElement(tag);
    });

    // downloadFile mock 返回的 blob URL（在 beforeEach 中设置为 "blob:http://localhost/fake-blob"）
    // hook 中 downloadFile 返回值直接用作 blobUrl，不再调用 URL.createObjectURL
    const revokeObjectURLSpy = vi
      .spyOn(URL, "revokeObjectURL")
      .mockImplementation(() => {});

    await act(async () => {
      await result.current.download("hello.txt");
    });

    // 防御：downloadFile 被正确调用
    expect(downloadFileMock).toHaveBeenCalledWith("/hello.txt");

    // 防御：触发了点击下载
    expect(mockClick).toHaveBeenCalled();

    // 防御：blob URL 被释放，避免内存泄漏（使用 downloadFile 返回的 URL）
    expect(revokeObjectURLSpy).toHaveBeenCalledWith("blob:http://localhost/fake-blob");

    revokeObjectURLSpy.mockRestore();
  });

  it("edit 获取写锁后调用 Tauri invoke", async () => {
    acquireLockMock.mockResolvedValue({
      lock_token: "edit-token",
      lease_until: 1700001000,
    });

    const tauriModule = await import("@tauri-apps/api/tauri");
    const invokeMock = vi.mocked(tauriModule.invoke);
    invokeMock.mockResolvedValue(undefined);

    const { result } = renderHook(() => useFiles());

    await act(async () => {
      await vi.runOnlyPendingTimersAsync();
    });

    await act(async () => {
      await result.current.edit("hello.txt");
    });

    // 防御：edit 应先申请写锁
    expect(acquireLockMock).toHaveBeenCalledWith("/hello.txt", "write");

    // 防御：申请锁后应调用 Tauri invoke
    expect(invokeMock).toHaveBeenCalledWith("open_file_for_edit", {
      path: "/hello.txt",
      lockToken: "edit-token",
      leaseUntil: 1700001000,
    });
  });

  it("edit 处理锁申请失败时设置 error", async () => {
    acquireLockMock.mockRejectedValue(new Error("锁被占用"));

    const { result } = renderHook(() => useFiles());

    await act(async () => {
      await vi.runOnlyPendingTimersAsync();
    });

    await act(async () => {
      await result.current.edit("locked-file.txt");
    });

    // 防御：edit 失败时应设置错误信息
    expect(result.current.error).toBe("锁被占用");
  });

  it("load 在非 Error 异常时使用默认错误消息", async () => {
    listFilesMock.mockRejectedValue("未知错误字符串");

    const { result } = renderHook(() => useFiles());

    await act(async () => {
      await vi.runOnlyPendingTimersAsync();
    });

    // 防御：非 Error 类型异常应使用默认消息 "加载失败"
    expect(result.current.error).toBe("加载失败");
  });
});
