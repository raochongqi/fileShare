import { useState, useEffect, useCallback, useRef } from "react";

interface DragUploadState {
  isDragging: boolean; // 当文件被拖拽到窗口上方时为 true
  targetDir: string | null; // 如果拖拽到目录项上方，则为目录名；否则为 null
}

interface UseDragUploadOptions {
  onDrop: (files: File[], targetDir: string | null) => void;
}

/**
 * 拖拽上传钩子
 * 跟踪窗口上的拖拽状态，处理文件拖拽上传逻辑
 */
export function useDragUpload({ onDrop }: UseDragUploadOptions) {
  const [isDragging, setIsDragging] = useState(false);
  const [targetDir, setTargetDir] = useState<string | null>(null);

  // 使用计数器处理嵌套的 dragenter/dragleave 事件
  // 避免子元素触发 dragleave 导致状态误判
  const dragCounter = useRef(0);

  useEffect(() => {
    const handleDragEnter = (e: DragEvent) => {
      e.preventDefault();
      // 仅在拖拽内容包含文件时才处理
      if (e.dataTransfer?.types.includes("Files")) {
        dragCounter.current++;
        setIsDragging(true);
      }
    };

    const handleDragOver = (e: DragEvent) => {
      e.preventDefault();
    };

    const handleDragLeave = (e: DragEvent) => {
      e.preventDefault();
      // 仅在离开窗口时（relatedTarget 为 null）才减少计数
      if (e.relatedTarget === null) {
        dragCounter.current = 0;
        setIsDragging(false);
      } else {
        dragCounter.current--;
        if (dragCounter.current <= 0) {
          dragCounter.current = 0;
          setIsDragging(false);
        }
      }
    };

    const handleDrop = (e: DragEvent) => {
      e.preventDefault();
      // 重置计数器和拖拽状态
      dragCounter.current = 0;
      setIsDragging(false);

      const files = e.dataTransfer?.files
        ? Array.from(e.dataTransfer.files)
        : [];
      // 调用回调，传入文件列表和目标目录
      onDrop(files, targetDir);
    };

    window.addEventListener("dragenter", handleDragEnter);
    window.addEventListener("dragover", handleDragOver);
    window.addEventListener("dragleave", handleDragLeave);
    window.addEventListener("drop", handleDrop);

    return () => {
      window.removeEventListener("dragenter", handleDragEnter);
      window.removeEventListener("dragover", handleDragOver);
      window.removeEventListener("dragleave", handleDragLeave);
      window.removeEventListener("drop", handleDrop);
    };
  }, [onDrop, targetDir]);

  const setTargetDirFn = useCallback((name: string | null) => {
    setTargetDir(name);
  }, []);

  return {
    isDragging,
    targetDir,
    setTargetDir: setTargetDirFn,
  } as DragUploadState & { setTargetDir: (name: string | null) => void };
}
