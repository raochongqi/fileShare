import { useState, useCallback } from "react";
import { useFiles } from "./hooks/useFiles";
import { useLock } from "./hooks/useLock";
import { useSSE, type FileEvent } from "./hooks/useSSE";
import { FileList } from "./components/FileList";
import { FileToolbar } from "./components/FileToolbar";
import { LockStatus } from "./components/LockStatus";
import { ConfirmDialog } from "./components/ConfirmDialog";

export default function App() {
  const fileOps = useFiles();
  const lockOps = useLock();
  const [dialog, setDialog] = useState<{
    title: string;
    message: string;
    onConfirm: () => void;
  } | null>(null);

  // SSE 事件：收到文件变更时刷新目录
  useSSE((event: FileEvent) => {
    if (event.type !== "lock_changed") {
      fileOps.load();
    }
  });

  // 上传文件
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

  // 删除确认
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

  // 编辑文件
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

  return (
    <div className="app">
      <header className="app-header">
        <h1>FileShare</h1>
        <LockStatus activeLocks={lockOps.activeLocks} onRelease={lockOps.release} />
      </header>

      <main className="app-main">
        <FileToolbar
          currentPath={fileOps.currentPath}
          onGoUp={fileOps.goUp}
          onUpload={handleUpload}
          onCreateDir={handleCreateDir}
          onCreateFile={handleCreateFile}
          onRefresh={() => fileOps.load()}
        />

        {fileOps.error && <div className="error-banner">{fileOps.error}</div>}

        <FileList
          items={fileOps.items}
          loading={fileOps.loading}
          onNavigate={fileOps.navigate}
          onDownload={fileOps.download}
          onEdit={handleEdit}
          onDelete={handleDelete}
          onRename={handleRename}
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
    </div>
  );
}
