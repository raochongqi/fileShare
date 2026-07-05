import { useState, useEffect, useCallback } from "react";
import {
  listFiles,
  uploadFile,
  createEntry,
  deleteEntry,
  renameEntry,
  downloadFile,
  acquireLock,
  type DirItem,
} from "../lib/api";

/** 文件列表 + CRUD 操作 */
export function useFiles(initialPath = "/") {
  const [currentPath, setCurrentPath] = useState(initialPath);
  const [items, setItems] = useState<DirItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 加载目录内容
  const load = useCallback(async (path?: string) => {
    const target = path ?? currentPath;
    setLoading(true);
    setError(null);
    try {
      const resp = await listFiles(target);
      setItems(resp.items);
      setCurrentPath(target);
    } catch (e) {
      setError(e instanceof Error ? e.message : "加载失败");
    } finally {
      setLoading(false);
    }
  }, [currentPath]);

  // 导航到子目录
  const navigate = useCallback((dirName: string) => {
    const newPath = currentPath === "/" ? `/${dirName}` : `${currentPath}/${dirName}`;
    load(newPath);
  }, [currentPath, load]);

  // 返回上级目录
  const goUp = useCallback(() => {
    if (currentPath === "/") return;
    const parent = currentPath.split("/").slice(0, -1).join("/") || "/";
    load(parent);
  }, [currentPath, load]);

  // 上传文件
  const upload = useCallback(async (file: File) => {
    const filePath = currentPath === "/" ? `/${file.name}` : `${currentPath}/${file.name}`;
    await uploadFile(filePath, file);
    await load();
  }, [currentPath, load]);

  // 新建目录
  const createDir = useCallback(async (name: string) => {
    const dirPath = currentPath === "/" ? `/${name}` : `${currentPath}/${name}`;
    await createEntry(dirPath, true);
    await load();
  }, [currentPath, load]);

  // 新建文件
  const createFile = useCallback(async (name: string) => {
    const filePath = currentPath === "/" ? `/${name}` : `${currentPath}/${name}`;
    await createEntry(filePath, false);
    await load();
  }, [currentPath, load]);

  // 删除
  const remove = useCallback(async (name: string) => {
    const itemPath = currentPath === "/" ? `/${name}` : `${currentPath}/${name}`;
    await deleteEntry(itemPath);
    await load();
  }, [currentPath, load]);

  // 重命名
  const rename = useCallback(async (oldName: string, newName: string) => {
    const oldPath = currentPath === "/" ? `/${oldName}` : `${currentPath}/${oldName}`;
    const newPath = currentPath === "/" ? `/${newName}` : `${currentPath}/${newName}`;
    await renameEntry(oldPath, newPath);
    await load();
  }, [currentPath, load]);

  // 下载文件
  const download = useCallback(async (name: string) => {
    const filePath = currentPath === "/" ? `/${name}` : `${currentPath}/${name}`;
    const blobUrl = await downloadFile(filePath);
    const a = document.createElement("a");
    a.href = blobUrl;
    a.download = name;
    a.click();
    URL.revokeObjectURL(blobUrl);
  }, [currentPath]);

  // 编辑文件（申请写锁 → 下载 → 打开）
  const edit = useCallback(async (name: string) => {
    const filePath = currentPath === "/" ? `/${name}` : `${currentPath}/${name}`;
    try {
      const lockResp = await acquireLock(filePath, "write");
      // 下载到临时目录 + 用系统默认程序打开，由 Tauri Rust 侧处理
      // MVP: 通过 Tauri invoke 调用
      const { invoke } = await import("@tauri-apps/api/tauri");
      await invoke("open_file_for_edit", {
        path: filePath,
        lockToken: lockResp.lock_token,
        leaseUntil: lockResp.lease_until,
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : "编辑失败");
    }
  }, [currentPath]);

  // 初始加载
  useEffect(() => {
    load("/");
  }, []);

  return {
    currentPath,
    items,
    loading,
    error,
    load,
    navigate,
    goUp,
    upload,
    createDir,
    createFile,
    remove,
    rename,
    download,
    edit,
  };
}
