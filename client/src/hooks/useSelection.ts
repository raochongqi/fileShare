// 文件选择状态管理 Hook
// 管理文件管理器中的选中项集合，支持单击、Ctrl 多选、Shift 范围选

import { useState, useCallback, useMemo } from "react";
import type { DirItem } from "../lib/api";

/**
 * 管理文件选中状态的 Hook
 *
 * 维护一个 Set<string> 存储已选中的项目名称，
 * 同时追踪上次点击的索引以支持 Shift 范围选择。
 */
export function useSelection() {
  // 当前选中的项目名称集合
  const [selectedNames, setSelectedNames] = useState<Set<string>>(new Set());
  // 上次点击项的索引，用于 Shift 范围选择
  const [lastClickedIndex, setLastClickedIndex] = useState<number>(-1);

  /** 判断指定名称是否已选中 */
  const isSelected = useCallback(
    (name: string): boolean => selectedNames.has(name),
    [selectedNames],
  );

  /** 已选中项目数量 */
  const selectedCount = selectedNames.size;

  /**
   * 处理点击选择逻辑
   *
   * @param name - 点击的项目名称
   * @param ctrlKey - 是否按住 Ctrl 键（切换选中）
   * @param shiftKey - 是否按住 Shift 键（范围选择）
   * @param items - 当前目录下的全部项目列表
   */
  const select = useCallback(
    (name: string, ctrlKey: boolean, shiftKey: boolean, items: DirItem[]) => {
      const clickedIndex = items.findIndex((item) => item.name === name);

      if (shiftKey && lastClickedIndex >= 0) {
        // Shift 范围选择：从上次点击位置到当前位置之间的所有项目
        const start = Math.min(lastClickedIndex, clickedIndex);
        const end = Math.max(lastClickedIndex, clickedIndex);
        const rangeNames = items
          .slice(start, end + 1)
          .map((item) => item.name);

        setSelectedNames((prev) => {
          const next = new Set(prev);
          for (const n of rangeNames) {
            next.add(n);
          }
          return next;
        });
        // Shift 选择不更新 lastClickedIndex，保持锚点不变
      } else if (ctrlKey) {
        // Ctrl 切换选中：将当前项加入或移出选中集合
        setSelectedNames((prev) => {
          const next = new Set(prev);
          if (next.has(name)) {
            next.delete(name);
          } else {
            next.add(name);
          }
          return next;
        });
        setLastClickedIndex(clickedIndex);
      } else {
        // 无修饰键：仅选中当前项，清除其他选中
        setSelectedNames(new Set([name]));
        setLastClickedIndex(clickedIndex);
      }
    },
    [lastClickedIndex],
  );

  /** 全选 */
  const selectAll = useCallback((items: DirItem[]) => {
    setSelectedNames(new Set(items.map((item) => item.name)));
  }, []);

  /** 清除所有选中 */
  const clearSelection = useCallback(() => {
    setSelectedNames(new Set());
    setLastClickedIndex(-1);
  }, []);

  return useMemo(
    () => ({
      selectedNames,
      selectedCount,
      isSelected,
      select,
      selectAll,
      clearSelection,
    }),
    // selectedNames 是 Set 引用，每次 setState 都是新引用，这里需加入依赖
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [selectedNames, selectedCount, isSelected, select, selectAll, clearSelection],
  );
}
