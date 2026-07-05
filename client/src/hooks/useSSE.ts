import { useEffect, useRef, useCallback } from "react";
import { createEventSource } from "../lib/api";

export interface FileEvent {
  type: "created" | "updated" | "deleted" | "renamed" | "lock_changed";
  path?: string;
  is_dir?: boolean;
  etag?: string;
  old_path?: string;
  new_path?: string;
  lock?: {
    lock_type: string;
    holders: string[];
    expires_at: string;
  } | null;
}

type EventHandler = (event: FileEvent) => void;

/** SSE 事件监听 hook */
export function useSSE(onEvent: EventHandler) {
  const esRef = useRef<EventSource | null>(null);
  const handlerRef = useRef(onEvent);
  handlerRef.current = onEvent;

  const connect = useCallback(() => {
    // 关闭旧连接
    if (esRef.current) {
      esRef.current.close();
    }

    const es = createEventSource();
    esRef.current = es;

    const eventTypes = ["created", "updated", "deleted", "renamed", "lock_changed"];
    eventTypes.forEach((eventType) => {
      es.addEventListener(eventType, (e) => {
        try {
          const data = JSON.parse(e.data) as FileEvent;
          handlerRef.current(data);
        } catch {
          // 忽略解析错误
        }
      });
    });

    es.onerror = () => {
      // 断线后 5s 重连
      es.close();
      setTimeout(connect, 5000);
    };
  }, []);

  useEffect(() => {
    connect();
    return () => {
      esRef.current?.close();
    };
  }, [connect]);
}
