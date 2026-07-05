import { useState, useEffect, useCallback, useRef } from "react";
import { acquireLock, releaseLock, renewLock, queryLock, type LockInfo } from "../lib/api";

/** 锁管理 hook */
export function useLock() {
  // 当前持有的锁: path -> { token, leaseUntil, timerId }
  const [activeLocks, setActiveLocks] = useState<
    Map<string, { token: string; leaseUntil: number }>
  >(new Map());
  const timersRef = useRef<Map<string, number>>(new Map());

  // 申请写锁
  const acquireWrite = useCallback(async (path: string): Promise<string | null> => {
    try {
      const resp = await acquireLock(path, "write");
      setActiveLocks((prev) => {
        const next = new Map(prev);
        next.set(path, { token: resp.lock_token, leaseUntil: resp.lease_until });
        return next;
      });
      // 启动续租定时器
      startRenewal(path, resp.lock_token, resp.lease_until);
      return resp.lock_token;
    } catch {
      return null;
    }
  }, []);

  // 申请读锁
  const acquireRead = useCallback(async (path: string): Promise<string | null> => {
    try {
      const resp = await acquireLock(path, "read");
      setActiveLocks((prev) => {
        const next = new Map(prev);
        next.set(path, { token: resp.lock_token, leaseUntil: resp.lease_until });
        return next;
      });
      startRenewal(path, resp.lock_token, resp.lease_until);
      return resp.lock_token;
    } catch {
      return null;
    }
  }, []);

  // 释放锁
  const release = useCallback(async (path: string) => {
    const lock = activeLocks.get(path);
    if (!lock) return;

    // 停止续租定时器
    const timerId = timersRef.current.get(path);
    if (timerId) {
      clearInterval(timerId);
      timersRef.current.delete(path);
    }

    try {
      await releaseLock(path, lock.token);
    } catch {
      // 释放失败可能是锁已过期，忽略
    }

    setActiveLocks((prev) => {
      const next = new Map(prev);
      next.delete(path);
      return next;
    });
  }, [activeLocks]);

  // 启动续租定时器
  const startRenewal = useCallback((path: string, token: string, _leaseUntil: number) => {
    // 写锁 TTL 60s，读锁 TTL 30s，在 TTL 1/2 时续租
    // 简化：每 15s 续租一次
    const intervalMs = 15_000;
    const timerId = window.setInterval(async () => {
      try {
        const newLease = await renewLock(path, token);
        setActiveLocks((prev) => {
          const next = new Map(prev);
          const existing = next.get(path);
          if (existing) {
            next.set(path, { ...existing, leaseUntil: newLease });
          }
          return next;
        });
      } catch {
        // 续租失败，锁可能已丢失
        console.warn(`续租失败: ${path}`);
      }
    }, intervalMs);

    timersRef.current.set(path, timerId);
  }, []);

  // 查询锁状态
  const query = useCallback(async (path: string): Promise<LockInfo | null> => {
    return queryLock(path);
  }, []);

  // 组件卸载时清理所有定时器
  useEffect(() => {
    return () => {
      timersRef.current.forEach((timerId) => clearInterval(timerId));
    };
  }, []);

  return {
    activeLocks,
    acquireWrite,
    acquireRead,
    release,
    query,
  };
}
