import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { getWebSocketUrl } from "../api";
import {
  detectMissingDependency,
  MissingDependencyMatch,
} from "../utils/missingDependency";

export type LogLine = {
  type: "stdout" | "stderr" | "system" | "error";
  text: string;
  time: string;
};

export type ExecutionStatus = {
  text: string;
  type: "idle" | "running" | "success" | "error";
};

export type RunDetail = {
  language: string;
  activeFile?: string;
  langDisplay?: string;
};

export type ExecutionSessionValue = {
  logs: LogLine[];
  status: ExecutionStatus;
  isRunning: boolean;
  isInstalling: boolean;
  executionId: string | null;
  missingDependencyHint: MissingDependencyMatch | null;
  run: (detail: RunDetail) => void;
  stop: () => void;
  sendStdin: (text: string) => void;
  clearLogs: () => void;
  install: () => void;
};

const ExecutionSessionContext = createContext<ExecutionSessionValue | null>(
  null,
);

const CAP = 2000;
const capLogs = (next: LogLine[]) =>
  next.length > CAP ? next.slice(next.length - CAP) : next;

/**
 * M53: owns the project-scoped `/ws/execute` run session and the dependency
 * install stream. Previously this lived in Output.tsx's two big effects, so
 * switching the bottom panel away from Output (or collapsing it) unmounted
 * Output and its cleanup killed the running program. The provider is mounted
 * unconditionally while a project is active, so a run survives any bottom-tab
 * navigation. The run WebSocket is still created lazily inside `run()` — there
 * is no socket between runs.
 */
