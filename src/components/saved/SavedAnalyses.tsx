"use client";

import { Copy, Download, FolderOpen, History, Pencil, Search, Trash2, Upload } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ConfirmDialog, PromptDialog } from "@/components/Dialog";
import LoadingStage from "@/components/LoadingStage";
import { FeasibilityBadge } from "@/components/results/FeasibilityPanel";
import { Button, cx, Notice, ScenarioTag, Segmented, Spinner } from "@/components/ui";
import { download } from "@/lib/download";
import { buildBackup, ImportError, MAX_IMPORT_BYTES, planImport } from "@/lib/persistence/backup";
import { getRepository, toStorageError, type ListResult } from "@/lib/persistence/repository";
import type { SavedAnalysis, SavedMeta } from "@/lib/persistence/schema";
import { duplicateRecord, isHistorical } from "@/lib/persistence/snapshot";
import { ENGINE_VERSION } from "@/lib/physics/analysis";
import { toDisplay, unitLabel, type UnitSystem } from "@/lib/units";
import { useApp } from "@/state/AppProvider";
import type { Action } from "@/state/reducer";

type Sort = "newest" | "oldest";
type Flash = { tone: "info" | "success" | "warning" | "error"; text: ReactNode; action?: ReactNode };
type DialogState =
  | { kind: "rename"; meta: SavedMeta }
  | { kind: "delete"; meta: SavedMeta }
  | { kind: "open"; meta: SavedMeta }
  | { kind: "deleteAll" }
  | { kind: "removeUnreadable" }
  | null;

/** File contents as text (FileReader fallback for browsers without Blob.text). */
function readText(file: File): Promise<string> {
  if (typeof file.text === "function") return file.text();
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result ?? ""));
    r.onerror = () => reject(r.error);
    r.readAsText(file);
  });
}

