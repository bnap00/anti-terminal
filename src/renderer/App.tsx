import type React from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import type { AppSettings } from "../main/settings/types";
import type { ChatMessage, DebugLogEntry, TaskSession, ViewNode } from "../main/runtime/types";

// Only commands that are unambiguously terminal calls, never natural language
const ALWAYS_DIRECT = new Set([
  "ls", "ll", "la", "pwd",
  "df", "du", "uptime", "free", "top", "htop", "ps",
  "whoami", "uname", "hostname", "id",
  "env", "printenv",
  "date", "cal",
]);

function isDirectCommand(input: string): boolean {
  const trimmed = input.trim();
  if (!trimmed || trimmed.includes("\n")) return false;
  // Path-based execution is always direct
  if (trimmed.startsWith("./") || trimmed.startsWith("/") || trimmed.startsWith("~/")) return true;
  // Shell syntax (pipe, redirect, logical operators) — unambiguously a shell command
  if (/[|><;&]/.test(trimmed)) return true;
  // Exact first-word match against the small safe list
  const firstWord = trimmed.split(/\s+/)[0].toLowerCase();
  return ALWAYS_DIRECT.has(firstWord);
}

const starterPrompts = [
  "summarize recent git activity",
  "show me the largest files in this repo",
  "monitor cpu usage like htop",
  "open an interactive repo dashboard"
];

