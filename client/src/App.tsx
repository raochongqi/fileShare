import { useState, useCallback, useEffect } from "react";
import { useFiles } from "./hooks/useFiles";
import { useLock } from "./hooks/useLock";
import { useSSE, type FileEvent } from "./hooks/useSSE";
import { useSelection } from "./hooks/useSelection";
import { useDragUpload } from "./hooks/useDragUpload";
import { FileList } from "./components/FileList";
import { FileToolbar } from "./components/FileToolbar";
import { LockStatus } from "./components/LockStatus";
import { ConfirmDialog } from "./components/ConfirmDialog";
import ContextMenu, { type MenuEntry } from "./components/ContextMenu";
import DragOverlay from "./components/DragOverlay";
import { uploadFile } from "./lib/api";
import type { DirItem } from "./lib/api";

export default function App() {
  const fileOps = useFiles();
  const lockOps = useLock();
  const { selectedNames, selectedCount, isSelected, select, selectAll, clearSelection } =
    useSelection();

  // 确认弹窗状态
  const [dialog, setDialog] = useState<{
    title: string;
    message: string;
    onConfirm: () => void;
  } | null>(null);

  // 右键菜单状态
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    items: MenuEntry[];
  } | null>(null);

  // SSE 事件：收到文件变更时刷新目录
  useSSE((event: FileEvent) => {
    if (event.type !== "lock_changed") {
      fileOps.load();
    }
  });

  // ── 操作回调（需在 handleContextMenu 之前定义） ──────────────────────

  // 上传文件（通过文件选择器）
  const handleUpload = useCallback(() => {
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = true;
    input.onchange = async () => {
      if (!input.files) return;
      for (const file of Array.from(input.files)) {
        try {
          await fileOps.upload(file);
        } catch (e) {
          alert(`上传 ${file.name} 失败: ${e}`);
        }
      }
    };
    input.click();
  }, [fileOps]);

  // 新建目录
  const handleCreateDir = useCallback(() => {
    const name = prompt("目录名称:");
    if (!name) return;
    fileOps.createDir(name).catch((e) => alert(`创建目录失败: ${e}`));
  }, [fileOps]);

  // 新建文件
  const handleCreateFile = useCallback(() => {
    const name = prompt("文件名称:");
    if (!name) return;
    fileOps.createFile(name).catch((e) => alert(`创建文件失败: ${e}`));
  }, [fileOps]);

  // 删除确认（单个文件/目录）
  const handleDelete = useCallback(
    (name: string) => {
      setDialog({
        title: "确认删除",
        message: `确定要删除 "${name}" 吗？此操作不可撤销。`,
        onConfirm: () => {
          fileOps.remove(name).catch((e) => alert(`删除失败: ${e}`));
          setDialog(null);
        },
      });
    },
    [fileOps],
  );

  // 重命名
  const handleRename = useCallback(
    (oldName: string) => {
      const newName = prompt(`重命名 "${oldName}" 为:`, oldName);
      if (!newName || newName === oldName) return;
      fileOps.rename(oldName, newName).catch((e) => alert(`重命名失败: ${e}`));
    },
    [fileOps],
  );

  // 编辑文件（申请写锁 → 下载并打开）
  const handleEdit = useCallback(
    async (name: string) => {
      const token = await lockOps.acquireWrite(
        fileOps.currentPath === "/" ? `/${name}` : `${fileOps.currentPath}/${name}`,
      );
      if (!token) {
        alert("无法获取写锁，文件可能正在被其他人编辑");
        return;
      }
      await fileOps.edit(name);
    },
    [fileOps, lockOps],
  );

  // ── 拖拽上传 ────────────────────────────────────────────────────────

  // 拖拽上传的 drop 回调：将文件上传到当前目录或指定子目录
  const handleDragDrop = useCallback(
    async (files: File[], targetDir: string | null) => {
      for (const file of files) {
        try {
          if (targetDir) {
            // 上传到子目录
            const dirPath =
              fileOps.currentPath === "/"
                ? `/${targetDir}`
                : `${fileOps.currentPath}/${targetDir}`;
            const filePath = `${dirPath}/${file.name}`;
            await uploadFile(filePath, file);
          } else {
            await fileOps.upload(file);
          }
        } catch (e) {
          alert(`上传 ${file.name} 失败: ${e}`);
        }
      }
      fileOps.load();
    },
    [fileOps],
  );

  const dragUpload = useDragUpload({ onDrop: handleDragDrop });

  // ── 右键菜单 ────────────────────────────────────────────────────────

  const handleContextMenu = useCallback(
    (e: React.MouseEvent, item: DirItem | null) => {
      e.preventDefault();

      if (item === null) {
        // 空白区域右键
        setContextMenu({
          x: e.clientX,
          y: e.clientY,
          items: [
            { label: "新建文件", icon: "create-file", onClick: handleCreateFile },
            { label: "新建目录", icon: "create-dir", onClick: handleCreateDir },
            { type: "separator" },
            { label: "上传文件", icon: "upload", onClick: handleUpload },
            { type: "separator" },
            { label: "刷新", icon: "refresh", onClick: () => fileOps.load() },
          ],
        });
      } else if (selectedCount > 1 && isSelected(item.name)) {
        // 多选右键
        const names = Array.from(selectedNames);
        setContextMenu({
          x: e.clientX,
          y: e.clientY,
          items: [
            {
              label: `下载 ${selectedCount} 个文件`,
              icon: "download",
              onClick: () => {
                for (const name of names) {
                  fileOps.download(name);
                }
              },
            },
            { type: "separator" },
            {
              label: `删除 ${selectedCount} 个文件`,
              icon: "delete",
              danger: true,
              onClick: () => {
                setDialog({
                  title: "确认批量删除",
                  message: `确定要删除选中的 ${selectedCount} 个项目吗？此操作不可撤销。`,
                  onConfirm: () => {
                    for (const name of names) {
                      fileOps.remove(name).catch((e) => alert(`删除 ${name} 失败: ${e}`));
                    }
                    clearSelection();
                    setDialog(null);
                  },
                });
              },
            },
          ],
        });
      } else if (item.item_type === "file") {
        // 文件右键：先单独选中此项
        clearSelection();
        select(item.name, false, false, fileOps.sortedItems);
        setContextMenu({
          x: e.clientX,
          y: e.clientY,
          items: [
            { label: "下载", icon: "download", onClick: () => fileOps.download(item.name) },
            { label: "编辑", icon: "edit", onClick: () => handleEdit(item.name) },
            { type: "separator" },
            { label: "重命名", icon: "rename", onClick: () => handleRename(item.name) },
            { label: "删除", icon: "delete", danger: true, onClick: () => handleDelete(item.name) },
          ],
        });
      } else {
        // 目录右键：先单独选中此项
        clearSelection();
        select(item.name, false, false, fileOps.sortedItems);
        setContextMenu({
          x: e.clientX,
          y: e.clientY,
          items: [
            { label: "打开", icon: "open", onClick: () => fileOps.navigate(item.name) },
            { type: "separator" },
            { label: "重命名", icon: "rename", onClick: () => handleRename(item.name) },
            { label: "删除", icon: "delete", danger: true, onClick: () => handleDelete(item.name) },
          ],
        });
      }
    },
    [
      handleCreateFile,
      handleCreateDir,
      handleUpload,
      handleEdit,
      handleRename,
      handleDelete,
      fileOps,
      selectedCount,
      isSelected,
      selectedNames,
      select,
      clearSelection,
    ],
  );

  // ── 键盘快捷键 ──────────────────────────────────────────────────────

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Ctrl+A 全选
      if ((e.ctrlKey || e.metaKey) && e.key === "a") {
        e.preventDefault();
        fileOps.sortedItems && selectAll(fileOps.sortedItems);
      }
      // Escape 清除选中 / 关闭右键菜单
      if (e.key === "Escape") {
        clearSelection();
        setContextMenu(null);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [selectAll, clearSelection, fileOps.sortedItems]);

  // ── 渲染 ─────────────────────────────────────────────────────────────

  return (
    <div className="app" onContextMenu={(e) => e.preventDefault()}>
      <header className="app-header">
        <h1>FileShare</h1>
        <LockStatus activeLocks={lockOps.activeLocks} onRelease={lockOps.release} />
      </header>

      <main className="app-main">
        <FileToolbar
          currentPath={fileOps.currentPath}
          onNavigateTo={fileOps.navigateTo}
          onGoUp={fileOps.goUp}
          onUpload={handleUpload}
          onCreateDir={handleCreateDir}
          onCreateFile={handleCreateFile}
          onRefresh={() => fileOps.load()}
          searchQuery={fileOps.searchQuery}
          onSearchChange={fileOps.setSearchQuery}
          uploadingFiles={fileOps.uploadingFiles}
          uploadProgress={fileOps.uploadProgress}
          onselectAll={() => selectAll(fileOps.sortedItems)}
        />

        {fileOps.error && <div className="error-banner">{fileOps.error}</div>}

        <FileList
          items={fileOps.sortedItems}
          loading={fileOps.loading}
          selectedNames={selectedNames}
          sortField={fileOps.sortField}
          sortAsc={fileOps.sortAsc}
          onSort={fileOps.toggleSort}
          onNavigate={fileOps.navigate}
          onEdit={(name) => handleEdit(name)}
          onContextMenu={handleContextMenu}
          onSelect={(name, ctrl, shift) => select(name, ctrl, shift, fileOps.sortedItems)}
          onDragOverDir={dragUpload.setTargetDir}
        />
      </main>

      {dialog && (
        <ConfirmDialog
          title={dialog.title}
          message={dialog.message}
          onConfirm={dialog.onConfirm}
          onCancel={() => setDialog(null)}
        />
      )}

      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          items={contextMenu.items}
          onClose={() => setContextMenu(null)}
        />
      )}

      <DragOverlay visible={dragUpload.isDragging} targetDir={dragUpload.targetDir} />
    </div>
  );
}
