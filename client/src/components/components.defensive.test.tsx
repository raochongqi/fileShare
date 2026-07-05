// React 组件防御性交互测试
// 聚焦用户交互回调触发、边界值输入、特殊字符渲染、事件冒泡控制等场景

import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FileList } from "../components/FileList";
import { LockStatus } from "../components/LockStatus";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { FileToolbar } from "../components/FileToolbar";
import type { DirItem } from "../lib/api";

// ---- 工具函数 ----

const baseItem = (overrides: Partial<DirItem> = {}): DirItem => ({
  name: "test.txt",
  item_type: "file",
  size: 1024,
  modified_at: "2026-07-04T10:00:00Z",
  etag: "v1",
  lock: null,
  ...overrides,
});

const noop = () => {};

// ============================================================
// FileList 防御性测试
// ============================================================
describe("FileList 防御性交互测试", () => {
  // ---- 回调触发 ----

  it("点击目录名触发 onNavigate 回调并传入正确的目录名", async () => {
    const onNavigate = vi.fn();
    const items = [baseItem({ name: "docs", item_type: "directory" })];
    render(
      <FileList
        items={items}
        loading={false}
        onNavigate={onNavigate}
        onDownload={noop}
        onEdit={noop}
        onDelete={noop}
        onRename={noop}
      />,
    );
    await userEvent.click(screen.getByText("docs"));
    expect(onNavigate).toHaveBeenCalledOnce();
    expect(onNavigate).toHaveBeenCalledWith("docs");
  });

  it("点击下载按钮触发 onDownload 并传入正确的文件名", async () => {
    const onDownload = vi.fn();
    const items = [baseItem({ name: "report.pdf" })];
    render(
      <FileList
        items={items}
        loading={false}
        onNavigate={noop}
        onDownload={onDownload}
        onEdit={noop}
        onDelete={noop}
        onRename={noop}
      />,
    );
    await userEvent.click(screen.getByTitle("下载"));
    expect(onDownload).toHaveBeenCalledOnce();
    expect(onDownload).toHaveBeenCalledWith("report.pdf");
  });

  it("点击编辑按钮触发 onEdit 并传入正确的文件名", async () => {
    const onEdit = vi.fn();
    const items = [baseItem({ name: "notes.md" })];
    render(
      <FileList
        items={items}
        loading={false}
        onNavigate={noop}
        onDownload={noop}
        onEdit={onEdit}
        onDelete={noop}
        onRename={noop}
      />,
    );
    await userEvent.click(screen.getByTitle("编辑"));
    expect(onEdit).toHaveBeenCalledOnce();
    expect(onEdit).toHaveBeenCalledWith("notes.md");
  });

  it("点击重命名按钮触发 onRename 并传入正确的文件名", async () => {
    const onRename = vi.fn();
    const items = [baseItem({ name: "old-name.txt" })];
    render(
      <FileList
        items={items}
        loading={false}
        onNavigate={noop}
        onDownload={noop}
        onEdit={noop}
        onDelete={noop}
        onRename={onRename}
      />,
    );
    await userEvent.click(screen.getByTitle("重命名"));
    expect(onRename).toHaveBeenCalledOnce();
    expect(onRename).toHaveBeenCalledWith("old-name.txt");
  });

  it("点击删除按钮触发 onDelete 并传入正确的文件名", async () => {
    const onDelete = vi.fn();
    const items = [baseItem({ name: "to-delete.log" })];
    render(
      <FileList
        items={items}
        loading={false}
        onNavigate={noop}
        onDownload={noop}
        onEdit={noop}
        onDelete={onDelete}
        onRename={noop}
      />,
    );
    await userEvent.click(screen.getByTitle("删除"));
    expect(onDelete).toHaveBeenCalledOnce();
    expect(onDelete).toHaveBeenCalledWith("to-delete.log");
  });

  // ---- 特殊文件名渲染 ----

  it("超长文件名（200+ 字符）渲染不崩溃", () => {
    const longName = "a".repeat(250) + ".txt";
    const items = [baseItem({ name: longName })];
    const { container } = render(
      <FileList
        items={items}
        loading={false}
        onNavigate={noop}
        onDownload={noop}
        onEdit={noop}
        onDelete={noop}
        onRename={noop}
      />,
    );
    // 验证表格行存在且包含该文件名文本
    expect(container.querySelector("tbody tr")).toBeInTheDocument();
    expect(screen.getByText(longName)).toBeInTheDocument();
  });

  it("包含特殊字符（emoji、中文、空格）的文件名能正确渲染", () => {
    const specialName = "🎉 项目 报告_v2 最终版.docx";
    const items = [baseItem({ name: specialName })];
    render(
      <FileList
        items={items}
        loading={false}
        onNavigate={noop}
        onDownload={noop}
        onEdit={noop}
        onDelete={noop}
        onRename={noop}
      />,
    );
    expect(screen.getByText(specialName)).toBeInTheDocument();
  });

  // ---- 锁状态混合场景 ----

  it("多个文件同类型锁均能正确渲染", () => {
    const items = [
      baseItem({
        name: "file1.txt",
        lock: { type: "write" as const, holder: "张三", expires_at: "2026-07-04T11:00:00Z" },
      }),
      baseItem({
        name: "file2.txt",
        lock: { type: "write" as const, holder: "李四", expires_at: "2026-07-04T11:00:00Z" },
      }),
    ];
    render(
      <FileList
        items={items}
        loading={false}
        onNavigate={noop}
        onDownload={noop}
        onEdit={noop}
        onDelete={noop}
        onRename={noop}
      />,
    );
    // 两个写锁徽章均出现
    const writeLocks = screen.getAllByText(/写锁/);
    expect(writeLocks).toHaveLength(2);
  });

  it("混合项：部分加锁、部分无锁，均正确渲染", () => {
    const items = [
      baseItem({
        name: "locked.txt",
        lock: { type: "read" as const, holder: "王五", expires_at: "2026-07-04T11:00:00Z" },
      }),
      baseItem({ name: "unlocked.txt", lock: null }),
    ];
    render(
      <FileList
        items={items}
        loading={false}
        onNavigate={noop}
        onDownload={noop}
        onEdit={noop}
        onDelete={noop}
        onRename={noop}
      />,
    );
    expect(screen.getByText(/读锁/)).toBeInTheDocument();
    // 无锁文件在锁状态列显示 "-"
    const dashes = screen.getAllByText("-");
    // 至少有一个来自无锁文件的锁状态列
    expect(dashes.length).toBeGreaterThanOrEqual(1);
  });

  // ---- 文件大小边界 ----

  it("文件大小恰好 1024 字节显示为 1 KB", () => {
    const items = [baseItem({ name: "exact.txt", size: 1024 })];
    render(
      <FileList
        items={items}
        loading={false}
        onNavigate={noop}
        onDownload={noop}
        onEdit={noop}
        onDelete={noop}
        onRename={noop}
      />,
    );
    // formatSize: 1024 / 1024 = 1, i=1 > 0 所以 toFixed(1) => "1.0 KB"
    expect(screen.getByText("1.0 KB")).toBeInTheDocument();
  });

  it("文件大小 1023 字节显示为 1023 B（不进位）", () => {
    const items = [baseItem({ name: "small.txt", size: 1023 })];
    render(
      <FileList
        items={items}
        loading={false}
        onNavigate={noop}
        onDownload={noop}
        onEdit={noop}
        onDelete={noop}
        onRename={noop}
      />,
    );
    expect(screen.getByText("1023 B")).toBeInTheDocument();
  });

  // ---- 日期格式化容错 ----

  it("无效日期字符串不会崩溃，渲染为 Invalid Date", () => {
    const invalidDate = "not-a-valid-date";
    const items = [baseItem({ name: "bad-date.txt", modified_at: invalidDate })];
    render(
      <FileList
        items={items}
        loading={false}
        onNavigate={noop}
        onDownload={noop}
        onEdit={noop}
        onDelete={noop}
        onRename={noop}
      />,
    );
    // new Date("not-a-valid-date") 不抛异常，而是返回 "Invalid Date"
    // formatDate 的 try 块中 toLocaleString 返回 "Invalid Date"，不会走到 catch
    expect(screen.getByText("Invalid Date")).toBeInTheDocument();
  });

  // ---- 文件/目录操作按钮区分 ----

  it("目录行没有下载和编辑按钮", () => {
    const items = [baseItem({ name: "folder", item_type: "directory" })];
    render(
      <FileList
        items={items}
        loading={false}
        onNavigate={noop}
        onDownload={noop}
        onEdit={noop}
        onDelete={noop}
        onRename={noop}
      />,
    );
    expect(screen.queryByTitle("下载")).not.toBeInTheDocument();
    expect(screen.queryByTitle("编辑")).not.toBeInTheDocument();
  });

  it("文件行没有 link-button（无导航能力）", () => {
    const items = [baseItem({ name: "doc.txt", item_type: "file" })];
    const { container } = render(
      <FileList
        items={items}
        loading={false}
        onNavigate={noop}
        onDownload={noop}
        onEdit={noop}
        onDelete={noop}
        onRename={noop}
      />,
    );
    expect(container.querySelector(".link-button")).toBeNull();
  });

  // ---- 状态优先级 ----

  it("loading 状态优先于空 items 展示", () => {
    render(
      <FileList
        items={[]}
        loading={true}
        onNavigate={noop}
        onDownload={noop}
        onEdit={noop}
        onDelete={noop}
        onRename={noop}
      />,
    );
    // 即使 items 为空，loading 时也应显示"加载中..."而非"目录为空"
    expect(screen.getByText("加载中...")).toBeInTheDocument();
    expect(screen.queryByText("目录为空")).not.toBeInTheDocument();
  });
});