export function ExecutionSessionProvider({
  projectId,
  children,
}: React.PropsWithChildren<{ projectId: string | null }>) {
  const [logs, setLogs] = useState<LogLine[]>([]);
  const [status, setStatus] = useState<ExecutionStatus>({
    text: "Idle",
    type: "idle",
  });
  const [isRunning, setIsRunning] = useState(false);
  const [isInstalling, setIsInstalling] = useState(false);
  const [executionId, setExecutionId] = useState<string | null>(null);
  const [missingDependencyHint, setMissingDependencyHint] =
    useState<MissingDependencyMatch | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const runRafIdRef = useRef<number | null>(null);
  const runInFlightRef = useRef(false);

  const installAbortRef = useRef<AbortController | null>(null);
  const installReaderRef =
    useRef<ReadableStreamDefaultReader<Uint8Array> | null>(null);
  const installRafIdRef = useRef<number | null>(null);
  const installInFlightRef = useRef(false);

  // M43: the install flow needs the *current* isRunning value as a
  // defense-in-depth check backing Toolbar's own disabled-button enforcement.
  const isRunningRef = useRef(false);
  useEffect(() => {
    isRunningRef.current = isRunning;
  }, [isRunning]);

  const clearLogs = useCallback(() => setLogs([]), []);

  const run = useCallback(
    (detail: RunDetail) => {
      if (!projectId) return;
      const { language, activeFile, langDisplay } = detail || ({} as RunDetail);

      const time = new Date().toLocaleTimeString();
      setLogs([
        {
          type: "system",
          text: `Starting execution (${activeFile ? `${activeFile} → ` : ""}${langDisplay || language})...`,
          time,
        },
      ]);
      // M44: a new run starts with a clean slate — any missing-dependency
      // hint belongs to the run that produced it, never to this new one.
      setMissingDependencyHint(null);
      runInFlightRef.current = true;
      setIsRunning(true);
      setExecutionId(
        typeof crypto !== "undefined" && "randomUUID" in crypto
          ? crypto.randomUUID()
          : String(Date.now()),
      );
      setStatus({ text: "Running", type: "running" });
      document.dispatchEvent(new Event("run-started"));

      if (wsRef.current && wsRef.current.readyState !== WebSocket.CLOSED) {
        wsRef.current.onclose = null;
        wsRef.current.onerror = null;
        wsRef.current.onmessage = null;
        wsRef.current.close();
      }

      const ws = new WebSocket(getWebSocketUrl("/ws/execute", projectId));
      wsRef.current = ws;
      let exitedNormally = false;
      let accStdout = "";
      let accStderr = "";
      let logBuffer: LogLine[] = [];

      const flushLogs = () => {
        if (logBuffer.length === 0) return;
        const toAppend = logBuffer;
        logBuffer = [];
        setLogs((prev) => capLogs([...prev, ...toAppend]));
      };

      const appendLog = (logLine: Omit<LogLine, "time">) => {
        const now = new Date().toLocaleTimeString();
        logBuffer.push({ ...logLine, time: now });
        if (runRafIdRef.current === null) {
          runRafIdRef.current = requestAnimationFrame(() => {
            runRafIdRef.current = null;
            flushLogs();
          });
        }
      };

      ws.onopen = () => {
        ws.send(JSON.stringify({ type: "start", language, activeFile }));
      };

      ws.onmessage = (msg) => {
        try {
          const parsed = JSON.parse(msg.data);

          if (parsed.type === "stdout") {
            accStdout += parsed.data;
            appendLog({ type: "stdout", text: parsed.data });
          } else if (parsed.type === "stderr") {
            accStderr += parsed.data;
            appendLog({ type: "stderr", text: parsed.data });
          } else if (parsed.type === "status") {
            appendLog({ type: "system", text: parsed.data });
          } else if (parsed.type === "error") {
            accStderr += parsed.data;
            appendLog({ type: "error", text: parsed.data });
            setStatus({ text: "Error", type: "error" });
          } else if (parsed.type === "exit") {
            exitedNormally = true;
            const { exitCode, signal, timedOut, oom } = parsed.result;
            let statusText = `Process exited with code ${exitCode}`;
            if (signal) statusText += ` (signal: ${signal})`;
            if (timedOut) statusText = "Process timed out";
            if (oom) statusText = "Process ran out of memory (OOM)";
            appendLog({ type: "system", text: statusText });

            if (parsed.telemetrySummary) {
              const peakMb = (
                parsed.telemetrySummary.peakMemoryBytes /
                (1024 * 1024)
              ).toFixed(1);
              appendLog({
                type: "system",
                text: `Resource Profile — Peak CPU: ${parsed.telemetrySummary.peakCpuPercent}% | Peak Memory: ${peakMb} MB | PIDs: ${parsed.telemetrySummary.peakPids || 1}`,
              });
            }

            if (runRafIdRef.current !== null) {
              cancelAnimationFrame(runRafIdRef.current);
              runRafIdRef.current = null;
            }
            flushLogs();

            runInFlightRef.current = false;
            setIsRunning(false);
            setExecutionId(null);
            setStatus({
              text: exitCode === 0 ? "Exited (0)" : `Exited (${exitCode})`,
              type: exitCode === 0 ? "success" : "error",
            });
            // M44: only a failing run's own stderr is ever inspected.
            setMissingDependencyHint(
              exitCode !== 0 ? detectMissingDependency(accStderr) : null,
            );
            document.dispatchEvent(new Event("run-stopped"));

            document.dispatchEvent(
              new CustomEvent("ide-execution-result", {
                detail: {
                  result: {
                    ...parsed.result,
                    stdout: accStdout || parsed.result?.stdout || "",
                    stderr: accStderr || parsed.result?.stderr || "",
                  },
                  activeFile,
                  language,
                },
              }),
            );
          }
        } catch {
          // Ignore parse errors
        }
      };

      ws.onclose = () => {
        if (runRafIdRef.current !== null) {
          cancelAnimationFrame(runRafIdRef.current);
          runRafIdRef.current = null;
        }
        flushLogs();

        if (!exitedNormally) {
          setLogs((prev) => [
            ...prev,
            {
              type: "system",
              text: "Execution stream closed",
              time: new Date().toLocaleTimeString(),
            },
          ]);
          setStatus({ text: "Stopped", type: "idle" });
        }
        runInFlightRef.current = false;
        setIsRunning(false);
        setExecutionId(null);
        document.dispatchEvent(new Event("run-stopped"));
      };

      ws.onerror = () => {
        setLogs((prev) => [
          ...prev,
          {
            type: "error",
            text: "WebSocket connection error",
            time: new Date().toLocaleTimeString(),
          },
        ]);
        runInFlightRef.current = false;
        setIsRunning(false);
        setExecutionId(null);
        setStatus({ text: "Connection Error", type: "error" });
        document.dispatchEvent(new Event("run-stopped"));
      };
    },
    [projectId],
  );

  const stop = useCallback(() => {
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: "stop" }));
      setLogs((prev) => [
        ...prev,
        {
          type: "system",
          text: "Stopping execution process...",
          time: new Date().toLocaleTimeString(),
        },
      ]);
    }
  }, []);

  const sendStdin = useCallback((text: string) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN && text) {
      ws.send(JSON.stringify({ type: "stdin", data: text }));
      setLogs((prev) => [
        ...prev,
        {
          type: "stdout",
          text,
          time: new Date().toLocaleTimeString(),
        },
      ]);
    }
  }, []);

  // M43: dependency-install stream — chunked plain-text HTTP, not JSON-framed
  // WS messages, so it keeps its own request/reader/AbortController plumbing.
  const install = useCallback(async () => {
    if (!projectId || installInFlightRef.current || isRunningRef.current)
      return;
    installInFlightRef.current = true;

    const controller = new AbortController();
    installAbortRef.current = controller;
    let installLogBuffer: LogLine[] = [];

    const flushInstallLogs = () => {
      if (installLogBuffer.length === 0) return;
      const toAppend = installLogBuffer;
      installLogBuffer = [];
      setLogs((prev) => capLogs([...prev, ...toAppend]));
    };

    const appendInstallLog = (logLine: Omit<LogLine, "time">) => {
      const now = new Date().toLocaleTimeString();
      installLogBuffer.push({ ...logLine, time: now });
      if (installRafIdRef.current === null) {
        installRafIdRef.current = requestAnimationFrame(() => {
          installRafIdRef.current = null;
          flushInstallLogs();
        });
      }
    };

    setLogs([
      {
        type: "system",
        text: "Installing dependencies...",
        time: new Date().toLocaleTimeString(),
      },
    ]);
    setMissingDependencyHint(null);
    setIsInstalling(true);
    setStatus({ text: "Installing", type: "running" });
    document.dispatchEvent(new Event("install-started"));

    try {
      const res = await fetch(`/api/projects/${projectId}/install`, {
        method: "POST",
        credentials: "include",
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;

      if (!res.ok) {
        let errText = `Install request failed (${res.status})`;
        try {
          const body = await res.text();
          if (body) errText = body;
        } catch {
          // fall back to the generic status-based message above
        }
        if (controller.signal.aborted) return;
        appendInstallLog({ type: "error", text: errText });
        setStatus({ text: "Install Failed", type: "error" });
        return;
      }

      if (!res.body) {
        appendInstallLog({
          type: "error",
          text: "Install response had no readable body",
        });
        setStatus({ text: "Install Failed", type: "error" });
        return;
      }

      const reader = res.body.getReader();
      installReaderRef.current = reader;
      const decoder = new TextDecoder();

      while (true) {
        const { done, value } = await reader.read();
        if (controller.signal.aborted) return;
        if (done) {
          const tail = decoder.decode();
          if (tail) appendInstallLog({ type: "system", text: tail });
          break;
        }
        const chunk = decoder.decode(value, { stream: true });
        if (chunk) appendInstallLog({ type: "system", text: chunk });
      }

      if (installRafIdRef.current !== null) {
        cancelAnimationFrame(installRafIdRef.current);
        installRafIdRef.current = null;
      }
      flushInstallLogs();
      if (controller.signal.aborted) return;
      setStatus({ text: "Install Complete", type: "success" });
    } catch (err: any) {
      if (controller.signal.aborted || err?.name === "AbortError") {
        return;
      }
      if (installRafIdRef.current !== null) {
        cancelAnimationFrame(installRafIdRef.current);
        installRafIdRef.current = null;
      }
      flushInstallLogs();
      appendInstallLog({
        type: "error",
        text: `Install error: ${err?.message || String(err)}`,
      });
      setStatus({ text: "Install Failed", type: "error" });
    } finally {
      installReaderRef.current = null;
      installInFlightRef.current = false;
      if (!controller.signal.aborted) {
        setIsInstalling(false);
        document.dispatchEvent(new Event("install-stopped"));
      }
    }
  }, [projectId]);

  // Document-event listeners — the provider is always mounted while a project
  // is active, so these always land regardless of bottom-panel navigation.
  useEffect(() => {
    const onRun = (e: Event) => run((e as CustomEvent).detail as RunDetail);
    const onStop = () => stop();
    const onInstall = () => {
      void install();
    };
    document.addEventListener("ide-run-confirmed", onRun);
    document.addEventListener("ide-stop", onStop);
    document.addEventListener("ide-install-confirmed", onInstall);
    return () => {
      document.removeEventListener("ide-run-confirmed", onRun);
      document.removeEventListener("ide-stop", onStop);
      document.removeEventListener("ide-install-confirmed", onInstall);
    };
  }, [run, stop, install]);

  // Lifecycle reset — on projectId change AND on provider unmount, run the
  // teardown that was previously Output's run-effect + install-effect cleanup.
  useEffect(() => {
    return () => {
      const ws = wsRef.current;
      if (ws && ws.readyState !== WebSocket.CLOSED) {
        ws.onclose = null;
        ws.onerror = null;
        ws.onmessage = null;
        ws.onopen = null;
        ws.close();
      }
      wsRef.current = null;

      if (runRafIdRef.current !== null) {
        cancelAnimationFrame(runRafIdRef.current);
        runRafIdRef.current = null;
      }
      if (installRafIdRef.current !== null) {
        cancelAnimationFrame(installRafIdRef.current);
        installRafIdRef.current = null;
      }
      if (installReaderRef.current) {
        installReaderRef.current.cancel().catch(() => {});
        installReaderRef.current = null;
      }
      installAbortRef.current?.abort();

      // M45 (relocated): ws.onclose was just nulled, so if a run was still
      // active neither the exit handler nor onclose will dispatch run-stopped
      // for it — Toolbar's mirrored isRunning would stick true forever.
      if (runInFlightRef.current) {
        runInFlightRef.current = false;
        document.dispatchEvent(new Event("run-stopped"));
      }
      // Same concern for a fetch/stream still in flight at teardown.
      if (installInFlightRef.current) {
        installInFlightRef.current = false;
        document.dispatchEvent(new Event("install-stopped"));
      }
    };
  }, [projectId]);

  const value = useMemo<ExecutionSessionValue>(
    () => ({
      logs,
      status,
      isRunning,
      isInstalling,
      executionId,
      missingDependencyHint,
      run,
      stop,
      sendStdin,
      clearLogs,
      install: () => {
        void install();
      },
    }),
    [
      logs,
      status,
      isRunning,
      isInstalling,
      executionId,
      missingDependencyHint,
      run,
      stop,
      sendStdin,
      clearLogs,
      install,
    ],
  );

  return (
    <ExecutionSessionContext.Provider value={value}>
      {children}
    </ExecutionSessionContext.Provider>
  );
}

export function useExecutionSession(): ExecutionSessionValue {
  const ctx = useContext(ExecutionSessionContext);
  if (!ctx) {
    throw new Error(
      "useExecutionSession must be used within an <ExecutionSessionProvider>",
    );
  }
  return ctx;
}
