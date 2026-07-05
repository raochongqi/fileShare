interface FileToolbarProps {
  currentPath: string;
  onNavigateTo: (path: string) => void;  // 导航到面包屑指定路径
  onGoUp: () => void;
  onUpload: () => void;
  onCreateDir: () => void;
  onCreateFile: () => void;
  onRefresh: () => void;
  onselectAll: () => void;                // 全选回调
  searchQuery: string;
  onSearchChange: (query: string) => void;
  uploadingFiles: string[];  // 正在上传的文件名列表
  uploadProgress: number;    // 上传进度 0-100
}

export function FileToolbar({
  currentPath,
  onNavigateTo,
  onGoUp,
  onUpload,
  onCreateDir,
  onCreateFile,
  onRefresh,
  onselectAll,
  searchQuery,
  onSearchChange,
  uploadingFiles,
  uploadProgress,
}: FileToolbarProps) {
  // 拆分路径为各段，用于面包屑导航
  const pathParts = currentPath.split("/").filter(Boolean);

  // 判断是否处于根目录
  const isRoot = currentPath === "/";

  return (
    <div className="file-toolbar">
      {/* 面包屑导航区 */}
      <div className="breadcrumb">
        <button
          onClick={onGoUp}
          disabled={isRoot}
          title="上级目录"
          className="breadcrumb-up"
        >
          ⬆
        </button>
        <span className="breadcrumb-path">
          {/* 根目录始终显示，点击导航到 "/" */}
          <button
            onClick={() => onNavigateTo("/")}
            className="breadcrumb-root"
          >
            根目录
          </button>
          {pathParts.map((part, i) => {
            // 构造该段对应的完整路径
            const segmentPath = "/" + pathParts.slice(0, i + 1).join("/");
            const isLast = i === pathParts.length - 1;

            return (
              <span key={i}>
                <span className="breadcrumb-sep">/</span>
                {isLast ? (
                  // 最后一段为当前目录，仅加粗显示不可点击
                  <span className="breadcrumb-part breadcrumb-current">
                    {part}
                  </span>
                ) : (
                  // 非最后一段可点击导航
                  <button
                    onClick={() => onNavigateTo(segmentPath)}
                    className="breadcrumb-part breadcrumb-link"
                  >
                    {part}
                  </button>
                )}
              </span>
            );
          })}
        </span>
      </div>

      {/* 搜索输入框 */}
      <div className="search-wrapper">
        {/* 搜索图标 */}
        <svg
          className="search-icon"
          viewBox="0 0 24 24"
          width="16"
          height="16"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <circle cx="11" cy="11" r="8" />
          <line x1="21" y1="21" x2="16.65" y2="16.65" />
        </svg>
        <input
          type="text"
          className="search-input"
          placeholder="搜索文件..."
          value={searchQuery}
          onChange={(e) => onSearchChange(e.target.value)}
        />
        {/* 非空时显示清除按钮 */}
        {searchQuery && (
          <button
            className="search-clear"
            onClick={() => onSearchChange("")}
            title="清除搜索"
          >
            ×
          </button>
        )}
      </div>

      {/* 工具栏操作按钮 */}
      <div className="toolbar-actions">
        <button onClick={onUpload} title="上传文件">
          上传
        </button>
        <button onClick={onCreateDir} title="新建目录">
          新建目录
        </button>
        <button onClick={onCreateFile} title="新建文件">
          新建文件
        </button>
        <button onClick={onselectAll} title="全选">
          全选
        </button>
        <button onClick={onRefresh} title="刷新">
          刷新
        </button>
      </div>

      {/* 上传进度条：仅在有文件正在上传时显示 */}
      {uploadingFiles.length > 0 && (
        <div className="upload-progress-bar">
          <div
            className="upload-progress-fill"
            style={{ width: `${uploadProgress}%` }}
          />
          <span className="upload-progress-text">
            正在上传: {uploadingFiles.join(", ")} ({uploadProgress}%)
          </span>
        </div>
      )}
    </div>
  );
}