// ============================================================
// LockStatus 防御性测试
// ============================================================
describe("LockStatus 防御性交互测试", () => {
  it("点击解锁按钮触发 onRelease 并传入正确的路径", async () => {
    const onRelease = vi.fn();
    const locks = new Map([
      ["/project/readme.md", { token: "tok-abc-12345678", leaseUntil: 1700000000000 }],
    ]);
    render(<LockStatus activeLocks={locks} onRelease={onRelease} />);
    await userEvent.click(screen.getByText("解锁"));
    expect(onRelease).toHaveBeenCalledOnce();
    expect(onRelease).toHaveBeenCalledWith("/project/readme.md");
  });

  it("多个锁各自拥有独立的解锁按钮", async () => {
    const onRelease = vi.fn();
    const locks = new Map([
      ["/a.txt", { token: "tok-1111-aaaaaaaa", leaseUntil: 1700000000000 }],
      ["/b.txt", { token: "tok-2222-bbbbbbbb", leaseUntil: 1700000000000 }],
      ["/c.txt", { token: "tok-3333-cccccccc", leaseUntil: 1700000000000 }],
    ]);
    render(<LockStatus activeLocks={locks} onRelease={onRelease} />);
    const buttons = screen.getAllByText("解锁");
    expect(buttons).toHaveLength(3);

    // 点击第二个解锁按钮，应传入 /b.txt
    await userEvent.click(buttons[1]);
    expect(onRelease).toHaveBeenCalledWith("/b.txt");
  });

  it("超长路径：通过 .pop() 截断显示最后一段文件名", () => {
    const longPath = "/very/deep/nested/directory/structure/that/goes/on/and/on/important_file.xlsx";
    const locks = new Map([
      [longPath, { token: "tok-long-12345678", leaseUntil: 1700000000000 }],
    ]);
    render(<LockStatus activeLocks={locks} onRelease={() => {}} />);
    // 显示的应是 pop() 后的文件名
    expect(screen.getByText("important_file.xlsx")).toBeInTheDocument();
    // 不应显示完整路径
    expect(screen.queryByText(longPath)).not.toBeInTheDocument();
  });

  it("单段路径 /file.txt 显示 file.txt", () => {
    const locks = new Map([
      ["/file.txt", { token: "tok-single-1234", leaseUntil: 1700000000000 }],
    ]);
    render(<LockStatus activeLocks={locks} onRelease={() => {}} />);
    expect(screen.getByText("file.txt")).toBeInTheDocument();
  });

  it("嵌套路径 /a/b/c.txt 显示 c.txt", () => {
    const locks = new Map([
      ["/a/b/c.txt", { token: "tok-nested-1234", leaseUntil: 1700000000000 }],
    ]);
    render(<LockStatus activeLocks={locks} onRelease={() => {}} />);
    expect(screen.getByText("c.txt")).toBeInTheDocument();
  });

  it("Token 信息在 title 属性中截断显示（前8位+省略号）", () => {
    const locks = new Map([
      ["/test.txt", { token: "abcdefgh12345678", leaseUntil: 1700000000000 }],
    ]);
    render(<LockStatus activeLocks={locks} onRelease={() => {}} />);
    const fileNameSpan = screen.getByText("test.txt");
    expect(fileNameSpan).toHaveAttribute("title", "Token: abcdefgh...");
  });
});

