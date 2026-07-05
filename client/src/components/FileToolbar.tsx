interface FileToolbarProps {
  currentPath: string;
  onGoUp: () => void;
  onUpload: () => void;
  onCreateDir: () => void;
  onCreateFile: () => void;
  onRefresh: () => void;
}

export function FileToolbar({
  currentPath,
  onGoUp,
  onUpload,
  onCreateDir,
  onCreateFile,
  onRefresh,
}: FileToolbarProps) {
  const pathParts = currentPath.split("/").filter(Boolean);

  return (
    <div className="file-toolbar">
      <div className="breadcrumb">
        <button onClick={onGoUp} disabled={currentPath === "/"} title="上级目录">
          ⬆
        </button>
        <span className="breadcrumb-path">
          <button onClick={() => {}} className="breadcrumb-root">
            根目录
          </button>
          {pathParts.map((part, i) => (
            <span key={i}>
              <span className="breadcrumb-sep">/</span>
              <span className="breadcrumb-part">{part}</span>
            </span>
          ))}
        </span>
      </div>
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
        <button onClick={onRefresh} title="刷新">
          刷新
        </button>
      </div>
    </div>
  );
}
