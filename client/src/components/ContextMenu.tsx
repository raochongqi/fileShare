import { useEffect, useRef, useState, useCallback } from "react";

/** 菜单项 */
export interface MenuItem {
  label: string; // 显示文本
  icon?: string; // 可选图标类名后缀（如 "edit" → 使用 "icon-menu-edit"）
  onClick: () => void; // 点击回调
  danger?: boolean; // 是否为危险操作（红色样式）
  disabled?: boolean; // 是否禁用（灰色、不可点击）
}

/** 分隔线 */
export interface MenuSeparator {
  type: "separator";
}

/** 菜单条目类型：菜单项或分隔线 */
export type MenuEntry = MenuItem | MenuSeparator;

/** 右键菜单组件属性 */
export interface ContextMenuProps {
  x: number; // 鼠标位置 X
  y: number; // 鼠标位置 Y
  items: MenuEntry[]; // 菜单条目列表
  onClose: () => void; // 关闭菜单回调
}

/**
 * 判断条目是否为分隔线
 */
function isSeparator(entry: MenuEntry): entry is MenuSeparator {
  return "type" in entry && entry.type === "separator";
}

/**
 * 右键上下文菜单组件
 *
 * 在指定坐标 (x, y) 处显示菜单，支持视口溢出自动调整、
 * 外部点击关闭、Escape 关闭、分隔线、禁用项和危险样式。
 */
export default function ContextMenu({ x, y, items, onClose }: ContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  // 实际渲染位置，可能在溢出调整后与 (x, y) 不同
  const [pos, setPos] = useState({ x, y });

  /**
   * 根据菜单尺寸和视口边界调整位置，确保菜单不溢出屏幕
   */
  const adjustPosition = useCallback(() => {
    const menu = menuRef.current;
    if (!menu) return;

    const { innerWidth, innerHeight } = window;
    const { offsetWidth, offsetHeight } = menu;

    let adjustedX = x;
    let adjustedY = y;

    // 水平方向溢出时向左偏移
    if (x + offsetWidth > innerWidth) {
      adjustedX = Math.max(0, innerWidth - offsetWidth);
    }

    // 垂直方向溢出时向上偏移
    if (y + offsetHeight > innerHeight) {
      adjustedY = Math.max(0, innerHeight - offsetHeight);
    }

    setPos({ x: adjustedX, y: adjustedY });
  }, [x, y]);

  // 初次渲染及坐标变化时调整位置
  useEffect(() => {
    adjustPosition();
  }, [adjustPosition]);

  // 监听点击外部和 Escape 键
  useEffect(() => {
    /** 点击外部时关闭菜单 */
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };

    /** 按下 Escape 时关闭菜单 */
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
      }
    };

    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("keydown", handleKeyDown);

    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [onClose]);

  // 无条目时不渲染
  if (items.length === 0) {
    return null;
  }

  /**
   * 点击菜单项的处理函数
   * 禁用项不触发任何操作；正常项执行回调后关闭菜单
   */
  const handleItemClick = (item: MenuItem) => {
    if (item.disabled) return;
    item.onClick();
    onClose();
  };

  return (
    <div
      ref={menuRef}
      className="context-menu"
      style={{ position: "fixed", left: pos.x, top: pos.y }}
    >
      {items.map((entry, index) => {
        if (isSeparator(entry)) {
          return <div key={`separator-${index}`} className="context-menu-separator" />;
        }

        const item = entry;
        // 拼接类名：基础类 + 条件类
        const classNames = [
          "context-menu-item",
          item.danger ? "danger" : "",
          item.disabled ? "disabled" : "",
        ]
          .filter(Boolean)
          .join(" ");

        return (
          <div
            key={`item-${index}-${item.label}`}
            className={classNames}
            onClick={() => handleItemClick(item)}
            role="menuitem"
            aria-disabled={item.disabled}
            tabIndex={item.disabled ? -1 : 0}
          >
            {item.icon && <span className={`icon-menu-${item.icon}`} />}
            <span>{item.label}</span>
          </div>
        );
      })}
    </div>
  );
}