export default function App() {
  const bridge = window.antiTerminal;
  const [prompt, setPrompt] = useState("");
  const [search, setSearch] = useState("");
  const [sessions, setSessions] = useState<TaskSession[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [pendingMessage, setPendingMessage] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [debugEntries, setDebugEntries] = useState<DebugLogEntry[]>([]);
  const [showTraces, setShowTraces] = useState(false);
  const [cwd, setCwd] = useState<string>("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const threadEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (!e.metaKey && !e.ctrlKey) return;
      if (e.key === ",") {
        e.preventDefault();
        void bridge?.openSettingsWindow();
      } else if (e.key === "k") {
        e.preventDefault();
        searchInputRef.current?.focus();
        searchInputRef.current?.select();
      } else if (e.key === "n") {
        e.preventDefault();
        setSelectedId(null);
        setPrompt("");
        setSearch("");
        setTimeout(() => textareaRef.current?.focus(), 0);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [bridge]);

  useEffect(() => {
    if (!bridge) {
      setLoadError("Renderer bridge unavailable. The Electron preload script did not initialize.");
      return;
    }

    let mounted = true;

    void bridge.getSettings().then((snapshot) => {
      if (mounted) setSettings(snapshot);
    }).catch((error: unknown) => {
      if (mounted) setLoadError(error instanceof Error ? error.message : "Failed to load settings.");
    });

    void bridge.getSessions().then((snapshot) => {
      if (!mounted) return;
      setSessions(snapshot.sessions);
      if (snapshot.sessions[0]) {
        setSelectedId((current) => current ?? snapshot.sessions[0].id);
      }
    }).catch((error: unknown) => {
      if (mounted) setLoadError(error instanceof Error ? error.message : "Failed to load sessions.");
    });

    const unsubscribe = bridge.onSessionsUpdate((snapshot) => {
      setSessions(snapshot.sessions);
      setSelectedId((current) => current ?? snapshot.sessions[0]?.id ?? null);
    });

    void bridge.getDebugLogs().then((entries) => {
      if (mounted) setDebugEntries(entries);
    });

    void bridge.getCwd().then((dir) => {
      if (mounted) setCwd(dir);
    });

    const unsubscribeDebug = bridge.onDebugLog((entry) => {
      setDebugEntries((prev) => [entry, ...prev].slice(0, 300));
    });

    const unsubscribeSettings = bridge.onSettingsUpdate((updated) => {
      setSettings(updated);
    });

    return () => {
      mounted = false;
      unsubscribe();
      unsubscribeDebug();
      unsubscribeSettings();
    };
  }, [bridge]);

  // Always snap to latest content when sessions update
  useEffect(() => {
    threadEndRef.current?.scrollIntoView({ behavior: "instant" } as ScrollIntoViewOptions);
  }, [sessions, selectedId]);

  const selectedSession = useMemo(
    () => sessions.find((s) => s.id === selectedId) ?? null,
    [selectedId, sessions]
  );

  const growTextarea = useCallback((el: HTMLTextAreaElement) => {
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, []);

  function handlePromptChange(event: React.ChangeEvent<HTMLTextAreaElement>) {
    setPrompt(event.target.value);
    growTextarea(event.target);
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void handleSubmit(prompt);
    }
  }

  async function handleSubmit(nextPrompt: string) {
    if (!nextPrompt.trim() || submitting) return;

    const trimmed = nextPrompt.trim();
    setSubmitting(true);
    setPendingMessage(trimmed);
    setPrompt("");
    if (textareaRef.current) textareaRef.current.style.height = "auto";

    try {
      if (!bridge) throw new Error("Renderer bridge unavailable.");

      if (isDirectCommand(trimmed)) {
        const session = await bridge.runDirect(selectedId, trimmed);
        setSelectedId(session.id);
      } else if (selectedId) {
        await bridge.sendChat(selectedId, trimmed);
      } else {
        const session = await bridge.startChat(trimmed);
        setSelectedId(session.id);
      }

      setLoadError(null);
    } catch (error: unknown) {
      setLoadError(error instanceof Error ? error.message : "Failed.");
    } finally {
      setSubmitting(false);
      setPendingMessage(null);
      textareaRef.current?.focus();
    }
  }

  function handleStarterPrompt(sp: string) {
    setPrompt(sp);
    setTimeout(() => {
      if (textareaRef.current) {
        textareaRef.current.focus();
        growTextarea(textareaRef.current);
      }
    }, 0);
  }

  async function handleDelete(sessionId: string, e: React.MouseEvent) {
    e.stopPropagation();
    await bridge?.deleteTask(sessionId);
    if (selectedId === sessionId) setSelectedId(null);
  }

  const isRunning = selectedSession?.status === "running" || (selectedSession?.liveViewIds.length ?? 0) > 0;
  const isStopped = selectedSession?.status === "stopped" && selectedSession?.mode === "streaming";

  const composerPlaceholder = selectedId
    ? "Ask a follow-up… (Enter to send, Shift+Enter for newline)"
    : "Describe a task or pick a starter above…";

  const sendIcon = submitting
    ? <span className="send-spinner" />
    : (
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
        <path d="M8 13V3M8 3L4 7M8 3L12 7" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
      </svg>
    );

  return (
    <div className={showTraces ? "workspace-shell with-traces" : "workspace-shell"}>
      {/* ── Left nav ── */}
      <aside className="nav-pane">
        <div className="nav-top">
          <div className="window-dots">
            <span
              className="dot dot-red"
              title="Close"
              role="button"
              tabIndex={0}
              onClick={() => void bridge?.windowClose()}
              onKeyDown={(e) => e.key === "Enter" && void bridge?.windowClose()}
            />
            <span
              className="dot dot-yellow"
              title="Minimize"
              role="button"
              tabIndex={0}
              onClick={() => void bridge?.windowMinimize()}
              onKeyDown={(e) => e.key === "Enter" && void bridge?.windowMinimize()}
            />
            <span
              className="dot dot-green"
              title="Maximize"
              role="button"
              tabIndex={0}
              onClick={() => void bridge?.windowMaximize()}
              onKeyDown={(e) => e.key === "Enter" && void bridge?.windowMaximize()}
            />
          </div>
          <span className="nav-app-name">anti terminal</span>
        </div>

        <div className="nav-search-row">
          <div className="nav-search-box">
            <svg className="nav-search-icon" width="13" height="13" viewBox="0 0 16 16" fill="none">
              <circle cx="6.5" cy="6.5" r="5" stroke="currentColor" strokeWidth="1.5"/>
              <path d="M10.5 10.5L14 14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
            </svg>
            <input
              ref={searchInputRef}
              className="nav-search-input"
              placeholder="Search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            <span className="nav-search-kbd">⌘K</span>
          </div>
        </div>

        <div className="nav-section">
          <div className="nav-heading-row">
            <span className="nav-heading">Conversations</span>
            <button
              className="nav-new-btn"
              title="New conversation"
              onClick={() => {
                setSelectedId(null);
                setPrompt("");
                setSearch("");
                setTimeout(() => textareaRef.current?.focus(), 0);
              }}
            >
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                <path d="M7 1v12M1 7h12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
              </svg>
            </button>
          </div>
          <div className="session-rail">
            {sessions.length === 0 ? (
              <p className="nav-empty">No conversations yet.</p>
            ) : null}
            {sessions
              .filter((s) => !search || s.title.toLowerCase().includes(search.toLowerCase()))
              .map((session) => {
                const isLive = session.liveViewIds.length > 0;
                const isActive = session.id === selectedId;
                return (
                  <div
                    key={session.id}
                    className={isActive ? "session-row active" : "session-row"}
                    onClick={() => setSelectedId(session.id)}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(e) => e.key === "Enter" && setSelectedId(session.id)}
                  >
                    <div className="session-row-main">
                      {isLive ? <span className="session-live-dot" /> : null}
                      <span className="session-title">{session.title}</span>
                      <span className="session-time">{relativeTime(session.createdAt)}</span>
                      <button
                        className="session-delete-btn"
                        title="Delete"
                        onClick={(e) => void handleDelete(session.id, e)}
                      >
                        ×
                      </button>
                    </div>
                  </div>
                );
              })}
          </div>
        </div>

        <div className="nav-footer">
          <button
            className="nav-settings-btn"
            onClick={() => void bridge?.openSettingsWindow()}
          >
            Settings
          </button>
        </div>
      </aside>

      {/* ── Center: full work area ── */}
      <main className="center-pane">
        <header className="topbar">
          <div className="topbar-title">
            {selectedSession ? (
              <>
                <strong>{selectedSession.title}</strong>
                <span className="topbar-badge">{selectedSession.mode}</span>
                {selectedSession.liveViewIds.length > 0 ? (
                  <span className="topbar-badge live">● live</span>
                ) : null}
              </>
            ) : (
              <strong>anti terminal</strong>
            )}
          </div>
          <div className="topbar-actions">
            {isRunning ? (
              <button
                className="pill-button pill-danger"
                onClick={() => void bridge?.stopTask(selectedSession!.id)}
              >
                Stop
              </button>
            ) : null}
            {isStopped ? (
              <button
                className="pill-button pill-success"
                onClick={() => void bridge?.restartTask(selectedSession!.id)}
              >
                ▶ Restart
              </button>
            ) : null}
            <button
              className={showTraces ? "pill-button pill-active" : "pill-button"}
              onClick={() => setShowTraces((v) => !v)}
            >
              Traces
            </button>
          </div>
        </header>

        <section className="conversation-pane">
          {loadError ? (
            <div className="error-banner">
              <strong>Error</strong>
              <p>{loadError}</p>
            </div>
          ) : null}

          {selectedSession ? (
            <ChatThread session={selectedSession} bridge={bridge} />
          ) : submitting && pendingMessage ? (
            <div className="chat-thread">
              <div className="chat-bubble user-bubble">
                <div className="bubble-label">You</div>
                <div className="bubble-content">{pendingMessage}</div>
              </div>
            </div>
          ) : (
            <div className="empty-state">
              <div className="empty-hero">
                <div className="empty-icon">⌘</div>
                <h1>anti terminal</h1>
                <p>A chatbot that responds with UI. Static snapshots or live-updating views.</p>
              </div>
              <div className="starter-grid">
                {starterPrompts.map((sp) => (
                  <button key={sp} className="starter-chip" onClick={() => handleStarterPrompt(sp)}>
                    <span className="starter-chip-icon">›_</span>
                    <span>{sp}</span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {submitting ? (
            <div className="chat-bubble assistant-bubble">
              <div className="bubble-label">anti terminal</div>
              <div className="busy-status">
                <div className="typing-dots"><span /><span /><span /></div>
                {selectedSession?.busyHint ? (
                  <span className="busy-hint">{selectedSession.busyHint}</span>
                ) : null}
              </div>
            </div>
          ) : null}

          <div ref={threadEndRef} />
        </section>

        <footer className="composer-dock">
          {cwd ? (
            <div className="composer-cwd" title={cwd}>
              <span className="composer-cwd-icon">›_</span>
              <span className="composer-cwd-path">{abbreviatePath(cwd)}</span>
            </div>
          ) : null}
          <textarea
            ref={textareaRef}
            value={prompt}
            onChange={handlePromptChange}
            onKeyDown={handleKeyDown}
            placeholder={composerPlaceholder}
          />
          <div className="dock-footer">
            <div className="dock-meta">
              <span className="dock-provider">
                {settings?.providers[settings.provider]?.model}
              </span>
              <span className="dock-hint">↵ send · ⇧↵ newline</span>
            </div>
            <button
              className="send-button"
              disabled={submitting || !prompt.trim()}
              onClick={() => void handleSubmit(prompt)}
            >
              {sendIcon}
            </button>
          </div>
          {selectedSession?.tokenUsage ? (
            <div className="dock-token-bar">
              <span>in {fmtTokens(selectedSession.tokenUsage.input)}</span>
              <span className="dock-token-sep">·</span>
              <span>out {fmtTokens(selectedSession.tokenUsage.output)}</span>
              <span className="dock-token-sep">·</span>
              <span className="dock-token-total">{fmtTokens(selectedSession.tokenUsage.input + selectedSession.tokenUsage.output)} total</span>
            </div>
          ) : null}
        </footer>
      </main>
      {showTraces ? (
        <TracesPane entries={debugEntries} sessionId={selectedId} />
      ) : null}
    </div>
  );
}

/* ── Traces pane ─────────────────────────────────── */

function TracesPane({ entries, sessionId }: { entries: DebugLogEntry[]; sessionId: string | null }) {
  const filtered = sessionId
    ? entries.filter((e) => !e.sessionId || e.sessionId === sessionId)
    : entries;

  return (
    <aside className="inspector-pane">
      <div className="inspector-heading">
        <span style={{ fontWeight: 600, fontSize: "0.82rem" }}>Traces</span>
        <span className="muted">{filtered.length}</span>
      </div>
      <div className="trace-list">
        {filtered.length === 0 ? (
          <p className="nav-empty">No traces yet.</p>
        ) : null}
        {filtered.map((entry) => (
          <div
            key={entry.id}
            className={`trace-card${entry.level === "warn" ? " trace-warn" : entry.level === "error" ? " trace-error" : ""}`}
          >
            <div className="trace-meta">
              <span>{entry.scope}</span>
              <span>{new Date(entry.at).toLocaleTimeString()}</span>
            </div>
            <div className="trace-message">{entry.message}</div>
            {entry.detail ? <pre className="trace-raw">{entry.detail}</pre> : null}
          </div>
        ))}
      </div>
    </aside>
  );
}

/* ── Chat thread ─────────────────────────────────── */

function ChatThread({ session, bridge }: { session: TaskSession; bridge: Window["antiTerminal"] | undefined }) {
  return (
    <div className="chat-thread">
      {session.messages.map((msg) =>
        msg.role === "user" ? (
          <UserBubble key={msg.id} message={msg} />
        ) : (
          <AssistantTurn key={msg.id} session={session} message={msg} bridge={bridge} />
        )
      )}
    </div>
  );
}

function UserBubble({ message }: { message: ChatMessage }) {
  return (
    <div className="chat-bubble user-bubble">
      <div className="bubble-label">You</div>
      <div className="bubble-content">{message.content}</div>
    </div>
  );
}

function AssistantTurn({ session, message, bridge }: {
  session: TaskSession;
  message: ChatMessage;
  bridge: Window["antiTerminal"] | undefined;
}) {
  const views = (message.viewIds ?? [])
    .map((id) => session.views.find((v) => v.id === id))
    .filter((v): v is ViewNode => v !== undefined);

  return (
    <>
      {message.content ? (
        <div className="chat-bubble assistant-bubble">
          <div className="bubble-label">anti terminal</div>
          <div className="bubble-content">{message.content}</div>
        </div>
      ) : null}
      {views.map((view) => (
        <ViewCard key={view.id} session={session} view={view} bridge={bridge} />
      ))}
    </>
  );
}

/* ── View card ───────────────────────────────────── */

function ViewCard({ session, view, bridge }: {
  session: TaskSession;
  view: ViewNode;
  bridge: Window["antiTerminal"] | undefined;
}) {
  const isLive = session.liveViewIds.includes(view.id);

  return (
    <div className={`view-card view-card-${view.type}`}>
      <div className="view-card-header">
        <span className="view-card-title">{view.title ?? view.id}</span>
        <div className="view-card-badges">
          {isLive ? <span className="live-badge">● live</span> : null}
          <span className="artifact-type-badge">{view.type}</span>
        </div>
      </div>

      {view.type === "markdown" && <div className="markdown"><ReactMarkdown remarkPlugins={[remarkGfm]}>{view.content}</ReactMarkdown></div>}
      {view.type === "approval" && <ApprovalView view={view} bridge={bridge} />}
      {view.type === "html" && <HtmlView content={view.content} sessionId={session.id} />}
      {view.type === "log" && <pre className="log">{view.content}</pre>}
      {view.type === "terminal" && <pre className="terminal-view">{view.content}</pre>}
      {view.type === "code" && <CodeView view={view} />}
      {view.type === "diff" && <DiffView content={view.content} />}
      {view.type === "json-tree" && <JsonTreeView content={view.content} />}
      {view.type === "stats" && <StatsView items={view.items} />}
      {view.type === "table" && <TableView view={view} />}
      {view.type === "bar-chart" && <BarChartView items={view.items} />}
      {view.type === "actions" && <ActionsView session={session} view={view} bridge={bridge} />}
      {view.type === "line-chart" && <LineChartView data={view.data} />}
      {view.type === "pie-chart" && <PieChartView data={view.data} />}
      {view.type === "gauge" && <GaugeView data={view.data} />}
      {view.type === "timeline" && <TimelineView data={view.data} />}
      {view.type === "form" && <FormView sessionId={session.id} view={view} bridge={bridge} />}
      {view.type === "progress" && <ProgressView data={view.data} />}
      {view.type === "alert" && <AlertView data={view.data} />}
      {view.type === "image" && <ImageView data={view.data} />}
      {view.type === "kanban" && <KanbanView data={view.data} />}
      {view.type === "file-tree" && <FileTreeView data={view.data} />}
      {view.type === "metric" && <MetricView data={view.data} />}
      {view.type === "card-grid" && <CardGridView data={view.data} />}
      {view.type === "heatmap" && <HeatmapView data={view.data} />}
    </div>
  );
}

/* ── View components ─────────────────────────────── */

function HtmlView({ content, sessionId }: { content: string; sessionId: string }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const bodyMatch = content.match(/<body[^>]*>([\s\S]*)<\/body>/i);
    el.innerHTML = bodyMatch ? bodyMatch[1] : content;

    // Inject session context so scripts can call window.antiTerminal.runShell()
    const ctx = document.createElement("script");
    ctx.dataset.atCtx = "1";
    ctx.textContent = [
      `window.__atSessionId = ${JSON.stringify(sessionId)};`,
      "if (window.antiTerminal && !window.antiTerminal.__sessionRunShellWrapped) {",
      "  const originalRunShell = window.antiTerminal.runShell.bind(window.antiTerminal);",
      "  window.antiTerminal.runShell = (command) => originalRunShell(command, window.__atSessionId);",
      "  window.antiTerminal.__sessionRunShellWrapped = true;",
      "}"
    ].join("\n");
    el.insertBefore(ctx, el.firstChild);

    // innerHTML doesn't execute scripts — re-inject user scripts so they run
    el.querySelectorAll("script:not([data-at-ctx])").forEach((old) => {
      const next = document.createElement("script");
      for (const attr of old.attributes) next.setAttribute(attr.name, attr.value);
      next.textContent = old.textContent;
      old.replaceWith(next);
    });
  }, [content, sessionId]);

  return <div ref={ref} className="html-view" />;
}

function ApprovalView({ view, bridge }: {
  view: Extract<ViewNode, { type: "approval" }>;
  bridge: Window["antiTerminal"] | undefined;
}) {
  const { commandId, command, risk, reason, status } = view.data;
  const pending = status === "pending-approval";
  const running = status === "running";
  const done = !pending && !running;

  return (
    <div className={`approval-card approval-${risk.replace("/", "-")}`}>
      <div className="approval-main">
        <div className="approval-heading">
          <span className="approval-risk">{risk}</span>
          <span className="approval-status">{status}</span>
        </div>
        <pre className="approval-command">{command}</pre>
        <p className="approval-reason">{reason}</p>
      </div>
      <div className="approval-actions">
        {pending ? (
          <>
            <button className="approval-button approval-deny" onClick={() => void bridge?.denyCommand(commandId)}>Deny</button>
            <button className="approval-button approval-approve" onClick={() => void bridge?.approveCommand(commandId)}>Approve</button>
          </>
        ) : running ? (
          <button className="approval-button approval-deny" onClick={() => void bridge?.stopCommand(commandId)}>Stop</button>
        ) : (
          <span className="approval-final">{done ? status : ""}</span>
        )}
      </div>
    </div>
  );
}

function BarChartView({ items }: { items: Array<{ label: string; value: string; bytes: number }> }) {
  const max = Math.max(...items.map((item) => item.bytes), 1);
  return (
    <div className="bar-chart">
      {items.map((item) => {
        const pct = Math.max((item.bytes / max) * 100, 1).toFixed(1);
        return (
          <div key={item.label} className="bar-row">
            <div className="bar-label" title={item.label}>{item.label}</div>
            <div className="bar-track">
              <div className="bar-fill" style={{ width: `${pct}%` }} />
            </div>
            <div className="bar-value">{item.value}</div>
          </div>
        );
      })}
    </div>
  );
}

function StatsView({ items }: { items: Array<{ label: string; value: string }> }) {
  return (
    <div className="stats-grid">
      {items.map((item) => (
        <div key={item.label} className="stat-card">
          <span>{item.label}</span>
          <strong>{item.value}</strong>
        </div>
      ))}
    </div>
  );
}

function TableView({ view }: { view: Extract<ViewNode, { type: "table" }> }) {
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>{view.columns.map((col) => <th key={col}>{col}</th>)}</tr>
        </thead>
        <tbody>
          {view.rows.map((row, i) => (
            <tr key={i}>
              {view.columns.map((col) => <td key={col}>{row[col]}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ActionsView({ session, view, bridge }: {
  session: TaskSession;
  view: Extract<ViewNode, { type: "actions" }>;
  bridge: Window["antiTerminal"] | undefined;
}) {
  return (
    <div className="action-list">
      {view.actions.map((action) => (
        <button
          key={action.id}
          className="action-card"
          onClick={() => void bridge?.runAction({ sessionId: session.id, action })}
        >
          <span>{action.label}</span>
          <small>{action.description ?? action.command}</small>
        </button>
      ))}
    </div>
  );
}

/* ── New view components ─────────────────────────── */

function CodeView({ view }: { view: Extract<ViewNode, { type: "code" }> }) {
  return (
    <div className="code-view">
      {view.lang && <span className="code-lang-badge">{view.lang}</span>}
      <pre className="code-block">{view.content}</pre>
    </div>
  );
}

function DiffView({ content }: { content: string }) {
  if (!content.trim()) {
    return <div className="diff-empty">No diff found — working tree is clean.</div>;
  }
  const lines = content.split("\n");
  return (
    <div className="diff-view">
      {lines.map((line, i) => {
        const cls = line.startsWith("+") && !line.startsWith("+++")
          ? "diff-add"
          : line.startsWith("-") && !line.startsWith("---")
          ? "diff-remove"
          : line.startsWith("@@")
          ? "diff-hunk"
          : line.startsWith("---") || line.startsWith("+++")
          ? "diff-header"
          : "diff-ctx";
        return <div key={i} className={`diff-line ${cls}`}>{line || " "}</div>;
      })}
    </div>
  );
}

function JsonTreeView({ content }: { content: string }) {
  let parsed: unknown;
  try { parsed = JSON.parse(content); }
  catch { return <pre className="log">{content}</pre>; }
  return <div className="json-tree"><JsonNode value={parsed} depth={0} /></div>;
}

function JsonNode({ value, depth }: { value: unknown; depth: number }) {
  const [open, setOpen] = useState(depth < 2);
  if (value === null) return <span className="jn-null">null</span>;
  if (typeof value === "boolean") return <span className="jn-bool">{String(value)}</span>;
  if (typeof value === "number") return <span className="jn-num">{String(value)}</span>;
  if (typeof value === "string") return <span className="jn-str">"{value}"</span>;
  const isArr = Array.isArray(value);
  const entries = isArr
    ? (value as unknown[]).map((v, i) => [String(i), v] as [string, unknown])
    : Object.entries(value as Record<string, unknown>);
  const [open1, close1] = isArr ? ["[", "]"] : ["{", "}"];
  return (
    <span>
      <button className="jn-toggle" onClick={() => setOpen((o) => !o)}>{open ? "▾" : "▸"}</button>
      <span className="jn-bracket">{open1}</span>
      {open ? (
        <div className="jn-children">
          {entries.map(([k, v]) => (
            <div key={k} className="jn-row">
              {!isArr && <span className="jn-key">"{k}": </span>}
              <JsonNode value={v} depth={depth + 1} />
            </div>
          ))}
        </div>
      ) : (
        <span className="jn-ellipsis"> … {entries.length} {isArr ? "items" : "keys"} … </span>
      )}
      <span className="jn-bracket">{close1}</span>
    </span>
  );
}

function LineChartView({ data }: { data: Extract<ViewNode, { type: "line-chart" }>["data"] }) {
  const allSeries = data.series ?? (data.points ? [{ name: "", points: data.points }] : []);
  if (!allSeries.length || !allSeries[0].points.length) return <div className="chart-empty">No data</div>;

  const W = 360, H = 180, ML = 44, MB = 32, MT = 10, MR = 10;
  const pw = W - ML - MR, ph = H - MT - MB;

  const allY = allSeries.flatMap((s) => s.points.map((p) => p.y));
  const yMin = Math.min(...allY), yMax = Math.max(...allY);
  const yRange = yMax - yMin || 1;

  const labels = allSeries[0].points.map((p) => p.x);
  const xStep = pw / Math.max(labels.length - 1, 1);

  const PALETTE = ["#4cc2ff", "#3dd68c", "#e4b349", "#ff6057", "#b77fff"];
  const GRID_LINES = 4;

  return (
    <svg className="line-chart" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMid meet">
      {/* grid lines */}
      {Array.from({ length: GRID_LINES + 1 }, (_, i) => {
        const y = MT + (ph / GRID_LINES) * i;
        const val = yMax - (yRange / GRID_LINES) * i;
        return (
          <g key={i}>
            <line x1={ML} y1={y} x2={ML + pw} y2={y} stroke="rgba(255,255,255,0.06)" strokeWidth="1" />
            <text x={ML - 4} y={y + 4} textAnchor="end" fontSize="9" fill="rgba(255,255,255,0.4)">
              {val % 1 === 0 ? val : val.toFixed(1)}
            </text>
          </g>
        );
      })}
      {/* x labels */}
      {labels.map((label, i) => {
        const maxLabels = Math.floor(pw / 40);
        const step = Math.ceil(labels.length / maxLabels);
        if (i % step !== 0 && i !== labels.length - 1) return null;
        return (
          <text key={i} x={ML + i * xStep} y={H - 4} textAnchor="middle" fontSize="9" fill="rgba(255,255,255,0.4)">
            {label}
          </text>
        );
      })}
      {/* axis labels */}
      {data.yLabel && <text x={8} y={MT + ph / 2} textAnchor="middle" fontSize="9" fill="rgba(255,255,255,0.4)" transform={`rotate(-90,8,${MT + ph / 2})`}>{data.yLabel}</text>}
      {/* series lines */}
      {allSeries.map((series, si) => {
        const color = PALETTE[si % PALETTE.length];
        const pts = series.points.map((p, i) => {
          const x = ML + i * xStep;
          const y = MT + ph - ((p.y - yMin) / yRange) * ph;
          return `${x},${y}`;
        }).join(" ");
        return (
          <g key={si}>
            <polyline points={pts} fill="none" stroke={color} strokeWidth="1.8" strokeLinejoin="round" strokeLinecap="round" />
            {series.points.map((p, i) => {
              const x = ML + i * xStep;
              const y = MT + ph - ((p.y - yMin) / yRange) * ph;
              return <circle key={i} cx={x} cy={y} r="3" fill={color}><title>{`${p.x}: ${p.y}`}</title></circle>;
            })}
          </g>
        );
      })}
      {/* legend */}
      {allSeries.length > 1 && allSeries.map((s, si) => (
        <g key={si} transform={`translate(${ML + si * 80}, ${H - 2})`}>
          <rect x="0" y="-6" width="10" height="3" fill={PALETTE[si % PALETTE.length]} rx="1" />
          <text x="13" y="-3" fontSize="9" fill="rgba(255,255,255,0.5)">{s.name}</text>
        </g>
      ))}
    </svg>
  );
}

function PieChartView({ data }: { data: Extract<ViewNode, { type: "pie-chart" }>["data"] }) {
  const { items, donut } = data;
  if (!items?.length) return <div className="chart-empty">No data</div>;

  const total = items.reduce((s, i) => s + i.value, 0);
  const PALETTE = ["#4cc2ff", "#3dd68c", "#e4b349", "#ff6057", "#b77fff", "#ff9f43", "#54a0ff", "#5f27cd"];
  const cx = 90, cy = 90, r = 75, inner = donut ? 38 : 0;

  let angle = -Math.PI / 2;
  const slices = items.map((item, idx) => {
    const sweep = (item.value / total) * 2 * Math.PI;
    const a1 = angle, a2 = angle + sweep;
    angle = a2;
    const lg = sweep > Math.PI ? 1 : 0;
    const x1 = cx + r * Math.cos(a1), y1 = cy + r * Math.sin(a1);
    const x2 = cx + r * Math.cos(a2), y2 = cy + r * Math.sin(a2);
    const ix1 = cx + inner * Math.cos(a1), iy1 = cy + inner * Math.sin(a1);
    const ix2 = cx + inner * Math.cos(a2), iy2 = cy + inner * Math.sin(a2);
    const d = donut
      ? `M ${ix1} ${iy1} L ${x1} ${y1} A ${r} ${r} 0 ${lg} 1 ${x2} ${y2} L ${ix2} ${iy2} A ${inner} ${inner} 0 ${lg} 0 ${ix1} ${iy1} Z`
      : `M ${cx} ${cy} L ${x1} ${y1} A ${r} ${r} 0 ${lg} 1 ${x2} ${y2} Z`;
    return { d, color: item.color ?? PALETTE[idx % PALETTE.length], item, pct: ((item.value / total) * 100).toFixed(1) };
  });

  return (
    <div className="pie-chart-wrap">
      <svg viewBox="0 0 180 180" className="pie-svg">
        {slices.map((s, i) => (
          <path key={i} d={s.d} fill={s.color} stroke="rgba(0,0,0,0.3)" strokeWidth="1">
            <title>{`${s.item.label}: ${s.pct}%`}</title>
          </path>
        ))}
      </svg>
      <div className="pie-legend">
        {slices.map((s, i) => (
          <div key={i} className="pie-legend-row">
            <span className="pie-swatch" style={{ background: s.color }} />
            <span className="pie-label">{s.item.label}</span>
            <span className="pie-pct">{s.pct}%</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function GaugeView({ data }: { data: Extract<ViewNode, { type: "gauge" }>["data"] }) {
  const { value, min, max, unit = "", label } = data;
  const pct = Math.max(0, Math.min(1, (value - min) / (max - min)));
  const START = Math.PI * 0.75, END = Math.PI * 2.25, SWEEP = END - START;
  const trackAngle = START + pct * SWEEP;
  const r = 60, cx = 80, cy = 80;
  const arcPath = (a1: number, a2: number) => {
    const x1 = cx + r * Math.cos(a1), y1 = cy + r * Math.sin(a1);
    const x2 = cx + r * Math.cos(a2), y2 = cy + r * Math.sin(a2);
    const lg = a2 - a1 > Math.PI ? 1 : 0;
    return `M ${x1} ${y1} A ${r} ${r} 0 ${lg} 1 ${x2} ${y2}`;
  };
  const color = pct > 0.9 ? "#ff6057" : pct > 0.8 ? "#e4b349" : "#3dd68c";

  return (
    <div className="gauge-wrap">
      <svg viewBox="0 0 160 110" className="gauge-svg">
        <path d={arcPath(START, END)} fill="none" stroke="rgba(255,255,255,0.08)" strokeWidth="10" strokeLinecap="round" />
        {pct > 0 && <path d={arcPath(START, trackAngle)} fill="none" stroke={color} strokeWidth="10" strokeLinecap="round" />}
        <text x={cx} y={cy + 8} textAnchor="middle" fontSize="20" fontWeight="700" fill={color}>
          {typeof value === "number" ? (value % 1 === 0 ? value : value.toFixed(1)) : value}{unit}
        </text>
        {label && <text x={cx} y={cy + 24} textAnchor="middle" fontSize="9" fill="rgba(255,255,255,0.45)">{label}</text>}
        <text x={cx - r - 2} y={cy + 18} textAnchor="end" fontSize="8" fill="rgba(255,255,255,0.3)">{min}{unit}</text>
        <text x={cx + r + 2} y={cy + 18} textAnchor="start" fontSize="8" fill="rgba(255,255,255,0.3)">{max}{unit}</text>
      </svg>
    </div>
  );
}

function TimelineView({ data }: { data: Extract<ViewNode, { type: "timeline" }>["data"] }) {
  const STATUS_COLOR: Record<string, string> = { success: "#3dd68c", error: "#ff6057", warn: "#e4b349", info: "#4cc2ff" };
  return (
    <div className="timeline">
      {data.events.map((ev, i) => (
        <div key={i} className="tl-row">
          <div className="tl-left">
            <span className="tl-dot" style={{ background: STATUS_COLOR[ev.status ?? "info"] }} />
            {i < data.events.length - 1 && <span className="tl-line" />}
          </div>
          <div className="tl-body">
            <div className="tl-header">
              <span className="tl-label">{ev.label}</span>
              <span className="tl-time">{ev.time}</span>
            </div>
            {ev.detail && <div className="tl-detail">{ev.detail}</div>}
          </div>
        </div>
      ))}
    </div>
  );
}

function FormView({ sessionId, view, bridge }: {
  sessionId: string;
  view: Extract<ViewNode, { type: "form" }>;
  bridge: Window["antiTerminal"] | undefined;
}) {
  const { fields, submitCommand, submitLabel = "Run" } = view.data;
  const [values, setValues] = useState<Record<string, string>>(() => {
    const init: Record<string, string> = {};
    for (const f of fields) init[f.name] = f.defaultValue ?? (f.type === "checkbox" ? "false" : "");
    return init;
  });
  const [output, setOutput] = useState<string | null>(null);
  const [running, setRunning] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!bridge) return;
    const cmd = submitCommand.replace(/\{\{(\w+)\}\}/g, (_, k) => values[k] ?? "");
    setRunning(true);
    try {
      const r = await bridge.runShell(cmd, sessionId);
      setOutput(
        r.status === "pending-approval"
          ? "Approval required above."
          : [r.stdout.trim(), r.stderr.trim()].filter(Boolean).join("\n") || "(no output)"
      );
    } finally {
      setRunning(false);
    }
  }

  return (
    <form className="form-view" onSubmit={(e) => void handleSubmit(e)}>
      {fields.map((f) => (
        <div key={f.name} className="form-row">
          <label className="form-label">{f.label}{f.required && <span className="form-req"> *</span>}</label>
          {f.type === "select" ? (
            <select className="form-input" value={values[f.name]} onChange={(e) => setValues((v) => ({ ...v, [f.name]: e.target.value }))}>
              {(f.options ?? []).map((opt) => <option key={opt}>{opt}</option>)}
            </select>
          ) : f.type === "checkbox" ? (
            <input type="checkbox" className="form-checkbox" checked={values[f.name] === "true"} onChange={(e) => setValues((v) => ({ ...v, [f.name]: String(e.target.checked) }))} />
          ) : f.type === "textarea" ? (
            <textarea className="form-textarea" value={values[f.name]} placeholder={f.placeholder} onChange={(e) => setValues((v) => ({ ...v, [f.name]: e.target.value }))} />
          ) : (
            <input type={f.type} className="form-input" value={values[f.name]} placeholder={f.placeholder} required={f.required} onChange={(e) => setValues((v) => ({ ...v, [f.name]: e.target.value }))} />
          )}
        </div>
      ))}
      <button type="submit" className="form-submit" disabled={running}>{running ? "Running…" : submitLabel}</button>
      {output !== null && <pre className="form-output">{output}</pre>}
    </form>
  );
}

function ProgressView({ data }: { data: Extract<ViewNode, { type: "progress" }>["data"] }) {
  if (data.steps?.length) {
    const STATUS_ICON: Record<string, string> = { done: "✓", active: "●", pending: "○", error: "✗" };
    const STATUS_CLS: Record<string, string> = { done: "ps-done", active: "ps-active", pending: "ps-pending", error: "ps-error" };
    return (
      <div className="progress-steps">
        {data.steps.map((s, i) => (
          <div key={i} className={`progress-step ${STATUS_CLS[s.status]}`}>
            <span className="ps-icon">{STATUS_ICON[s.status]}</span>
            <div className="ps-body">
              <span className="ps-label">{s.label}</span>
              {s.detail && <span className="ps-detail">{s.detail}</span>}
            </div>
          </div>
        ))}
      </div>
    );
  }
  const pct = Math.max(0, Math.min(100, ((data.value ?? 0) / (data.max ?? 100)) * 100));
  return (
    <div className="progress-bar-wrap">
      {data.label && <div className="progress-bar-label">{data.label} <span>{pct.toFixed(0)}%</span></div>}
      <div className="progress-bar-track"><div className="progress-bar-fill" style={{ width: `${pct}%` }} /></div>
    </div>
  );
}

function AlertView({ data }: { data: Extract<ViewNode, { type: "alert" }>["data"] }) {
  const ICONS: Record<string, string> = { info: "ℹ", success: "✓", warn: "⚠", error: "✗" };
  return (
    <div className={`alert-view alert-${data.level}`}>
      <span className="alert-icon">{ICONS[data.level]}</span>
      <div className="alert-body">
        <div className="alert-message">{data.message}</div>
        {data.detail && <div className="alert-detail">{data.detail}</div>}
      </div>
    </div>
  );
}

function ImageView({ data }: { data: Extract<ViewNode, { type: "image" }>["data"] }) {
  const src = data.src.startsWith("/") || data.src.match(/^[A-Za-z]:\\/)
    ? `file://${data.src}`
    : data.src;
  return (
    <div className="image-view">
      <img src={src} alt={data.alt ?? ""} className="image-img" />
      {data.caption && <div className="image-caption">{data.caption}</div>}
    </div>
  );
}

function KanbanView({ data }: { data: Extract<ViewNode, { type: "kanban" }>["data"] }) {
  return (
    <div className="kanban-board">
      {data.columns.map((col, ci) => (
        <div key={ci} className="kanban-col">
          <div className="kanban-col-header" style={col.color ? { borderTopColor: col.color } : undefined}>
            <span>{col.label}</span>
            <span className="kanban-count">{col.cards.length}</span>
          </div>
          <div className="kanban-cards">
            {col.cards.map((card) => (
              <div key={card.id} className="kanban-card">
                <div className="kanban-card-title">{card.title}</div>
                {card.body && <div className="kanban-card-body">{card.body}</div>}
                {card.tags?.length ? (
                  <div className="kanban-tags">{card.tags.map((t) => <span key={t} className="kanban-tag">{t}</span>)}</div>
                ) : null}
              </div>
            ))}
            {col.cards.length === 0 && <div className="kanban-empty">Empty</div>}
          </div>
        </div>
      ))}
    </div>
  );
}

function FileTreeView({ data }: { data: Extract<ViewNode, { type: "file-tree" }>["data"] }) {
  return <div className="file-tree">{data.nodes.map((n, i) => <FTNode key={i} node={n} depth={0} />)}</div>;
}

function FTNode({ node, depth }: { node: { name: string; type: string; children?: { name: string; type: string; children?: unknown[] }[] }; depth: number }) {
  const [open, setOpen] = useState(depth < 2);
  const isDir = node.type === "dir";
  const ext = node.name.split(".").pop() ?? "";
  const fileIcon = ["ts", "tsx", "js", "jsx"].includes(ext) ? "📄" : ["json", "yaml", "yml", "toml"].includes(ext) ? "📋" : ["png", "jpg", "svg", "gif"].includes(ext) ? "🖼" : "📄";

  return (
    <div className="ft-node" style={{ paddingLeft: `${depth * 14}px` }}>
      <div className="ft-row" onClick={() => isDir && setOpen((o) => !o)} style={isDir ? { cursor: "pointer" } : undefined}>
        <span className="ft-icon">{isDir ? (open ? "▾ 📁" : "▸ 📁") : fileIcon}</span>
        <span className="ft-name">{node.name}</span>
      </div>
      {isDir && open && node.children?.map((child, i) => (
        <FTNode key={i} node={child as Parameters<typeof FTNode>[0]["node"]} depth={depth + 1} />
      ))}
    </div>
  );
}

function MetricView({ data }: { data: Extract<ViewNode, { type: "metric" }>["data"] }) {
  const TREND_ICON: Record<string, string> = { up: "↑", down: "↓", neutral: "–" };
  const TREND_CLS: Record<string, string> = { up: "metric-up", down: "metric-down", neutral: "metric-neutral" };
  return (
    <div className="metric-view">
      <div className="metric-value">{data.value}</div>
      <div className="metric-label">{data.label}</div>
      {(data.change || data.subtext) && (
        <div className="metric-footer">
          {data.change && data.trend && (
            <span className={`metric-change ${TREND_CLS[data.trend]}`}>
              {TREND_ICON[data.trend]} {data.change}
            </span>
          )}
          {data.subtext && <span className="metric-subtext">{data.subtext}</span>}
        </div>
      )}
    </div>
  );
}

function CardGridView({ data }: { data: Extract<ViewNode, { type: "card-grid" }>["data"] }) {
  return (
    <div className="card-grid">
      {data.cards.map((card, i) => (
        <div key={i} className="grid-card" style={card.accent ? { borderLeftColor: card.accent } : undefined}>
          <div className="grid-card-title">{card.title}</div>
          {card.body && <div className="grid-card-body">{card.body}</div>}
          {card.tags?.length ? (
            <div className="grid-card-tags">{card.tags.map((t) => <span key={t} className="grid-tag">{t}</span>)}</div>
          ) : null}
          {card.footer && <div className="grid-card-footer">{card.footer}</div>}
        </div>
      ))}
    </div>
  );
}

function HeatmapView({ data }: { data: Extract<ViewNode, { type: "heatmap" }>["data"] }) {
  const { rows, cols, values, colorScale = "blue" } = data;
  const flat = values.flat();
  const vMin = Math.min(...flat), vMax = Math.max(...flat);
  const norm = (v: number) => vMax === vMin ? 0.5 : (v - vMin) / (vMax - vMin);
  const cellColor = (v: number) => {
    const t = norm(v);
    if (colorScale === "green") return `rgba(61,214,140,${0.1 + t * 0.85})`;
    if (colorScale === "red") return `rgba(255,96,87,${0.1 + t * 0.85})`;
    return `rgba(76,194,255,${0.1 + t * 0.85})`;
  };
  return (
    <div className="heatmap-wrap">
      <table className="heatmap-table">
        <thead>
          <tr>
            <th />
            {cols.map((c, i) => <th key={i} className="hm-col-label">{c}</th>)}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, ri) => (
            <tr key={ri}>
              <td className="hm-row-label">{row}</td>
              {cols.map((_, ci) => {
                const v = values[ri]?.[ci] ?? 0;
                return <td key={ci} className="hm-cell" style={{ background: cellColor(v) }} title={String(v)}>{v}</td>;
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ── Utilities ───────────────────────────────────── */

function abbreviatePath(p: string): string {
  const home = p.match(/^\/Users\/[^/]+/)?.[0] ?? p.match(/^\/home\/[^/]+/)?.[0];
  return home ? "~" + p.slice(home.length) : p;
}

function fmtTokens(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k tokens`;
  return `${n} tokens`;
}

function relativeTime(ts: number): string {
  const diff = Date.now() - ts;
  const m = Math.floor(diff / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  return `${Math.floor(d / 30)}mo ago`;
}
