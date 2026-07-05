import type { DirItem } from "../lib/api";

interface FileListProps {
  items: DirItem[];
  loading: boolean;
  onNavigate: (dirName: string) => void;
  onDownload: (name: string) => void;
  onEdit: (name: string) => void;
  onDelete: (name: string) => void;
  onRename: (name: string) => void;
}

function formatSize(bytes: number): string {
  if (bytes === 0) return "-";
  const units = ["B", "KB", "MB", "GB"];
  let i = 0;
  let size = bytes;
  while (size >= 1024 && i < units.length - 1) {
    size /= 1024;
    i++;
  }
  return `${size.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleString("zh-CN");
  } catch {
    return iso;
  }
}

export function FileList({
  items,
  loading,
  onNavigate,
  onDownload,
  onEdit,
  onDelete,
  onRename,
}: FileListProps) {
  if (loading) {
    return <div className="file-list-loading">加载中...</div>;
  }

  if (items.length === 0) {
    return <div className="file-list-empty">目录为空</div>;
  }

  return (
    <table className="file-list">
      <thead>
        <tr>
          <th>名称</th>
          <th>大小</th>
          <th>修改时间</th>
          <th>锁状态</th>
          <th>操作</th>
        </tr>
      </thead>
      <tbody>
        {items.map((item) => (
          <tr key={item.name} className={item.item_type}>
            <td className="file-name">
              <span className={`file-icon ${item.item_type}`}>
                {item.item_type === "directory" ? "📁" : "📄"}
              </span>
              {item.item_type === "directory" ? (
                <button
                  className="link-button"
                  onClick={() => onNavigate(item.name)}
                >
                  {item.name}
                </button>
              ) : (
                <span>{item.name}</span>
              )}
            </td>
            <td>{formatSize(item.size)}</td>
            <td>{formatDate(item.modified_at)}</td>
            <td>
              {item.lock ? (
                <span className={`lock-badge lock-${item.lock.type}`}>
                  {item.lock.type === "write" ? "写锁" : "读锁"} ({item.lock.holder})
                </span>
              ) : (
                <span className="lock-badge lock-none">-</span>
              )}
            </td>
            <td className="file-actions">
              {item.item_type === "file" && (
                <>
                  <button onClick={() => onDownload(item.name)} title="下载">
                    ⬇
                  </button>
                  <button onClick={() => onEdit(item.name)} title="编辑">
                    ✏
                  </button>
                </>
              )}
              <button onClick={() => onRename(item.name)} title="重命名">
                ↗
              </button>
              <button onClick={() => onDelete(item.name)} title="删除" className="btn-danger">
                ✕
              </button>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