// ============================================================
// ConfirmDialog 防御性测试
// ============================================================
describe("ConfirmDialog 防御性交互测试", () => {
  it("点击确认按钮触发 onConfirm 回调", async () => {
    const onConfirm = vi.fn();
    render(
      <ConfirmDialog
        title="删除确认"
        message="确定删除此文件？"
        onConfirm={onConfirm}
        onCancel={noop}
      />,
    );
    await userEvent.click(screen.getByText("确认删除"));
    expect(onConfirm).toHaveBeenCalledOnce();
  });

  it("点击取消按钮触发 onCancel 回调", async () => {
    const onCancel = vi.fn();
    render(
      <ConfirmDialog
        title="删除确认"
        message="确定删除此文件？"
        onConfirm={noop}
        onCancel={onCancel}
      />,
    );
    await userEvent.click(screen.getByText("取消"));
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it("点击遮罩层（对话框外部）触发 onCancel", async () => {
    const onCancel = vi.fn();
    const { container } = render(
      <ConfirmDialog
        title="删除确认"
        message="确定删除此文件？"
        onConfirm={noop}
        onCancel={onCancel}
      />,
    );
    // 遮罩层是 .dialog-overlay
    const overlay = container.querySelector(".dialog-overlay");
    expect(overlay).toBeInTheDocument();
    await userEvent.click(overlay!);
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it("点击对话框内部不触发 onCancel（stopPropagation 阻止冒泡）", async () => {
    const onCancel = vi.fn();
    const { container } = render(
      <ConfirmDialog
        title="删除确认"
        message="确定删除此文件？"
        onConfirm={noop}
        onCancel={onCancel}
      />,
    );
    // 点击对话框主体区域（非按钮）
    const dialog = container.querySelector(".dialog");
    expect(dialog).toBeInTheDocument();
    await userEvent.click(dialog!);
    // onCancel 不应被触发，因为 stopPropagation 阻止了冒泡到 overlay
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("超长消息文本渲染不崩溃", () => {
    const longMessage = "这是一条很长的消息。".repeat(200);
    const { container } = render(
      <ConfirmDialog
        title="测试"
        message={longMessage}
        onConfirm={noop}
        onCancel={noop}
      />,
    );
    expect(container.querySelector(".dialog")).toBeInTheDocument();
    expect(screen.getByText(longMessage)).toBeInTheDocument();
  });

  it("空标题渲染不崩溃", () => {
    const { container } = render(
      <ConfirmDialog
        title=""
        message="消息内容"
        onConfirm={noop}
        onCancel={noop}
      />,
    );
    expect(container.querySelector(".dialog")).toBeInTheDocument();
    // h3 存在但内容为空
    const heading = container.querySelector("h3");
    expect(heading).toBeInTheDocument();
    expect(heading?.textContent).toBe("");
  });
});

// ============================================================
// FileToolbar 防御性测试
// ============================================================
describe("FileToolbar 防御性交互测试", () => {
  it("点击上传按钮触发 onUpload 回调", async () => {
    const onUpload = vi.fn();
    render(
      <FileToolbar
        currentPath="/"
        onGoUp={noop}
        onUpload={onUpload}
        onCreateDir={noop}
        onCreateFile={noop}
        onRefresh={noop}
      />,
    );
    await userEvent.click(screen.getByTitle("上传文件"));
    expect(onUpload).toHaveBeenCalledOnce();
  });

  it("点击新建目录按钮触发 onCreateDir 回调", async () => {
    const onCreateDir = vi.fn();
    render(
      <FileToolbar
        currentPath="/"
        onGoUp={noop}
        onUpload={noop}
        onCreateDir={onCreateDir}
        onCreateFile={noop}
        onRefresh={noop}
      />,
    );
    await userEvent.click(screen.getByTitle("新建目录"));
    expect(onCreateDir).toHaveBeenCalledOnce();
  });

  it("点击新建文件按钮触发 onCreateFile 回调", async () => {
    const onCreateFile = vi.fn();
    render(
      <FileToolbar
        currentPath="/"
        onGoUp={noop}
        onUpload={noop}
        onCreateDir={noop}
        onCreateFile={onCreateFile}
        onRefresh={noop}
      />,
    );
    await userEvent.click(screen.getByTitle("新建文件"));
    expect(onCreateFile).toHaveBeenCalledOnce();
  });

  it("点击刷新按钮触发 onRefresh 回调", async () => {
    const onRefresh = vi.fn();
    render(
      <FileToolbar
        currentPath="/"
        onGoUp={noop}
        onUpload={noop}
        onCreateDir={noop}
        onCreateFile={noop}
        onRefresh={onRefresh}
      />,
    );
    await userEvent.click(screen.getByTitle("刷新"));
    expect(onRefresh).toHaveBeenCalledOnce();
  });

  it("点击上级目录按钮触发 onGoUp 回调", async () => {
    const onGoUp = vi.fn();
    render(
      <FileToolbar
        currentPath="/docs"
        onGoUp={onGoUp}
        onUpload={noop}
        onCreateDir={noop}
        onCreateFile={noop}
        onRefresh={noop}
      />,
    );
    await userEvent.click(screen.getByTitle("上级目录"));
    expect(onGoUp).toHaveBeenCalledOnce();
  });

  it("深层嵌套路径显示所有面包屑部分", () => {
    render(
      <FileToolbar
        currentPath="/a/b/c/d"
        onGoUp={noop}
        onUpload={noop}
        onCreateDir={noop}
        onCreateFile={noop}
        onRefresh={noop}
      />,
    );
    expect(screen.getByText("a")).toBeInTheDocument();
    expect(screen.getByText("b")).toBeInTheDocument();
    expect(screen.getByText("c")).toBeInTheDocument();
    expect(screen.getByText("d")).toBeInTheDocument();
    // 每个 pathPart 前都有一个分隔符，4 段 = 4 个分隔符
    const seps = document.querySelectorAll(".breadcrumb-sep");
    expect(seps).toHaveLength(4);
  });

  it("根路径只显示「根目录」，无分隔符", () => {
    render(
      <FileToolbar
        currentPath="/"
        onGoUp={noop}
        onUpload={noop}
        onCreateDir={noop}
        onCreateFile={noop}
        onRefresh={noop}
      />,
    );
    expect(screen.getByText("根目录")).toBeInTheDocument();
    // 根路径下不应有分隔符
    const seps = document.querySelectorAll(".breadcrumb-sep");
    expect(seps).toHaveLength(0);
  });

  it("路径包含中文字符时面包屑正确显示", () => {
    render(
      <FileToolbar
        currentPath="/项目/文档/报告"
        onGoUp={noop}
        onUpload={noop}
        onCreateDir={noop}
        onCreateFile={noop}
        onRefresh={noop}
      />,
    );
    expect(screen.getByText("项目")).toBeInTheDocument();
    expect(screen.getByText("文档")).toBeInTheDocument();
    expect(screen.getByText("报告")).toBeInTheDocument();
  });
});
