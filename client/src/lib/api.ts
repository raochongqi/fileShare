// 服务端 API 封装层

const SERVER_URL = import.meta.env.VITE_SERVER_URL || "http://localhost:8080";
const AUTH_TOKEN = import.meta.env.VITE_AUTH_TOKEN || "change-me";

function headers(extra?: Record<string, string>): HeadersInit {
  return {
    Authorization: `Bearer ${AUTH_TOKEN}`,
    ...extra,
  };
}

// ---- 类型定义 ----

export interface DirItem {
  name: string;
  type: "file" | "directory";
  size: number;
  modified_at: string;
  etag: string;
  lock: LockData | null;
}

export interface LockData {
  type: "read" | "write";
  holder: string;
  expires_at: string;
}

export interface FileListResponse {
  path: string;
  items: DirItem[];
}

export interface FileMeta {
  path: string;
  is_dir: boolean;
  size: number;
  modified_at: string;
  created_at: string;
  etag: string;
  mime_type: string | null;
  lock: LockData | null;
}

export interface LockAcquireResponse {
  lock_token: string;
  lease_until: number;
}

export interface LockInfo {
  file_path: string;
  lock_type: "read" | "write";
  holders: { client_id: string; user: string; acquired_at: number }[];
  lease_until: number;
}

// ---- API 函数 ----

/** 目录浏览 */
export async function listFiles(path = "/"): Promise<FileListResponse> {
  const resp = await fetch(`${SERVER_URL}/api/files?path=${encodeURIComponent(path)}`, {
    headers: headers(),
  });
  if (!resp.ok) throw new Error(`列出目录失败: ${resp.status}`);
  return resp.json();
}

/** 文件下载（返回 Blob URL） */
export async function downloadFile(path: string): Promise<string> {
  const resp = await fetch(`${SERVER_URL}/api/files/content?path=${encodeURIComponent(path)}`, {
    headers: headers(),
  });
  if (!resp.ok) throw new Error(`下载文件失败: ${resp.status}`);
  const blob = await resp.blob();
  return URL.createObjectURL(blob);
}

/** 文件下载（返回 ArrayBuffer） */
export async function downloadFileBuffer(path: string): Promise<ArrayBuffer> {
  const resp = await fetch(`${SERVER_URL}/api/files/content?path=${encodeURIComponent(path)}`, {
    headers: headers(),
  });
  if (!resp.ok) throw new Error(`下载文件失败: ${resp.status}`);
  return resp.arrayBuffer();
}

/** 文件上传 */
export async function uploadFile(path: string, file: File): Promise<string> {
  const formData = new FormData();
  formData.append("file", file);

  const resp = await fetch(`${SERVER_URL}/api/files/content?path=${encodeURIComponent(path)}`, {
    method: "PUT",
    headers: headers(),
    body: formData,
  });
  if (!resp.ok) throw new Error(`上传文件失败: ${resp.status}`);
  const data = await resp.json();
  return data.etag;
}

/** 新建文件/目录 */
export async function createEntry(path: string, isDir: boolean): Promise<string> {
  const resp = await fetch(
    `${SERVER_URL}/api/files?path=${encodeURIComponent(path)}&is_dir=${isDir}`,
    {
      method: "POST",
      headers: headers(),
    },
  );
  if (!resp.ok) throw new Error(`创建失败: ${resp.status}`);
  const data = await resp.json();
  return data.etag;
}

/** 删除文件/目录 */
export async function deleteEntry(path: string): Promise<void> {
  const resp = await fetch(`${SERVER_URL}/api/files?path=${encodeURIComponent(path)}`, {
    method: "DELETE",
    headers: headers(),
  });
  if (!resp.ok) throw new Error(`删除失败: ${resp.status}`);
}

/** 重命名/移动 */
export async function renameEntry(oldPath: string, newPath: string): Promise<string> {
  const resp = await fetch(`${SERVER_URL}/api/files?path=${encodeURIComponent(oldPath)}`, {
    method: "PATCH",
    headers: { ...headers(), "Content-Type": "application/json" },
    body: JSON.stringify({ new_path: newPath }),
  });
  if (!resp.ok) throw new Error(`重命名失败: ${resp.status}`);
  const data = await resp.json();
  return data.etag;
}

/** 文件详细元数据 */
export async function getFileInfo(path: string): Promise<FileMeta> {
  const resp = await fetch(`${SERVER_URL}/api/files/info?path=${encodeURIComponent(path)}`, {
    headers: headers(),
  });
  if (!resp.ok) throw new Error(`获取文件信息失败: ${resp.status}`);
  return resp.json();
}

/** 搜索文件 */
export async function searchFiles(query: string): Promise<FileListResponse> {
  const resp = await fetch(`${SERVER_URL}/api/files/search?q=${encodeURIComponent(query)}`, {
    headers: headers(),
  });
  if (!resp.ok) throw new Error(`搜索失败: ${resp.status}`);
  return resp.json();
}

/** 申请锁 */
export async function acquireLock(
  path: string,
  lockType: "read" | "write",
): Promise<LockAcquireResponse> {
  const resp = await fetch(`${SERVER_URL}/api/files/lock`, {
    method: "POST",
    headers: { ...headers(), "Content-Type": "application/json" },
    body: JSON.stringify({ type: lockType, path }),
  });
  if (!resp.ok) throw new Error(`申请锁失败: ${resp.status}`);
  return resp.json();
}

/** 续租 */
export async function renewLock(path: string, lockToken: string): Promise<number> {
  const resp = await fetch(`${SERVER_URL}/api/files/lock/lease`, {
    method: "PUT",
    headers: { ...headers(), "X-Lock-Token": lockToken, "Content-Type": "application/json" },
    body: JSON.stringify({ path }),
  });
  if (!resp.ok) throw new Error(`续租失败: ${resp.status}`);
  const data = await resp.json();
  return data.lease_until;
}

/** 释放锁 */
export async function releaseLock(path: string, lockToken: string): Promise<void> {
  const resp = await fetch(`${SERVER_URL}/api/files/lock?path=${encodeURIComponent(path)}`, {
    method: "DELETE",
    headers: { ...headers(), "X-Lock-Token": lockToken },
  });
  if (!resp.ok) throw new Error(`释放锁失败: ${resp.status}`);
}

/** 查询锁状态 */
export async function queryLock(path: string): Promise<LockInfo | null> {
  const resp = await fetch(`${SERVER_URL}/api/files/lock?path=${encodeURIComponent(path)}`, {
    headers: headers(),
  });
  if (!resp.ok) throw new Error(`查询锁状态失败: ${resp.status}`);
  return resp.json();
}

/** SSE 事件流 */
export function createEventSource(): EventSource {
  return new EventSource(`${SERVER_URL}/api/events`);
}
