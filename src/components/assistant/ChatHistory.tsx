"use client";

import { MessageSquarePlus, Pencil, Search, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { ConfirmDialog, PromptDialog } from "@/components/Dialog";
import { Button, cx, Notice, Spinner } from "@/components/ui";
import { getConversations, type ConversationMeta } from "@/lib/persistence/conversations";
import { toStorageError } from "@/lib/persistence/repository";
import { useApp } from "@/state/AppProvider";

type ListState = { items: ConversationMeta[]; unreadable: string[]; at: number };
type DialogState = { kind: "rename"; meta: ConversationMeta } | { kind: "delete"; meta: ConversationMeta } | { kind: "clear" } | null;

const DAY = 86_400_000;

function when(iso: string, ref: number) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return ref - d.getTime() < DAY && new Date(ref).toDateString() === d.toDateString()
    ? d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })
    : d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** Conversation list with search, open, rename, delete and clear-all. Used in the sidebar and drawer. */
export default function ChatHistory({ onNavigate }: { onNavigate?: () => void }) {
  const { state, chat } = useApp();
  const [list, setList] = useState<ListState | null>(null);
  const [query, setQuery] = useState("");
  const [dialog, setDialog] = useState<DialogState>(null);
  const [error, setError] = useState<string | null>(null);
  const [opening, setOpening] = useState<string | null>(null);
  const activeId = state.chat.id;

  const listRevision = state.chat.listRevision;
  useEffect(() => {
    let cancelled = false;
    getConversations()
      .list()
      .then(
        (r) => !cancelled && setList({ ...r, at: Date.now() }),
        (e) => {
          if (cancelled) return;
          setList({ items: [], unreadable: [], at: Date.now() });
          setError(toStorageError(e).message);
        },
      );
    return () => {
      cancelled = true;
    };
  }, [listRevision]);

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const items = (list?.items ?? []).filter((m) => !q || `${m.title} ${m.preview} ${m.vehicleLabel ?? ""}`.toLowerCase().includes(q));
    const cutoff = (list?.at ?? 0) - 7 * DAY;
    return [
      { label: "Recent", items: items.filter((m) => Date.parse(m.updatedAt) >= cutoff) },
      { label: "Older", items: items.filter((m) => Date.parse(m.updatedAt) < cutoff) },
    ].filter((g) => g.items.length);
  }, [list, query]);

  const open = async (m: ConversationMeta) => {
    setOpening(m.id);
    const r = await chat.open(m.id);
    setOpening(null);
    if (!r.ok) setError(`“${m.title}”: ${r.message}`);
    else onNavigate?.();
  };

  const total = list?.items.length ?? 0;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="space-y-2 p-3">
        <Button
          variant="primary"
          size="sm"
          className="w-full"
          onClick={() => {
            chat.newChat();
            onNavigate?.();
          }}
        >
          <MessageSquarePlus size={15} aria-hidden /> New chat
        </Button>
        {total > 0 && (
          <label className="relative block">
            <span className="sr-only">Search conversations</span>
            <Search size={14} aria-hidden className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-faint" />
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search conversations"
              className="h-8 w-full rounded-md border border-line-strong bg-bg pr-2 pl-8 text-[13px] text-ink outline-none placeholder:text-faint focus:border-accent"
            />
          </label>
        )}
      </div>

      <nav aria-label="Conversations" className="scrollbar-thin min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {error && (
          <div className="px-1 pb-2">
            <Notice tone="error" action={<Button size="sm" variant="ghost" onClick={() => setError(null)}>Dismiss</Button>}>
              {error}
            </Notice>
          </div>
        )}
        {!list ? (
          <p className="flex items-center gap-2 px-2 py-3 text-xs text-muted">
            <Spinner /> Loading conversations…
          </p>
        ) : total === 0 ? (
          <p className="px-2 py-3 text-xs leading-5 text-faint">No saved conversations yet. Chats are saved automatically as you talk.</p>
        ) : groups.length === 0 ? (
          <p className="px-2 py-3 text-xs text-faint">No conversations match “{query.trim()}”.</p>
        ) : (
          groups.map((g) => (
            <section key={g.label} aria-label={`${g.label} conversations`}>
              <h3 className="px-2 pt-2 pb-1 text-[10.5px] font-medium tracking-wide text-faint uppercase">{g.label}</h3>
              <ul className="space-y-0.5">
                {g.items.map((m) => {
                  const active = m.id === activeId;
                  return (
                    <li key={m.id} className={cx("group animate-fade relative rounded-md transition-colors", active ? "bg-raised" : "hover:bg-raised/60")} data-testid="chat-item">
                      {active && <span aria-hidden className="absolute inset-y-1.5 left-0 w-[2px] rounded-full bg-accent" />}
                      <button
                        type="button"
                        onClick={() => void open(m)}
                        aria-current={active ? "true" : undefined}
                        disabled={opening === m.id}
                        className="block w-full min-w-0 rounded-md py-2 pr-16 pl-2.5 text-left"
                      >
                        <span className={cx("block truncate text-[13px]", active ? "font-medium text-ink" : "text-ink/90")}>{m.title}</span>
                        <span className="block truncate text-[11.5px] text-faint">
                          {when(m.updatedAt, list!.at)} · {m.vehicleLabel ?? m.preview ?? ""}
                        </span>
                      </button>
                      <div className="absolute top-1.5 right-1 flex opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100 [@media(hover:none)]:opacity-100">
                        <button
                          type="button"
                          aria-label={`Rename ${m.title}`}
                          onClick={() => setDialog({ kind: "rename", meta: m })}
                          className="grid h-7 w-7 place-items-center rounded-sm text-faint hover:bg-hover hover:text-ink"
                        >
                          <Pencil size={13} aria-hidden />
                        </button>
                        <button
                          type="button"
                          aria-label={`Delete ${m.title}`}
                          onClick={() => setDialog({ kind: "delete", meta: m })}
                          className="grid h-7 w-7 place-items-center rounded-sm text-faint hover:bg-hover hover:text-error"
                        >
                          <Trash2 size={13} aria-hidden />
                        </button>
                      </div>
                    </li>
                  );
                })}
              </ul>
            </section>
          ))
        )}
        {list && list.unreadable.length > 0 && (
          <p className="px-2 pt-2 text-[11.5px] leading-4 text-warning">
            {list.unreadable.length} damaged conversation{list.unreadable.length > 1 ? "s" : ""} couldn&apos;t be shown and {list.unreadable.length > 1 ? "were" : "was"} left untouched.
          </p>
        )}
      </nav>

      <div className="space-y-2 border-t border-line p-3">
        <p className="text-[11px] leading-4 text-faint">
          Chats are stored in this browser only. Messages you send to the assistant are processed by Google Gemini.
        </p>
        {total > 0 && (
          <Button size="sm" variant="ghost" className="h-7 w-full justify-start px-2 text-xs hover:text-error" onClick={() => setDialog({ kind: "clear" })}>
            <Trash2 size={13} aria-hidden /> Clear all chats
          </Button>
        )}
      </div>

      <PromptDialog
        open={dialog?.kind === "rename"}
        title="Rename conversation"
        label="Conversation title"
        initial={dialog?.kind === "rename" ? dialog.meta.title : ""}
        confirmLabel="Rename"
        onSubmit={async (title) => {
          if (dialog?.kind !== "rename") return;
          const r = await chat.rename(dialog.meta.id, title);
          setDialog(null);
          if (!r.ok) setError(r.message);
        }}
        onCancel={() => setDialog(null)}
      />
      <ConfirmDialog
        open={dialog?.kind === "delete"}
        title="Delete this conversation?"
        description={dialog?.kind === "delete" ? <>“{dialog.meta.title}” will be permanently removed from this browser. Saved analyses it links to are not affected.</> : null}
        confirmLabel="Delete conversation"
        onConfirm={async () => {
          if (dialog?.kind !== "delete") return;
          const r = await chat.remove(dialog.meta.id);
          setDialog(null);
          if (!r.ok) setError(r.message);
        }}
        onCancel={() => setDialog(null)}
      />
      <ConfirmDialog
        open={dialog?.kind === "clear"}
        title="Delete all conversations?"
        description={`All ${total} conversation${total === 1 ? "" : "s"} will be permanently removed from this browser. Saved analyses are not affected.`}
        confirmLabel="Delete all chats"
        onConfirm={async () => {
          const r = await chat.clearAll();
          setDialog(null);
          if (!r.ok) setError(r.message);
        }}
        onCancel={() => setDialog(null)}
      />
    </div>
  );
}
