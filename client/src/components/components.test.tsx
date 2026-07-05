// React 组件防御性测试

import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { FileList } from "../components/FileList";
import { LockStatus } from "../components/LockStatus";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { FileToolbar } from "../components/FileToolbar";
import type { DirItem } from "../lib/api";

describe("FileList", () => {
  const baseItem = (overrides: Partial<DirItem> = {}): DirItem => ({
    name: "test.txt",
    item_type: "file",
    size: 1024,
    modified_at: "2026-07-04T10:00:00Z",
    etag: "v1",
    lock: null,
    ...overrides,
  });

  it("显示加载状态", () => {
    render(<FileList items={[]} loading={true} onNavigate={() => {}} onDownload={() => {}} onEdit={() => {}} onDelete={() => {}} onRename={() => {}} />);
    expect(screen.getByText("加载中...")).toBeInTheDocument();
  });

  it("显示空目录提示", () => {
    render(<FileList items={[]} loading={false} onNavigate={() => {}} onDownload={() => {}} onEdit={() => {}} onDelete={() => {}} onRename={() => {}} />);
    expect(screen.getByText("目录为空")).toBeInTheDocument();
  });

  it("显示文件列表", () => {
    const items = [
      baseItem({ name: "report.docx", item_type: "file", size: 245760 }),
      baseItem({ name: "docs", item_type: "directory", size: 0 }),
    ];
    render(<FileList items={items} loading={false} onNavigate={() => {}} onDownload={() => {}} onEdit={() => {}} onDelete={() => {}} onRename={() => {}} />);
    expect(screen.getByText("report.docx")).toBeInTheDocument();
    expect(screen.getByText("docs")).toBeInTheDocument();
  });

  it("显示写锁状态", () => {
    const items = [
      baseItem({
        name: "locked.docx",
        lock: { type: "write" as const, holder: "张三", expires_at: "2026-07-04T11:00:00Z" },
      }),
    ];
    render(<FileList items={items} loading={false} onNavigate={() => {}} onDownload={() => {}} onEdit={() => {}} onDelete={() => {}} onRename={() => {}} />);
    expect(screen.getByText(/写锁/)).toBeInTheDocument();
    expect(screen.getByText(/张三/)).toBeInTheDocument();
  });

  it("显示读锁状态", () => {
    const items = [
      baseItem({
        name: "reading.pdf",
        lock: { type: "read" as const, holder: "李四", expires_at: "2026-07-04T11:00:00Z" },
      }),
    ];
    render(<FileList items={items} loading={false} onNavigate={() => {}} onDownload={() => {}} onEdit={() => {}} onDelete={() => {}} onRename={() => {}} />);
    expect(screen.getByText(/读锁/)).toBeInTheDocument();
  });

  it("文件有下载和编辑按钮，目录没有", () => {
    const items = [
      baseItem({ name: "file.txt", item_type: "file" }),
      baseItem({ name: "folder", item_type: "directory" }),
    ];
    render(<FileList items={items} loading={false} onNavigate={() => {}} onDownload={() => {}} onEdit={() => {}} onDelete={() => {}} onRename={() => {}} />);
    // 文件行应有下载和编辑按钮（title 属性）
    expect(screen.getAllByTitle("下载").length).toBe(1);
    expect(screen.getAllByTitle("编辑").length).toBe(1);
  });

  it("零字节文件显示大小为 -", () => {
    const items = [baseItem({ name: "empty.txt", size: 0 })];
    render(<FileList items={items} loading={false} onNavigate={() => {}} onDownload={() => {}} onEdit={() => {}} onDelete={() => {}} onRename={() => {}} />);
    // "-" 在大小列和锁状态列都出现，用 getAllByText
    const dashes = screen.getAllByText("-");
    expect(dashes.length).toBeGreaterThanOrEqual(1);
  });

  it("大文件显示 GB 单位", () => {
    const items = [baseItem({ name: "big.iso", size: 4_500_000_000 })];
    render(<FileList items={items} loading={false} onNavigate={() => {}} onDownload={() => {}} onEdit={() => {}} onDelete={() => {}} onRename={() => {}} />);
    expect(screen.getByText(/GB/)).toBeInTheDocument();
  });
});

describe("LockStatus", () => {
  it("无活跃锁时不渲染", () => {
    const { container } = render(
      <LockStatus activeLocks={new Map()} onRelease={() => {}} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("有活跃锁时显示文件名和解锁按钮", () => {
    const locks = new Map([
      ["/test.txt", { token: "tok-1", leaseUntil: 1700000000000 }],
      ["/docs/report.docx", { token: "tok-2", leaseUntil: 1700000000000 }],
    ]);
    render(<LockStatus activeLocks={locks} onRelease={() => {}} />);
    expect(screen.getByText("test.txt")).toBeInTheDocument();
    expect(screen.getByText("report.docx")).toBeInTheDocument();
    expect(screen.getAllByText("解锁").length).toBe(2);
  });
});

describe("ConfirmDialog", () => {
  it("显示标题和消息", () => {
    render(
      <ConfirmDialog title="确认删除" message="确定要删除吗？" onConfirm={() => {}} onCancel={() => {}} />,
    );
    // 标题在 h3 中，确认按钮文字也是 "确认删除"，用 heading 定位
    expect(screen.getByRole("heading", { name: "确认删除" })).toBeInTheDocument();
    expect(screen.getByText("确定要删除吗？")).toBeInTheDocument();
  });

  it("有取消和确认按钮", () => {
    render(
      <ConfirmDialog title="test" message="msg" onConfirm={() => {}} onCancel={() => {}} />,
    );
    expect(screen.getByText("取消")).toBeInTheDocument();
    expect(screen.getByText("确认删除")).toBeInTheDocument();
  });
});

describe("FileToolbar", () => {
  it("在根目录时上级目录按钮禁用", () => {
    render(
      <FileToolbar currentPath="/" onGoUp={() => {}} onUpload={() => {}} onCreateDir={() => {}} onCreateFile={() => {}} onRefresh={() => {}} />,
    );
    expect(screen.getByTitle("上级目录")).toBeDisabled();
  });

  it("在子目录时上级目录按钮启用", () => {
    render(
      <FileToolbar currentPath="/docs" onGoUp={() => {}} onUpload={() => {}} onCreateDir={() => {}} onCreateFile={() => {}} onRefresh={() => {}} />,
    );
    expect(screen.getByTitle("上级目录")).not.toBeDisabled();
  });

  it("显示当前路径面包屑", () => {
    render(
      <FileToolbar currentPath="/docs/reports" onGoUp={() => {}} onUpload={() => {}} onCreateDir={() => {}} onCreateFile={() => {}} onRefresh={() => {}} />,
    );
    expect(screen.getByText("docs")).toBeInTheDocument();
    expect(screen.getByText("reports")).toBeInTheDocument();
  });
});
