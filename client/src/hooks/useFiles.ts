import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import {
  listFiles,
  uploadFile,
  createEntry,
  deleteEntry,
  renameEntry,
  downloadFile,
  acquireLock,
  searchFiles,
  type DirItem,
} from "../lib/api";

/** 文件列表 + CRUD 操作 */
export function useFiles(initialPath = "/") {
  const [currentPath, setCurrentPath] = useState(initialPath);
  const [items, setItems] = useState<DirItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 排序与搜索状态
  const [sortField, setSortField] = useState<"name" | "size" | "modified_at">("name");
  const [sortAsc, setSortAsc] = useState(true);
  const [searchQuery, setSearchQuery] = useState("");
  const [isSearching, setIsSearching] = useState(false);
  const [uploadingFiles, setUploadingFiles] = useState<string[]>([]);
  const [uploadProgress, setUploadProgress] = useState(0);

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

  // 排序后的列表（目录始终在文件之前，组内按指定字段排序）
  const sortedItems = useMemo(() => {
    const dirs = items.filter((i) => i.item_type === "directory");
    const files = items.filter((i) => i.item_type === "file");

    const sortFn = (a: DirItem, b: DirItem) => {
      let cmp = 0;
      if (sortField === "name") {
        cmp = a.name.localeCompare(b.name);
      } else if (sortField === "size") {
        cmp = a.size - b.size;
      } else {
        cmp = new Date(a.modified_at).getTime() - new Date(b.modified_at).getTime();
      }
      return sortAsc ? cmp : -cmp;
    };

    return [...dirs.sort(sortFn), ...files.sort(sortFn)];
  }, [items, sortField, sortAsc]);

  // 切换排序字段/方向
  const toggleSort = useCallback((field: "name" | "size" | "modified_at") => {
    if (sortField === field) {
      setSortAsc((prev) => !prev);
    } else {
      setSortField(field);
      setSortAsc(true);
    }
  }, [sortField]);

  // 防抖搜索
  const searchTimerRef = useRef<number | null>(null);

  useEffect(() => {
    if (searchQuery.trim() === "") {
      setIsSearching(false);
      load(); // 恢复正常目录列表
      return;
    }

    if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    searchTimerRef.current = window.setTimeout(async () => {
      setIsSearching(true);
      setLoading(true);
      setError(null);
      try {
        const resp = await searchFiles(searchQuery);
        setItems(resp.items);
      } catch (e) {
        setError(e instanceof Error ? e.message : "搜索失败");
      } finally {
        setLoading(false);
      }
    }, 300);
  }, [searchQuery]);

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

  // 上传文件（带模拟进度）
  const upload = useCallback(async (file: File) => {
    const filePath = currentPath === "/" ? `/${file.name}` : `${currentPath}/${file.name}`;
    setUploadingFiles([file.name]);
    setUploadProgress(0);
    try {
      // 模拟进度：0% → 50% → 实际上传 → 100%
      setUploadProgress(0);
      await new Promise((r) => setTimeout(r, 200));
      setUploadProgress(50);
      await uploadFile(filePath, file);
      setUploadProgress(100);
      await load();
    } finally {
      // 上传完成后清理状态
      setTimeout(() => {
        setUploadingFiles([]);
        setUploadProgress(0);
      }, 500);
    }
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

  // 导航到绝对路径
  const navigateTo = useCallback((path: string) => {
    load(path);
  }, [load]);

  // 初始加载
  useEffect(() => {
    load("/");
  }, []);

  return {
    currentPath,
    items,
    sortedItems,
    loading,
    error,
    load,
    navigate,
    navigateTo,
    goUp,
    upload,
    createDir,
    createFile,
    remove,
    rename,
    download,
    edit,
    sortField,
    sortAsc,
    toggleSort,
    searchQuery,
    setSearchQuery,
    isSearching,
    uploadingFiles,
    uploadProgress,
  };
}