const engineLabel = (v: string) => v.replace(/^autodyn-physics\//, "v");

function formatDate(iso: string) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString(undefined, { year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function power(kw: number | null, units: UnitSystem) {
  if (kw == null) return "—";
  return `${Math.round(toDisplay("power", kw, units)).toLocaleString("en-US")} ${unitLabel("power", units)}`;
}

function accel(meta: SavedMeta, scenario: "stock" | "modified", units: UnitSystem) {
  const s = meta.summary;
  const v = units === "metric" ? (scenario === "stock" ? s.stock0100KphS : s.modified0100KphS) : scenario === "stock" ? s.stock060S : s.modified060S;
  return v == null ? "—" : `${v.toFixed(2)} s`;
}

function SavedRow({
  meta,
  units,
  active,
  opening,
  onOpen,
  onRename,
  onDuplicate,
  onDelete,
}: {
  meta: SavedMeta;
  units: UnitSystem;
  active: boolean;
  opening: boolean;
  onOpen: () => void;
  onRename: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
}) {
  const s = meta.summary;
  const historical = isHistorical(meta);
  const accelLabel = units === "metric" ? "0–100 km/h" : "0–60 mph";
  return (
    <li className="animate-enter px-4 py-3.5 sm:px-5" data-testid="saved-row" data-id={meta.id}>
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-3">
        <div className="min-w-0 flex-1 basis-[260px]">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <h3 className="min-w-0 truncate text-[14.5px] font-semibold tracking-tight text-ink">{meta.title}</h3>
            {active && <span className="rounded-sm border border-accent/40 px-1.5 text-[10.5px] font-medium tracking-wide text-accent uppercase">In workspace</span>}
            {historical && (
              <span
                className="inline-flex items-center gap-1 rounded-sm border border-warning/40 px-1.5 text-[10.5px] font-medium tracking-wide text-warning uppercase"
                title={`Computed with ${meta.engineVersion}; the current engine is ${ENGINE_VERSION}.`}
              >
                <History size={11} aria-hidden /> Historical · {engineLabel(meta.engineVersion)}
              </span>
            )}
            {meta.origin === "import" && <span className="rounded-sm border border-line-strong px-1.5 text-[10.5px] font-medium tracking-wide text-muted uppercase">Imported</span>}
          </div>
          <p className="mt-0.5 truncate text-[13px] text-muted">{s.vehicle}</p>
          <p className="mt-0.5 text-xs text-faint">
            <time dateTime={meta.updatedAt} title={`Created ${formatDate(meta.createdAt)}`}>
              {formatDate(meta.updatedAt)}
            </time>
            {" · "}
            {s.scenarios === "compare" ? "Stock vs Modified" : "Stock only"}
            {s.changes.length > 0 && ` · ${s.changes.length} change${s.changes.length > 1 ? "s" : ""}`}
          </p>
        </div>

        <dl className="grid min-w-0 grid-cols-[auto_auto_auto] gap-x-4 gap-y-1 text-[12.5px]">
          <dt className="sr-only">Stock</dt>
          <dd className="contents">
            <ScenarioTag scenario="stock" />
            <span className="num text-ink">{power(s.stockPowerKw, units)}</span>
            <span className="num text-muted">
              {accelLabel} {accel(meta, "stock", units)}
            </span>
          </dd>
          {s.scenarios === "compare" && (
            <>
              <dt className="sr-only">Modified</dt>
              <dd className="contents">
                <ScenarioTag scenario="modified" />
                <span className="num text-ink">{power(s.modifiedPowerKw, units)}</span>
                <span className="num text-muted">
                  {accelLabel} {accel(meta, "modified", units)}
                </span>
              </dd>
            </>
          )}
        </dl>
      </div>

      <div className="mt-2.5 flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-1.5 text-xs text-faint" aria-label="Engineering feasibility">
          <span className="sr-only">Feasibility:</span>
          <span className="text-stock">Stock</span>
          <FeasibilityBadge status={s.feasibility.stock} />
          {s.feasibility.modified && (
            <>
              <span className="ml-1 text-modified">Modified</span>
              <FeasibilityBadge status={s.feasibility.modified} />
            </>
          )}
        </div>
        <div className="flex flex-wrap gap-1.5">
          <Button size="sm" variant="primary" onClick={onOpen} disabled={opening} aria-label={`Open ${meta.title}`}>
            {opening ? <Spinner label="Opening" /> : <FolderOpen size={14} aria-hidden />} Open
          </Button>
          <Button size="sm" variant="ghost" onClick={onRename} aria-label={`Rename ${meta.title}`}>
            <Pencil size={14} aria-hidden /> Rename
          </Button>
          <Button size="sm" variant="ghost" onClick={onDuplicate} aria-label={`Duplicate ${meta.title}`}>
            <Copy size={14} aria-hidden /> Duplicate
          </Button>
          <Button size="sm" variant="ghost" className="hover:text-error" onClick={onDelete} aria-label={`Delete ${meta.title}`}>
            <Trash2 size={14} aria-hidden /> Delete
          </Button>
        </div>
      </div>
    </li>
  );
}

export default function SavedAnalyses() {
  const { state, dispatch, saved } = useApp();
  const units = state.ui.units;
  const [list, setList] = useState<ListResult | null>(null);
  const [persistent, setPersistent] = useState(true);
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<Sort>("newest");
  const [flash, setFlash] = useState<Flash | null>(null);
  const [dialog, setDialog] = useState<DialogState>(null);
  const [busy, setBusy] = useState(false);
  const [opening, setOpening] = useState<SavedMeta | null>(null);
  const [showLoader, setShowLoader] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const activeId = state.saved.active?.id ?? null;

  // Reloads whenever saved records change (every mutation dispatches savedListChanged).
  const listRevision = state.saved.listRevision;
  useEffect(() => {
    let cancelled = false;
    const repo = getRepository();
    repo.list().then(
      (r) => {
        if (cancelled) return;
        setList(r);
        setPersistent(repo.persistent);
      },
      (e) => {
        if (cancelled) return;
        setList({ items: [], unreadable: [] });
        setFlash({ tone: "error", text: toStorageError(e).message });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [listRevision]);

  const items = useMemo(() => {
    if (!list) return [];
    const q = query.trim().toLowerCase().replace(/\s+/g, " ");
    const filtered = q ? list.items.filter((m) => `${m.title} ${m.summary.vehicle}`.toLowerCase().includes(q)) : list.items;
    return [...filtered].sort((a, b) => (sort === "newest" ? b.updatedAt.localeCompare(a.updatedAt) : a.updatedAt.localeCompare(b.updatedAt)));
  }, [list, query, sort]);

  const changed = (extra: Omit<Extract<Action, { type: "savedListChanged" }>, "type"> = {}) => dispatch({ type: "savedListChanged", ...extra });

  const openNow = async (meta: SavedMeta) => {
    setOpening(meta);
    const loader = window.setTimeout(() => setShowLoader(true), 200);
    const r = await saved.open(meta.id);
    window.clearTimeout(loader);
    setShowLoader(false);
    setOpening(null);
    if (!r.ok) setFlash({ tone: "error", text: `“${meta.title}”: ${r.message}`, action: <Button size="sm" variant="danger" onClick={() => setDialog({ kind: "delete", meta })}>Delete it</Button> });
  };

  const requestOpen = (meta: SavedMeta) => (saved.unsavedEdits ? setDialog({ kind: "open", meta }) : void openNow(meta));

  const duplicate = async (meta: SavedMeta) => {
    try {
      const repo = getRepository();
      const copy = duplicateRecord(await repo.get(meta.id));
      await repo.put(copy);
      changed();
      setFlash({
        tone: "success",
        text: `Created “${copy.title}”. It's an independent copy — edit and re-run it without touching the original.`,
        action: (
          <Button size="sm" onClick={() => requestOpen({ ...meta, id: copy.id, title: copy.title })}>
            Open copy
          </Button>
        ),
      });
    } catch (e) {
      setFlash({ tone: "error", text: toStorageError(e).message });
    }
  };

  const rename = async (meta: SavedMeta, title: string) => {
    setDialog(null);
    try {
      await getRepository().updateMeta(meta.id, { title, customTitle: true });
      changed({ renamed: { id: meta.id, title } });
      setFlash({ tone: "success", text: `Renamed to “${title}”.` });
    } catch (e) {
      setFlash({ tone: "error", text: toStorageError(e).message });
    }
  };

  const remove = async (meta: SavedMeta) => {
    setBusy(true);
    try {
      await getRepository().delete(meta.id);
      changed({ removed: [meta.id] });
      setFlash({ tone: "info", text: `Deleted “${meta.title}”.` });
    } catch (e) {
      setFlash({ tone: "error", text: toStorageError(e).message });
    } finally {
      setBusy(false);
      setDialog(null);
    }
  };

  const removeAll = async () => {
    setBusy(true);
    try {
      const ids = list?.items.map((m) => m.id) ?? [];
      await getRepository().clear();
      changed({ removed: [...ids, ...(list?.unreadable ?? [])] });
      setFlash({ tone: "info", text: "All saved analyses were deleted. Your current workspace was not changed." });
    } catch (e) {
      setFlash({ tone: "error", text: toStorageError(e).message });
    } finally {
      setBusy(false);
      setDialog(null);
    }
  };

  const removeUnreadable = async () => {
    setBusy(true);
    try {
      await getRepository().deleteMany(list?.unreadable ?? []);
      changed({ removed: list?.unreadable ?? [] });
    } catch (e) {
      setFlash({ tone: "error", text: toStorageError(e).message });
    } finally {
      setBusy(false);
      setDialog(null);
    }
  };

  const exportAll = async () => {
    if (!list?.items.length) return;
    setBusy(true);
    try {
      const repo = getRepository();
      const records: SavedAnalysis[] = [];
      let skipped = 0;
      for (const m of list.items) {
        try {
          records.push(await repo.get(m.id));
        } catch {
          skipped += 1;
        }
      }
      download(`autodyn-analyses-${new Date().toISOString().slice(0, 10)}.json`, buildBackup(records), "application/json");
      setFlash({ tone: "success", text: `Exported ${records.length} analys${records.length === 1 ? "is" : "es"}${skipped ? ` (${skipped} damaged record${skipped > 1 ? "s" : ""} skipped)` : ""}.` });
    } catch (e) {
      setFlash({ tone: "error", text: toStorageError(e).message });
    } finally {
      setBusy(false);
    }
  };

  const importFile = async (file: File) => {
    if (file.size > MAX_IMPORT_BYTES) {
      setFlash({ tone: "error", text: `“${file.name}” is larger than ${MAX_IMPORT_BYTES / 1024 / 1024} MB and was not imported.` });
      return;
    }
    setBusy(true);
    try {
      const plan = planImport(await readText(file), list?.items ?? []);
      if (plan.accepted.length) await getRepository().putMany(plan.accepted);
      changed();
      const parts = [
        `Imported ${plan.accepted.length} analys${plan.accepted.length === 1 ? "is" : "es"}`,
        plan.skipped ? `${plan.skipped} already present` : null,
        plan.reassigned ? `${plan.reassigned} given a new ID to avoid a conflict` : null,
        plan.rejected.length ? `${plan.rejected.length} rejected` : null,
      ].filter(Boolean);
      setFlash({
        tone: plan.rejected.length ? "warning" : plan.accepted.length ? "success" : "info",
        text: (
          <>
            {parts.join(" · ")}.
            {plan.rejected.length > 0 && (
              <ul className="mt-1 list-disc pl-4 text-xs">
                {plan.rejected.slice(0, 5).map((r) => (
                  <li key={r.index}>
                    {r.title ? `“${r.title}”` : `Record ${r.index + 1}`}: {r.reason}
                  </li>
                ))}
              </ul>
            )}
          </>
        ),
      });
    } catch (e) {
      setFlash({ tone: "error", text: e instanceof ImportError ? `Not imported: ${e.message}` : toStorageError(e).message });
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  if (opening && showLoader) return <LoadingStage make={opening.summary.make} label="Opening saved analysis" />;

  const total = list?.items.length ?? 0;
  return (
    <div className="mx-auto max-w-5xl space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-xl font-semibold tracking-tight">Saved Analyses</h1>
          <p className="mt-0.5 text-[13px] text-muted">
            {list ? `${total} saved` : "Loading…"} · every completed analysis is kept automatically. Open one to restore its exact inputs and results.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" onClick={exportAll} disabled={!total || busy}>
            <Download size={14} aria-hidden /> Export backup
          </Button>
          <Button size="sm" onClick={() => fileRef.current?.click()} disabled={busy}>
            <Upload size={14} aria-hidden /> Import backup
          </Button>
          <input
            ref={fileRef}
            type="file"
            accept=".json,application/json"
            className="sr-only"
            tabIndex={-1}
            aria-label="Import a saved-analyses backup file"
            onChange={(e) => {
              const f = e.currentTarget.files?.[0];
              if (f) void importFile(f);
            }}
          />
          <Button size="sm" variant="danger" onClick={() => setDialog({ kind: "deleteAll" })} disabled={!total || busy}>
            <Trash2 size={14} aria-hidden /> Delete all
          </Button>
        </div>
      </div>

      <p className="text-xs leading-5 text-faint">
        Stored only in this browser on this device. Saved analyses don&apos;t sync across devices and are removed if this site&apos;s data is cleared — export a backup to keep a copy.
      </p>
      {!persistent && <Notice tone="warning">This browser isn&apos;t allowing AutoDyn to store data, so analyses are kept only until this tab is closed. Export a backup to keep them.</Notice>}
      {list && list.unreadable.length > 0 && (
        <Notice
          tone="warning"
          action={
            <Button size="sm" variant="ghost" onClick={() => setDialog({ kind: "removeUnreadable" })}>
              Remove them
            </Button>
          }
        >
          {list.unreadable.length} stored record{list.unreadable.length > 1 ? "s are" : " is"} damaged or from an unsupported version and can&apos;t be shown. They were left untouched.
        </Notice>
      )}
      {flash && (
        <Notice
          tone={flash.tone}
          action={
            <div className="flex flex-wrap gap-2">
              {flash.action}
              <Button size="sm" variant="ghost" onClick={() => setFlash(null)}>
                Dismiss
              </Button>
            </div>
          }
        >
          {flash.text}
        </Notice>
      )}

      {total > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <label className="relative min-w-0 flex-1 basis-[220px]">
            <span className="sr-only">Search saved analyses</span>
            <Search size={15} aria-hidden className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-faint" />
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search by vehicle or title"
              className="h-9 w-full rounded-md border border-line-strong bg-bg pr-3 pl-9 text-[13px] text-ink outline-none placeholder:text-faint focus:border-accent"
            />
          </label>
          <Segmented
            label="Sort saved analyses"
            size="sm"
            value={sort}
            onChange={setSort}
            options={[
              { value: "newest", label: "Newest" },
              { value: "oldest", label: "Oldest" },
            ]}
          />
        </div>
      )}

      {!list ? (
        <div className="flex items-center gap-2 py-8 text-sm text-muted">
          <Spinner /> Loading saved analyses…
        </div>
      ) : total === 0 ? (
        <div className="rounded-lg border border-dashed border-line-strong px-5 py-10 text-center">
          <p className="text-[14px] font-medium text-ink">No saved analyses yet</p>
          <p className="mx-auto mt-1 max-w-md text-[13px] leading-5 text-muted">
            Every analysis you run is saved here automatically, with its inputs, results and feasibility assessment. You can also import a backup file.
          </p>
          <Button className="mt-4" variant="primary" onClick={() => dispatch({ type: "setMode", mode: "manual" })}>
            Start in Manual Setup
          </Button>
        </div>
      ) : items.length === 0 ? (
        <p className="py-6 text-center text-[13px] text-muted">No saved analyses match “{query.trim()}”.</p>
      ) : (
        <ul className={cx("divide-y divide-line rounded-lg border border-line bg-surface")} aria-label="Saved analyses">
          {items.map((m) => (
            <SavedRow
              key={m.id}
              meta={m}
              units={units}
              active={m.id === activeId}
              opening={opening?.id === m.id}
              onOpen={() => requestOpen(m)}
              onRename={() => setDialog({ kind: "rename", meta: m })}
              onDuplicate={() => void duplicate(m)}
              onDelete={() => setDialog({ kind: "delete", meta: m })}
            />
          ))}
        </ul>
      )}

      <PromptDialog
        open={dialog?.kind === "rename"}
        title="Rename analysis"
        label="Analysis title"
        initial={dialog?.kind === "rename" ? dialog.meta.title : ""}
        confirmLabel="Rename"
        onSubmit={(title) => dialog?.kind === "rename" && void rename(dialog.meta, title)}
        onCancel={() => setDialog(null)}
      />
      <ConfirmDialog
        open={dialog?.kind === "delete"}
        title="Delete this analysis?"
        description={dialog?.kind === "delete" ? <>“{dialog.meta.title}” ({dialog.meta.summary.vehicle}) will be permanently removed from this browser.</> : null}
        confirmLabel="Delete analysis"
        busy={busy}
        onConfirm={() => dialog?.kind === "delete" && void remove(dialog.meta)}
        onCancel={() => setDialog(null)}
      />
      <ConfirmDialog
        open={dialog?.kind === "deleteAll"}
        title={`Delete all ${total} saved analyses?`}
        description="This permanently removes every saved analysis from this browser. It can't be undone. Your current workspace is not affected."
        confirmLabel={`Delete all ${total}`}
        busy={busy}
        onConfirm={() => void removeAll()}
        onCancel={() => setDialog(null)}
        extra={
          <Button size="sm" onClick={exportAll} disabled={busy}>
            <Download size={14} aria-hidden /> Export a backup first
          </Button>
        }
      />
      <ConfirmDialog
        open={dialog?.kind === "removeUnreadable"}
        title="Remove damaged records?"
        description="Records that can't be read will be permanently removed. Readable analyses are not affected."
        confirmLabel="Remove damaged records"
        busy={busy}
        onConfirm={() => void removeUnreadable()}
        onCancel={() => setDialog(null)}
      />
      <ConfirmDialog
        open={dialog?.kind === "open"}
        title="Discard current changes?"
        description="Your workspace has changes that haven't been run and saved. Opening this analysis replaces them. Saved analyses are not affected."
        confirmLabel="Discard and open"
        tone="primary"
        onConfirm={() => {
          if (dialog?.kind === "open") void openNow(dialog.meta);
          setDialog(null);
        }}
        onCancel={() => setDialog(null)}
      />
    </div>
  );
}
