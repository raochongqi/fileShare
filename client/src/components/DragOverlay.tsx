interface DragOverlayProps {
  visible: boolean; // 是否显示拖拽遮罩
  targetDir: string | null; // 如果悬停在目录上方，显示目录名
}

/**
 * 拖拽上传遮罩组件
 * 当文件被拖拽到窗口上方时，显示全屏遮罩提示用户释放上传
 */
export default function DragOverlay({ visible, targetDir }: DragOverlayProps) {
  if (!visible) return null;

  return (
    <div className="drag-overlay">
      <div className="drag-overlay-content">
        <div className="drag-overlay-icon">
          {/* 上传图标 */}
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="64"
            height="64"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
            <polyline points="17 8 12 3 7 8" />
            <line x1="12" y1="3" x2="12" y2="15" />
          </svg>
        </div>
        <div className="drag-overlay-text">
          {targetDir
            ? `上传到 "${targetDir}"`
            : "释放以上传文件"}
        </div>
      </div>
    </div>
  );
}
