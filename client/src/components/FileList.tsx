/**
 * 文件列表组件
 *
 * 以表格形式展示目录内容，支持排序、多选、右键菜单、拖拽上传到目录。
 * 所有状态由父组件通过 props 传入，组件本身不维护选中/排序状态。
 */

import type { DirItem } from "../lib/api";
import { getFileIconClass, FILE_ICONS } from "../lib/fileIcons";

// ─── Props 类型定义 ──────────────────────────────────────────────────

interface FileListProps {
  items: DirItem[];
  loading: boolean;
  /** 当前选中的文件/目录名集合 */
  selectedNames: Set<string>;
  /** 排序字段 */
  sortField: "name" | "size" | "modified_at";
  /** 是否升序 */
  sortAsc: boolean;
  /** 点击列头排序回调 */
  onSort: (field: "name" | "size" | "modified_at") => void;
  /** 双击目录时导航 */
  onNavigate: (dirName: string) => void;
  /** 双击文件时编辑 */
  onEdit: (name: string) => void;
  /** 右键菜单回调，item 为 null 表示在空白区域触发 */
  onContextMenu: (e: React.MouseEvent, item: DirItem | null) => void;
  /** 行点击选中回调 */
  onSelect: (name: string, ctrlKey: boolean, shiftKey: boolean) => void;
  /** 拖拽文件到目录上时的回调，dirName 为 null 表示离开目录行 */
  onDragOverDir: (dirName: string | null) => void;
}

// ─── 辅助函数 ────────────────────────────────────────────────────────

/** 格式化文件大小 */
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

/** 格式化 ISO 日期为本地可读字符串 */
function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleString("zh-CN");
  } catch {
    return iso;
  }
}

// ─── 排序指示器 ──────────────────────────────────────────────────────

/** 根据当前排序状态渲染列头排序箭头 */
function SortIndicator({
  field,
  sortField,
  sortAsc,
}: {
  field: "name" | "size" | "modified_at";
  sortField: "name" | "size" | "modified_at";
  sortAsc: boolean;
}) {
  if (field !== sortField) return null;
  return <span className="sort-arrow">{sortAsc ? " ▲" : " ▼"}</span>;
}

// ─── 主组件 ──────────────────────────────────────────────────────────

export function FileList({
  items,
  loading,
  selectedNames,
  sortField,
  sortAsc,
  onSort,
  onNavigate,
  onEdit,
  onContextMenu,
  onSelect,
  onDragOverDir,
}: FileListProps) {
  /* 加载中状态 */
  if (loading) {
    return <div className="file-list-loading">加载中...</div>;
  }

  /* 空目录状态 */
  if (items.length === 0) {
    return <div className="file-list-empty">目录为空</div>;
  }

  return (
    <table
      className="file-list"
      onContextMenu={(e) => {
        // 仅在非行区域触发时弹出空白区域菜单
        const target = e.target as HTMLElement;
        if (!target.closest("tr.file-row")) {
          onContextMenu(e, null);
        }
      }}
    >
      <thead>
        <tr>
          <th
            className={`sort-header${sortField === "name" ? " sort-active" : ""}`}
            onClick={() => onSort("name")}
          >
            名称
            <SortIndicator field="name" sortField={sortField} sortAsc={sortAsc} />
          </th>
          <th
            className={`sort-header${sortField === "size" ? " sort-active" : ""}`}
            onClick={() => onSort("size")}
          >
            大小
            <SortIndicator field="size" sortField={sortField} sortAsc={sortAsc} />
          </th>
          <th
            className={`sort-header${sortField === "modified_at" ? " sort-active" : ""}`}
            onClick={() => onSort("modified_at")}
          >
            修改时间
            <SortIndicator field="modified_at" sortField={sortField} sortAsc={sortAsc} />
          </th>
          <th>锁状态</th>
        </tr>
      </thead>
      <tbody>
        {items.map((item) => {
          // 图标类名与 SVG
          const iconClass = getFileIconClass(item.name, item.item_type === "directory");
          const iconSvg = FILE_ICONS[iconClass] || FILE_ICONS["icon-default"];

          // 行样式：选中高亮 + 类型区分
          const rowClassName = [
            "file-row",
            selectedNames.has(item.name) ? "selected" : "",
            item.item_type,
          ]
            .filter(Boolean)
            .join(" ");

          return (
            <tr
              key={item.name}
              className={rowClassName}
              onClick={(e) => onSelect(item.name, e.ctrlKey || e.metaKey, e.shiftKey)}
              onDoubleClick={() => {
                if (item.item_type === "directory") {
                  onNavigate(item.name);
                } else {
                  onEdit(item.name);
                }
              }}
              onContextMenu={(e) => onContextMenu(e, item)}
              onDragOver={(e) => {
                // 仅目录行接受拖拽
                if (item.item_type === "directory") {
                  e.preventDefault();
                  onDragOverDir(item.name);
                }
              }}
              onDragLeave={() => {
                if (item.item_type === "directory") {
                  onDragOverDir(null);
                }
              }}
            >
              {/* 名称列：图标 + 文件名 */}
              <td className="file-name">
                <span
                  className={`file-icon ${iconClass}`}
                  dangerouslySetInnerHTML={{ __html: iconSvg }}
                />
                <span className="file-name-text">{item.name}</span>
              </td>

              {/* 大小列 */}
              <td>{formatSize(item.size)}</td>

              {/* 修改时间列 */}
              <td>{formatDate(item.modified_at)}</td>

              {/* 锁状态列 */}
              <td>
                {item.lock ? (
                  <span className={`lock-badge lock-${item.lock.type}`}>
                    {item.lock.type === "write" ? "写锁" : "读锁"} ({item.lock.holder})
                  </span>
                ) : (
                  <span className="lock-badge lock-none">-</span>
                )}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
