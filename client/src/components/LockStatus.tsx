interface LockStatusProps {
  activeLocks: Map<string, { token: string; leaseUntil: number }>;
  onRelease: (path: string) => void;
}

export function LockStatus({ activeLocks, onRelease }: LockStatusProps) {
  if (activeLocks.size === 0) return null;

  return (
    <div className="lock-status">
      <span className="lock-status-label">持有锁:</span>
      {Array.from(activeLocks.entries()).map(([path, lock]) => (
        <span key={path} className="lock-status-item">
          <span title={`Token: ${lock.token.slice(0, 8)}...`}>{path.split("/").pop()}</span>
          <button
            className="btn-release-lock"
            onClick={() => onRelease(path)}
            title="释放锁"
          >
            解锁
          </button>
        </span>
      ))}
    </div>
  );
}
