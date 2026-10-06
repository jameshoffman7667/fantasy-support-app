import * as api from "../api.js";
import { ArrowLeft, ChevronRight, Copy, Loader2, Trophy } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Avatar, ConfirmPush, SectionLabel } from "../ui/common.jsx";
import { C, fmtWhen, inputStyle } from "../ui/theme.js";

/* ------------------------------------------------------------------ */
/*  v3.8 COMMISH: Charters + Best Ball                                  */
/* ------------------------------------------------------------------ */
const STATUS_COLOR = { red: C.major, yellow: C.minor, ok: C.ok };
const STATUS_TEXT = { red: "Due within a week", yellow: "Due within a month", ok: "Nothing due soon" };
const SETTING_LABEL = { waiver_budget: "FAAB budget", disable_adds: "adds locked", trade_deadline: "trade deadline", playoff_week_start: "playoff start", playoff_teams: "playoff teams", waiver_type: "waiver type", daily_waivers: "daily waivers", max_keepers: "keepers", taxi_slots: "taxi slots", reserve_slots: "IR slots", draft_rounds: "draft rounds" };
const newId = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const fmtDue = (d) => (d ? new Date(`${d}T12:00:00`).toLocaleDateString([], { weekday: "short", month: "short", day: "numeric", year: "numeric" }) : "No date");
const card = { background: C.surface, border: `1px solid ${C.border}` };
const btn = (color = C.brand) => ({ color, border: `1px solid ${color}88` });

function readFileBase64(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(",")[1] || "");
    r.onerror = () => reject(new Error("Couldn't read the file."));
    r.readAsDataURL(file);
  });
}

/* ---------------- source form (link or upload) ---------------- */
function SourceForm({ leagueId, onDone, compact = false }) {
  const [link, setLink] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const run = async (fn) => {
    setBusy(true);
    setErr(null);
    try {
      onDone(await fn());
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-2" data-charter-source-form>
      <div className="flex gap-2">
        <input value={link} onChange={(e) => setLink(e.target.value)} placeholder="Google Docs / Drive link (Anyone with the link can view)" style={inputStyle} className="flex-1 min-w-0 rounded px-2 py-1.5 text-sm outline-none" aria-label="Charter link" data-charter-link />
        <button type="button" disabled={!leagueId || !link.trim() || busy} onClick={() => run(() => api.setCharterLink(leagueId, link.trim()))} style={{ background: C.brand, color: C.text, opacity: !leagueId || !link.trim() || busy ? 0.5 : 1 }} className="rounded px-3 py-1.5 text-sm shrink-0" data-charter-read>
          {busy ? "Reading…" : "Read"}
        </button>
      </div>
      <label className="flex flex-col gap-1 text-xs" style={{ color: C.textMuted }}>
        <span>{compact ? "Or upload a file:" : "Or upload the charter (PDF, Word, text or Markdown, up to 10 MB):"}</span>
        <input
          type="file"
          accept=".pdf,.docx,.txt,.md,application/pdf,text/plain,text/markdown,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
          disabled={!leagueId || busy}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (!f) return;
            if (f.size > 10 * 1024 * 1024) return setErr("That file is larger than 10 MB.");
            run(async () => api.uploadCharter(leagueId, { name: f.name, mime: f.type, base64: await readFileBase64(f) }));
          }}
          className="text-xs"
          data-charter-upload
        />
      </label>
      {busy && <div className="text-xs flex items-center gap-1.5" style={{ color: C.textMuted }}><Loader2 size={12} className="animate-spin" /> Reading the charter and building your checklist…</div>}
      {err && <div className="text-xs" style={{ color: C.major }}>{err}</div>}
    </div>
  );
}

/* ---------------- actions ---------------- */
function ActionEditor({ a, onSave, onCancel }) {
  const [d, setD] = useState({ title: a.title || "", description: a.description || "", due: a.due || "", repeat: a.repeat === "yearly" });
  return (
    <div className="space-y-1.5 rounded-md p-2" style={{ background: C.surfaceRaised, border: `1px solid ${C.border}` }} data-action-editor>
      <input value={d.title} onChange={(e) => setD({ ...d, title: e.target.value })} placeholder="Action" style={inputStyle} className="w-full rounded px-2 py-1 text-sm outline-none" aria-label="Action title" />
      <textarea value={d.description} onChange={(e) => setD({ ...d, description: e.target.value })} placeholder="Details (optional)" rows={2} style={inputStyle} className="w-full rounded px-2 py-1 text-xs outline-none" aria-label="Action details" />
      <div className="flex items-center gap-2 flex-wrap text-xs" style={{ color: C.textMuted }}>
        <input type="date" value={d.due} onChange={(e) => setD({ ...d, due: e.target.value })} style={inputStyle} className="rounded px-2 py-1 text-xs" aria-label="Due date" />
        <label className="flex items-center gap-1"><input type="checkbox" checked={d.repeat} onChange={(e) => setD({ ...d, repeat: e.target.checked })} /> Every year</label>
        <span className="flex-1" />
        <button type="button" onClick={onCancel} style={{ color: C.textMuted }} className="underline">Cancel</button>
        <button type="button" disabled={!d.title.trim()} onClick={() => onSave({ ...a, title: d.title.trim(), description: d.description, due: d.due || null, repeat: d.repeat ? "yearly" : null })} style={{ background: C.brand, color: C.text, opacity: d.title.trim() ? 1 : 0.5 }} className="rounded px-2.5 py-1">Save</button>
      </div>
    </div>
  );
}

function ActionsList({ charter, onSave }) {
  const [editing, setEditing] = useState(null); // action id or "new"
  const [showDone, setShowDone] = useState(false);
  const actions = charter.actions || [];
  const open = actions.filter((a) => !a.done).sort((a, b) => (a.due || "9999").localeCompare(b.due || "9999"));
  const done = actions.filter((a) => a.done).sort((a, b) => (b.doneAt || 0) - (a.doneAt || 0));
  const save = (list) => onSave(list);
  const update = (a) => save(actions.map((x) => (x.id === a.id ? a : x)));
  const today = new Date().toLocaleDateString("en-CA");
  const dueColor = (d) => {
    if (!d) return C.textFaint;
    const days = Math.round((Date.parse(`${d}T12:00:00`) - Date.parse(`${today}T12:00:00`)) / 86400e3);
    return days <= 7 ? C.major : days <= 30 ? C.minor : C.textMuted;
  };
  // A plain render function (not a component defined in render), so an open editor keeps its typing when the list re-renders.
  const row = (a) =>
    editing === a.id ? (
      <ActionEditor key={a.id} a={a} onCancel={() => setEditing(null)} onSave={(x) => (update(x), setEditing(null))} />
    ) : (
      <div key={a.id} className="flex items-start gap-2 rounded-md px-2.5 py-2" style={{ ...card, opacity: a.done ? 0.65 : 1 }} data-action={a.id}>
        <input type="checkbox" checked={a.done} onChange={(e) => update({ ...a, done: e.target.checked, doneAt: e.target.checked ? Date.now() : null, doneBy: e.target.checked ? "you" : null })} className="mt-1" aria-label={`Done: ${a.title}`} />
        <div className="min-w-0 flex-1">
          <div className="text-sm" style={{ color: C.text, textDecoration: a.done ? "line-through" : "none" }}>{a.title}</div>
          {a.description && <div className="text-[11px] mt-0.5 leading-snug" style={{ color: C.textMuted }}>{a.description}</div>}
          <div className="text-[10px] mt-0.5 flex flex-wrap gap-x-2" style={{ color: C.textFaint }}>
            <span style={{ color: a.done ? C.textFaint : dueColor(a.due) }}>{fmtDue(a.due)}</span>
            {a.repeat === "yearly" && <span>every year</span>}
            {a.setting && <span>ticks itself when the {SETTING_LABEL[a.setting] || a.setting} changes{a.value ? ` to ${a.value}` : ""}</span>}
            {a.done && a.doneBy === "settings log" && <span style={{ color: C.ok }}>done (seen in the settings log)</span>}
            {a.source === "gemini" && <span>from the charter</span>}
          </div>
        </div>
        <div className="flex flex-col items-end gap-1 shrink-0 text-[11px]">
          <button type="button" onClick={() => setEditing(a.id)} style={{ color: C.brand }} className="underline" data-action-edit>Edit</button>
          <button type="button" onClick={() => save(actions.filter((x) => x.id !== a.id))} style={{ color: C.textMuted }} className="underline" data-action-delete>Delete</button>
        </div>
      </div>
    );
  return (
    <div data-actions>
      <div className="flex items-center justify-between">
        <SectionLabel>Actions — {open.length} open</SectionLabel>
        <button type="button" onClick={() => setEditing("new")} style={btn()} className="text-xs rounded-md px-2 py-1 mt-2" data-action-add>+ Add action</button>
      </div>
      <div className="space-y-1.5">
        {editing === "new" && <ActionEditor a={{ id: newId(), source: "manual", done: false }} onCancel={() => setEditing(null)} onSave={(x) => (save([...actions, x]), setEditing(null))} />}
        {open.length === 0 && editing !== "new" && <div className="text-xs px-1" style={{ color: C.textMuted }}>No open actions.</div>}
        {open.map(row)}
      </div>
      {done.length > 0 && (
        <button type="button" onClick={() => setShowDone((v) => !v)} className="text-[11px] mt-2 flex items-center gap-1" style={{ color: C.textMuted }} aria-expanded={showDone}>
          <ChevronRight size={12} style={{ transform: showDone ? "rotate(90deg)" : "none" }} /> {done.length} done
        </button>
      )}
      {showDone && <div className="space-y-1.5 mt-1.5">{done.map(row)}</div>}
    </div>
  );
}

/* ---------------- rule changes + charter update ---------------- */
function RuleChanges({ charter, onSaveRules, onDraft, onResolve, gemini }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [md, setMd] = useState(charter.draft?.markdown || "");
  const [copied, setCopied] = useState(false);
  useEffect(() => setMd(charter.draft?.markdown || ""), [charter.draft?.markdown]);
  const rules = charter.ruleChanges || [];
  const setStatus = (r, status) => onSaveRules(rules.map((x) => (x.id === r.id ? { ...x, status, decidedAt: Date.now() } : x)));
  const approved = rules.filter((r) => r.status === "approved");
  const STATUS_C = { proposed: C.minor, approved: C.ok, rejected: C.textFaint, applied: C.brand };
  const draft = async () => {
    setBusy(true);
    setErr(null);
    try {
      await onDraft();
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div data-rule-changes>
      <SectionLabel>Rule changes</SectionLabel>
      <div className="flex gap-2 mb-2">
        <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Proposed rule change" style={inputStyle} className="flex-1 min-w-0 rounded px-2 py-1.5 text-sm outline-none" aria-label="Proposed rule change" data-rule-input />
        <button type="button" disabled={!text.trim()} onClick={() => (onSaveRules([...rules, { id: newId(), text: text.trim(), status: "proposed", createdAt: Date.now() }]), setText(""))} style={{ background: C.brand, color: C.text, opacity: text.trim() ? 1 : 0.5 }} className="rounded px-3 py-1.5 text-sm shrink-0" data-rule-add>Add</button>
      </div>
      <div className="space-y-1.5">
        {rules.length === 0 && <div className="text-xs px-1" style={{ color: C.textMuted }}>No rule changes recorded.</div>}
        {rules.map((r) => (
          <div key={r.id} className="rounded-md px-2.5 py-2 flex items-start gap-2" style={card} data-rule={r.status}>
            <div className="min-w-0 flex-1">
              <div className="text-sm" style={{ color: C.text }}>{r.text}</div>
              <div className="text-[10px] mt-0.5" style={{ color: STATUS_C[r.status] }}>{r.status === "applied" ? "written into the charter" : r.status}{r.decidedAt ? ` · ${new Date(r.decidedAt).toLocaleDateString()}` : ""}</div>
            </div>
            <div className="flex gap-1.5 shrink-0 text-[11px]">
              {r.status === "proposed" && (
                <>
                  <button type="button" onClick={() => setStatus(r, "approved")} style={btn(C.ok)} className="rounded px-1.5 py-0.5" data-rule-approve>Approve</button>
                  <button type="button" onClick={() => setStatus(r, "rejected")} style={btn(C.textMuted)} className="rounded px-1.5 py-0.5">Reject</button>
                </>
              )}
              {r.status !== "proposed" && r.status !== "applied" && <button type="button" onClick={() => setStatus(r, "proposed")} style={{ color: C.textMuted }} className="underline">Undo</button>}
              <button type="button" onClick={() => onSaveRules(rules.filter((x) => x.id !== r.id))} style={{ color: C.textMuted }} className="underline">Delete</button>
            </div>
          </div>
        ))}
      </div>
      {approved.length > 0 && !charter.draft && (
        <button type="button" disabled={!gemini || busy} onClick={draft} style={{ background: C.brand, color: C.text, opacity: !gemini || busy ? 0.5 : 1 }} className="w-full rounded-md px-3 py-2 text-sm mt-2" data-draft-charter>
          {busy ? "Drafting…" : `Draft the charter update with ${approved.length} approved change${approved.length === 1 ? "" : "s"} (Gemini)`}
        </button>
      )}
      {!gemini && approved.length > 0 && <div className="text-[11px] mt-1" style={{ color: C.textFaint }}>Drafting needs a Gemini key on the server.</div>}
      {err && <div className="text-xs mt-1" style={{ color: C.major }}>{err}</div>}
      {charter.draft && (
        <div className="mt-2 space-y-1.5" data-charter-draft>
          <div className="text-xs" style={{ color: C.textMuted }}>Proposed charter (Markdown) — edit it here if you like, copy it into your document, then accept or discard.</div>
          <textarea value={md} onChange={(e) => setMd(e.target.value)} rows={12} style={{ ...inputStyle, fontFamily: "ui-monospace, monospace" }} className="w-full rounded px-2 py-1.5 text-[11px] outline-none" aria-label="Charter update" />
          <div className="flex gap-2 text-sm">
            <button
              type="button"
              onClick={() => {
                try {
                  navigator.clipboard?.writeText(md);
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1500);
                } catch {
                  /* clipboard blocked: the text can still be selected */
                }
              }}
              style={btn()}
              className="rounded-md px-3 py-1.5 flex items-center gap-1"
              data-draft-copy
            >
              <Copy size={13} /> {copied ? "Copied" : "Copy"}
            </button>
            <button type="button" onClick={() => onResolve(true, md)} style={{ background: C.ok, color: "#10171A" }} className="rounded-md px-3 py-1.5" data-draft-accept>Accept</button>
            <button type="button" onClick={() => onResolve(false)} style={btn(C.textMuted)} className="rounded-md px-3 py-1.5">Discard</button>
          </div>
        </div>
      )}
      {charter.acceptedDraft && !charter.draft && <div className="text-[10px] mt-1.5" style={{ color: C.textFaint }}>Last accepted update {fmtWhen(charter.acceptedDraft.at)}.</div>}
    </div>
  );
}

/* ---------------- one charter ---------------- */
function CharterDetail({ leagueId, gemini, onBack, onChanged }) {
  const [c, setC] = useState(null);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const [replace, setReplace] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [showText, setShowText] = useState(false);
  const load = useCallback(() => api.getCharter(leagueId).then(setC).catch((e) => setErr(e.message)), [leagueId]);
  useEffect(() => {
    load();
  }, [load]);
  const apply = async (p) => {
    try {
      await p;
      await load();
      onChanged?.();
    } catch (e) {
      setErr(e.message);
    }
  };
  if (err && !c) return <div className="text-xs" style={{ color: C.major }}>{err}</div>;
  if (!c) return <div className="text-sm flex items-center gap-2 py-4" style={{ color: C.textMuted }}><Loader2 size={14} className="animate-spin" /> Loading…</div>;
  const st = c.status || { status: "ok" };
  return (
    <div className="space-y-3" data-charter={leagueId}>
      <button type="button" onClick={onBack} className="text-xs flex items-center gap-1" style={{ color: C.brand }}><ArrowLeft size={13} /> All charters</button>
      <div className="rounded-lg px-3.5 py-3 space-y-1.5" style={{ ...card, borderLeft: `3px solid ${STATUS_COLOR[st.status]}` }}>
        <div style={{ color: C.text, fontFamily: "Oswald, sans-serif" }} className="text-base font-semibold">{c.leagueName}</div>
        <div className="text-[11px]" style={{ color: C.textMuted }}>
          {c.source?.kind === "link" ? <a href={c.source.link} target="_blank" rel="noreferrer" style={{ color: C.brand }} className="underline">Charter link</a> : `Uploaded file: ${c.source?.name || "charter"}`}
          {c.read?.at ? ` · read ${fmtWhen(c.read.at)}` : ""}
          {c.read?.checkedAt && c.read.unchanged ? ` · checked ${fmtWhen(c.read.checkedAt)}, unchanged` : ""}
        </div>
        {c.read?.ok === false && <div className="text-xs" style={{ color: C.minor }}>{c.read.error}</div>}
        {c.summary && <div className="text-xs leading-snug" style={{ color: C.textMuted }}>{c.summary}</div>}
        <div className="flex flex-wrap gap-2 pt-1 text-xs">
          <button type="button" disabled={busy || !gemini} onClick={async () => { setBusy(true); await apply(api.rereadCharter(leagueId, true)); setBusy(false); }} style={{ ...btn(), opacity: busy || !gemini ? 0.5 : 1 }} className="rounded-md px-2 py-1" data-charter-reread>{busy ? "Reading…" : "Read again"}</button>
          <button type="button" onClick={() => setReplace((v) => !v)} style={btn(C.textMuted)} className="rounded-md px-2 py-1">{replace ? "Cancel" : "Replace document"}</button>
          <button type="button" onClick={() => setConfirmDelete(true)} style={btn(C.major)} className="rounded-md px-2 py-1">Remove</button>
        </div>
        {replace && <SourceForm leagueId={leagueId} compact onDone={() => (setReplace(false), load(), onChanged?.())} />}
        {confirmDelete && <ConfirmPush title="Remove this charter and its checklist?" lines={["Actions, rule changes and the stored document for this league are deleted from the app."]} buttonLabel="Yes, remove it" onConfirm={async () => { await api.deleteCharter(leagueId); onChanged?.(); onBack(); }} onCancel={() => setConfirmDelete(false)} />}
      </div>
      {err && <div className="text-xs" style={{ color: C.major }}>{err}</div>}
      <ActionsList charter={c} onSave={(list) => (setC({ ...c, actions: list }), apply(api.saveCharterActions(leagueId, list)))} />
      <RuleChanges
        charter={c}
        gemini={gemini}
        onSaveRules={(list) => (setC({ ...c, ruleChanges: list }), apply(api.saveCharterRules(leagueId, list)))}
        onDraft={async () => {
          const r = await api.draftCharter(leagueId);
          setC((x) => ({ ...x, draft: r.draft }));
        }}
        onResolve={(accept, md) => apply(api.resolveCharterDraft(leagueId, accept, md))}
      />
      {c.textPreview && (
        <div>
          <button type="button" onClick={() => setShowText((v) => !v)} className="text-[11px] flex items-center gap-1" style={{ color: C.textMuted }} aria-expanded={showText}>
            <ChevronRight size={12} style={{ transform: showText ? "rotate(90deg)" : "none" }} /> Charter text ({Math.round(c.textLength / 100) / 10}k characters)
          </button>
          {showText && <pre className="text-[11px] whitespace-pre-wrap mt-1 rounded-md p-2 max-h-80 overflow-y-auto" style={{ ...card, color: C.textMuted }}>{c.textPreview}{c.textLength > 4000 ? "\n…" : ""}</pre>}
        </div>
      )}
    </div>
  );
}

/* ---------------- charters list ---------------- */
function Charters({ initialLeagueId, onSummaryChange }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [open, setOpen] = useState(initialLeagueId || null);
  const [adding, setAdding] = useState(false);
  const [pick, setPick] = useState("");
  const load = useCallback(() => api.getCommish().then((d) => (setData(d), setErr(null))).catch((e) => setErr(e.message)), []);
  useEffect(() => {
    load();
  }, [load]);
  const changed = () => {
    load();
    onSummaryChange?.();
  };
  if (open) return <CharterDetail leagueId={open} gemini={data?.geminiConfigured} onBack={() => (setOpen(null), load())} onChanged={changed} />;
  if (err && !data) return <div className="text-xs" style={{ color: C.major }}>{err}</div>;
  if (!data) return <div className="text-sm flex items-center gap-2 py-4" style={{ color: C.textMuted }}><Loader2 size={14} className="animate-spin" /> Loading your leagues…</div>;
  const charters = Object.values(data.charters || {}).sort((a, b) => (a.next?.due || "9999").localeCompare(b.next?.due || "9999"));
  const withCharter = new Set(charters.map((c) => c.leagueId));
  const choices = (data.leagues || []).filter((l) => !withCharter.has(l.leagueId));
  const leagueOf = (id) => (data.leagues || []).find((l) => l.leagueId === id);
  return (
    <div className="space-y-3" data-charters>
      {!data.geminiConfigured && <div className="text-[11px] px-1" style={{ color: C.textFaint }}>No Gemini key on the server: charters are stored and you can add actions by hand, but they aren't read automatically.</div>}
      {charters.length === 0 && <div className="text-sm px-1" style={{ color: C.textMuted }}>No charters yet. Add one for each league you run.</div>}
      {charters.map((c) => {
        const l = leagueOf(c.leagueId);
        return (
          <button key={c.leagueId} type="button" onClick={() => setOpen(c.leagueId)} className="w-full text-left rounded-lg px-3.5 py-3" style={{ ...card, borderLeft: `3px solid ${STATUS_COLOR[c.status]}` }} data-charter-card={c.leagueId} data-charter-status={c.status}>
            <div className="flex items-center gap-2.5">
              <Avatar avatar={l?.avatar} name={c.leagueName} size={30} square />
              <div className="min-w-0 flex-1">
                <div className="text-sm font-semibold truncate" style={{ color: C.text, fontFamily: "Oswald, sans-serif" }}>{c.leagueName}</div>
                <div className="text-[11px]" style={{ color: STATUS_COLOR[c.status] }}>
                  {c.next ? `${fmtDue(c.next.due)} — ${c.next.items.join(" · ")}` : STATUS_TEXT.ok}
                </div>
                <div className="text-[10px]" style={{ color: C.textFaint }}>
                  {c.actions} open action{c.actions === 1 ? "" : "s"}{c.overdue ? ` · ${c.overdue} overdue` : ""}{c.proposed ? ` · ${c.proposed} proposed rule change${c.proposed === 1 ? "" : "s"}` : ""}{c.readError ? " · couldn't be read" : ""}
                </div>
              </div>
              <ChevronRight size={16} style={{ color: C.textFaint }} />
            </div>
          </button>
        );
      })}
      <div className="rounded-lg px-3.5 py-3 space-y-2" style={card}>
        <button type="button" onClick={() => setAdding((v) => !v)} className="w-full flex items-center justify-between text-sm" style={{ color: C.text }} aria-expanded={adding} data-charter-add>
          <span className="font-medium">Add a charter</span>
          <ChevronRight size={14} style={{ color: C.textFaint, transform: adding ? "rotate(90deg)" : "none" }} />
        </button>
        {adding && (
          <>
            <select value={pick} onChange={(e) => setPick(e.target.value)} style={inputStyle} className="w-full rounded px-2 py-1.5 text-sm outline-none" aria-label="League" data-charter-league>
              <option value="">League…</option>
              {choices.map((l) => (
                <option key={l.leagueId} value={l.leagueId}>{l.commish ? "★ " : ""}{l.name}{l.bestBall ? " (best ball)" : ""}</option>
              ))}
            </select>
            <div className="text-[10px]" style={{ color: C.textFaint }}>★ = you're the commissioner. Any of your Sleeper leagues this season can have a charter. Share Google documents as "Anyone with the link can view" — the app only reads them.</div>
            <SourceForm leagueId={pick} onDone={(c) => (setAdding(false), setPick(""), changed(), setOpen(c.leagueId))} />
          </>
        )}
      </div>
    </div>
  );
}

/* ---------------- best ball ---------------- */
function PayoutEditor({ payouts, onChange }) {
  return (
    <div className="space-y-1">
      {payouts.map((p, i) => (
        <div key={i} className="flex items-center gap-1.5 text-xs" style={{ color: C.textMuted }}>
          <span>Place</span>
          <input type="number" min="1" value={p.place ?? ""} onChange={(e) => onChange(payouts.map((x, j) => (j === i ? { ...x, place: e.target.value } : x)))} style={inputStyle} className="w-14 rounded px-1.5 py-0.5" aria-label="Place" />
          <input type="number" min="0" max="100" value={p.pct ?? ""} onChange={(e) => onChange(payouts.map((x, j) => (j === i ? { ...x, pct: e.target.value } : x)))} style={inputStyle} className="w-16 rounded px-1.5 py-0.5" aria-label="Percent of pot" />
          <span>% of pot</span>
          <button type="button" onClick={() => onChange(payouts.filter((_, j) => j !== i))} style={{ color: C.textMuted }} className="underline ml-1">Remove</button>
        </div>
      ))}
      <button type="button" onClick={() => onChange([...payouts, { place: payouts.length + 1, pct: "" }])} style={{ color: C.brand }} className="text-[11px] underline">+ Add a paid place</button>
    </div>
  );
}

function BestBallDetail({ league, all, gemini, onBack }) {
  const [board, setBoard] = useState(null);
  const [err, setErr] = useState(null);
  const [form, setForm] = useState(null);
  const [saving, setSaving] = useState(false);
  const [parsing, setParsing] = useState(false);
  const [parsed, setParsed] = useState(null);
  const [showSettings, setShowSettings] = useState(false);
  const load = useCallback(() => api.getBestBallBoard(league.leagueId).then((b) => (setBoard(b), setErr(null), setForm((f) => f || { ...b.settings, payouts: b.settings.payouts || [] }))).catch((e) => setErr(e.message)), [league.leagueId]);
  useEffect(() => {
    load();
  }, [load]);
  const others = all.filter((l) => l.leagueId !== league.leagueId);
  const save = async (patch = form) => {
    setSaving(true);
    try {
      const s = await api.saveBestBall(league.leagueId, patch);
      setForm({ ...s, payouts: s.payouts || [] });
      await load();
    } catch (e) {
      setErr(e.message);
    } finally {
      setSaving(false);
    }
  };
  const parse = async () => {
    setParsing(true);
    setParsed(null);
    try {
      setParsed(await api.parseBestBallRules(league.leagueId, form.prompt || ""));
    } catch (e) {
      setErr(e.message);
    } finally {
      setParsing(false);
    }
  };
  const placeAmount = useMemo(() => new Map((board?.pot?.places || []).map((p) => [p.place, p.amount])), [board]);
  return (
    <div className="space-y-3" data-bestball={league.leagueId}>
      <button type="button" onClick={onBack} className="text-xs flex items-center gap-1" style={{ color: C.brand }}><ArrowLeft size={13} /> All best ball leagues</button>
      <div style={{ color: C.text, fontFamily: "Oswald, sans-serif" }} className="text-base font-semibold">{league.name}</div>
      {err && <div className="text-xs" style={{ color: C.major }}>{err}</div>}
      {!board ? (
        <div className="text-sm flex items-center gap-2 py-2" style={{ color: C.textMuted }}><Loader2 size={14} className="animate-spin" /> Building the leaderboard…</div>
      ) : (
        <>
          <div className="text-[11px]" style={{ color: C.textMuted }}>
            {board.metric === "PF" ? "Points for" : "Max points for"}
            {board.leagues.length > 1 ? ` · combined: ${board.leagues.map((l) => l.name).join(" + ")}` : ""}
            {board.settings.heroMultiplier ? ` · hero ×${board.settings.heroMultiplier}` : ""} · weeks {board.weeks.from}–{board.weeks.to}{board.weeks.live ? " (current week still in progress)" : ""} · from {board.computedFrom}
          </div>
          {board.pot.total != null && (
            <div className="text-xs rounded-md px-3 py-2" style={card} data-pot>
              Pot <b style={{ color: C.text }}>${board.pot.total.toLocaleString()}</b> ({board.pot.teams} teams × ${board.pot.entryFee}){board.pot.places.length ? ` · ${board.pot.places.map((p) => `${p.place}${["st", "nd", "rd"][p.place - 1] || "th"} $${(p.amount ?? 0).toLocaleString()}`).join(" · ")}` : ""}
            </div>
          )}
          <div className="rounded-lg overflow-hidden" style={card} data-leaderboard>
            {board.rows.map((r) => (
              <div key={`${r.leagueId}:${r.rosterId}`} className="flex items-center gap-2 px-3 py-2" style={{ borderTop: r.rank > 1 ? `1px solid ${C.border}` : "none", background: placeAmount.has(r.rank) ? C.okBg : "transparent" }} data-board-row={r.rank}>
                <span className="w-6 text-right text-sm font-semibold" style={{ color: r.rank <= 3 ? C.text : C.textFaint, fontFamily: "Oswald, sans-serif" }}>{r.rank}</span>
                <Avatar avatar={r.avatar} name={r.user} size={24} />
                <div className="min-w-0 flex-1">
                  <div className="text-sm truncate" style={{ color: C.text }}>{r.team}</div>
                  <div className="text-[10px] truncate" style={{ color: C.textFaint }}>
                    {r.user}{board.leagues.length > 1 ? ` · ${r.leagueName}` : ""}{r.heroName ? ` · hero ${r.heroName}${r.heroBonus ? ` (+${r.heroBonus})` : ""}` : ""}
                  </div>
                </div>
                <div className="text-right shrink-0">
                  <div className="text-sm font-semibold" style={{ color: C.text, fontVariantNumeric: "tabular-nums" }}>{r.value.toFixed(2)}</div>
                  {r.computed != null && Math.abs(r.computed - r.sleeperValue) > 0.05 && !board.settings.heroMultiplier && board.weeks.from === 1 && <div className="text-[10px]" style={{ color: C.textFaint }}>Sleeper {r.sleeperValue.toFixed(2)}</div>}
                  {placeAmount.has(r.rank) && <div className="text-[10px]" style={{ color: C.ok }}>${(placeAmount.get(r.rank) ?? 0).toLocaleString()}</div>}
                </div>
              </div>
            ))}
          </div>
          <a href={api.bestBallCsvUrl(league.leagueId)} className="inline-flex items-center gap-1 text-xs rounded-md px-2.5 py-1.5" style={btn()} data-export-csv download>
            Export the evidence (CSV): every team's counted lineup and points, week by week
          </a>
        </>
      )}
      {form && (
        <div className="rounded-lg px-3.5 py-3 space-y-2" style={card} data-bb-settings>
          <button type="button" onClick={() => setShowSettings((v) => !v)} className="w-full flex items-center justify-between text-sm" style={{ color: C.text }} aria-expanded={showSettings}>
            <span className="font-medium">Rules, hero players and payouts</span>
            <ChevronRight size={14} style={{ color: C.textFaint, transform: showSettings ? "rotate(90deg)" : "none" }} />
          </button>
          {showSettings && (
            <>
              <div className="text-xs" style={{ color: C.textMuted }}>Describe the leaderboard rules in your own words — Gemini fills in the fields below, then check them and save.</div>
              <textarea value={form.prompt || ""} onChange={(e) => setForm({ ...form, prompt: e.target.value })} rows={3} placeholder="e.g. Max PF across this league and Guardians BB combined; each manager's hero player scores double; $50 entry, 1st 70%, 2nd 30%" style={inputStyle} className="w-full rounded px-2 py-1.5 text-xs outline-none" aria-label="Rules" data-bb-prompt />
              <button type="button" disabled={!gemini || parsing || !(form.prompt || "").trim()} onClick={parse} style={{ ...btn(), opacity: !gemini || parsing || !(form.prompt || "").trim() ? 0.5 : 1 }} className="rounded-md px-2.5 py-1 text-xs" data-bb-parse>{parsing ? "Reading…" : "Read the rules (Gemini)"}</button>
              {parsed && (
                <div className="text-[11px] rounded-md p-2 space-y-0.5" style={{ background: C.surfaceRaised, color: C.textMuted }} data-bb-parsed>
                  <div>Stat: {parsed.metric === "PF" ? "points for" : "max points for"} · combine: {parsed.combineWith.map((id) => others.find((l) => l.leagueId === id)?.name).filter(Boolean).join(", ") || "—"}{parsed.unmatched?.length ? ` (not found: ${parsed.unmatched.join(", ")})` : ""} · hero: {parsed.heroMultiplier ? `×${parsed.heroMultiplier}` : "—"} · weeks: {parsed.weeksFrom || 1}–{parsed.weeksTo || "end"} · entry: {parsed.entryFee != null ? `$${parsed.entryFee}` : "—"} · payouts: {parsed.payouts.map((p) => `${p.place}: ${p.pct}%`).join(", ") || "—"}</div>
                  {parsed.notes && <div>Note: {parsed.notes}</div>}
                  <button type="button" onClick={() => (setForm({ ...form, ...parsed, payouts: parsed.payouts }), setParsed(null))} style={{ color: C.brand }} className="underline">Use these</button>
                </div>
              )}
              <div className="grid grid-cols-2 gap-2 text-xs" style={{ color: C.textMuted }}>
                <label className="flex flex-col gap-0.5">Stat
                  <select value={form.metric} onChange={(e) => setForm({ ...form, metric: e.target.value })} style={inputStyle} className="rounded px-1.5 py-1"><option value="maxPF">Max points for</option><option value="PF">Points for</option></select>
                </label>
                <label className="flex flex-col gap-0.5">Hero multiplier
                  <input type="number" min="1" max="10" step="0.5" value={form.heroMultiplier ?? ""} onChange={(e) => setForm({ ...form, heroMultiplier: e.target.value })} placeholder="none" style={inputStyle} className="rounded px-1.5 py-1" />
                </label>
                <label className="flex flex-col gap-0.5">Weeks from
                  <input type="number" min="1" max="18" value={form.weeksFrom ?? ""} onChange={(e) => setForm({ ...form, weeksFrom: e.target.value })} placeholder="1" style={inputStyle} className="rounded px-1.5 py-1" />
                </label>
                <label className="flex flex-col gap-0.5">to
                  <input type="number" min="1" max="18" value={form.weeksTo ?? ""} onChange={(e) => setForm({ ...form, weeksTo: e.target.value })} placeholder="17" style={inputStyle} className="rounded px-1.5 py-1" />
                </label>
                <label className="flex flex-col gap-0.5">Entry fee ($ per team)
                  <input type="number" min="0" value={form.entryFee ?? ""} onChange={(e) => setForm({ ...form, entryFee: e.target.value })} style={inputStyle} className="rounded px-1.5 py-1" />
                </label>
              </div>
              {others.length > 0 && (
                <div className="text-xs space-y-0.5" style={{ color: C.textMuted }}>
                  <div>Combine with</div>
                  {others.map((l) => (
                    <label key={l.leagueId} className="flex items-center gap-1.5">
                      <input type="checkbox" checked={(form.combineWith || []).includes(l.leagueId)} onChange={(e) => setForm({ ...form, combineWith: e.target.checked ? [...(form.combineWith || []), l.leagueId] : (form.combineWith || []).filter((x) => x !== l.leagueId) })} />
                      {l.name}
                    </label>
                  ))}
                </div>
              )}
              <PayoutEditor payouts={form.payouts || []} onChange={(payouts) => setForm({ ...form, payouts })} />
              {Number(form.heroMultiplier) > 1 && board && (
                <div className="space-y-1" data-heroes>
                  <div className="text-xs" style={{ color: C.textMuted }}>Hero player for each team</div>
                  {board.rows.map((r) => {
                    const k = `${r.leagueId}:${r.rosterId}`;
                    return (
                      <label key={k} className="flex items-center gap-2 text-xs" style={{ color: C.text }}>
                        <span className="w-28 truncate">{r.team}</span>
                        <select value={(form.heroes || {})[k] || ""} onChange={(e) => setForm({ ...form, heroes: { ...(form.heroes || {}), [k]: e.target.value } })} style={inputStyle} className="flex-1 min-w-0 rounded px-1.5 py-1" aria-label={`Hero for ${r.team}`}>
                          <option value="">No hero</option>
                          {(r.roster || []).map((p) => <option key={p.id} value={p.id}>{p.name} ({p.pos})</option>)}
                        </select>
                      </label>
                    );
                  })}
                </div>
              )}
              <button type="button" disabled={saving} onClick={() => save(form)} style={{ background: C.brand, color: C.text, opacity: saving ? 0.5 : 1 }} className="w-full rounded-md px-3 py-2 text-sm" data-bb-save>{saving ? "Saving…" : "Save and recalculate"}</button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function BestBall() {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [open, setOpen] = useState(null);
  useEffect(() => {
    api.getBestBall().then(setData).catch((e) => setErr(e.message));
  }, []);
  if (err && !data) return <div className="text-xs" style={{ color: C.major }}>{err}</div>;
  if (!data) return <div className="text-sm flex items-center gap-2 py-4" style={{ color: C.textMuted }}><Loader2 size={14} className="animate-spin" /> Loading your best ball leagues…</div>;
  const sel = data.leagues.find((l) => l.leagueId === open);
  if (sel) return <BestBallDetail league={sel} all={data.leagues} gemini={data.geminiConfigured} onBack={() => setOpen(null)} />;
  if (!data.leagues.length) return <div className="text-sm px-1" style={{ color: C.textMuted }}>You have no best ball leagues on Sleeper this season.</div>;
  return (
    <div className="space-y-2" data-bestball-list>
      {data.leagues.map((l) => {
        const s = l.settings || {};
        const bits = [s.metric === "PF" ? "Points for" : "Max PF", s.combineWith?.length ? `combined with ${s.combineWith.map((id) => data.leagues.find((x) => x.leagueId === id)?.name || "1 league").join(", ")}` : null, s.heroMultiplier ? `hero ×${s.heroMultiplier}` : null, s.entryFee != null ? `$${s.entryFee} entry` : null].filter(Boolean);
        return (
          <button key={l.leagueId} type="button" onClick={() => setOpen(l.leagueId)} className="w-full text-left rounded-lg px-3.5 py-3 flex items-center gap-2.5" style={card} data-bestball-card={l.leagueId}>
            <Avatar avatar={l.avatar} name={l.name} size={30} square />
            <div className="min-w-0 flex-1">
              <div className="text-sm font-semibold truncate" style={{ color: C.text, fontFamily: "Oswald, sans-serif" }}>{l.name}</div>
              <div className="text-[11px]" style={{ color: C.textMuted }}>{l.teams ? `${l.teams} teams · ` : ""}{bits.join(" · ")}</div>
            </div>
            <Trophy size={15} style={{ color: C.textFaint }} />
          </button>
        );
      })}
    </div>
  );
}

export function CommishScreen({ initialLeagueId = null, initialSub = "charters", onSummaryChange }) {
  const [sub, setSub] = useState(initialSub);
  const tab = (key, label) => (
    <button key={key} onClick={() => setSub(key)} aria-current={sub === key ? "page" : undefined} data-commish-tab={key} style={{ color: sub === key ? C.text : C.textMuted, borderBottom: `2px solid ${sub === key ? C.brand : "transparent"}` }} className="flex-1 py-2 text-sm font-medium">
      {label}
    </button>
  );
  return (
    <div className="px-4 py-3">
      <div className="flex mb-3" style={{ borderBottom: `1px solid ${C.border}` }}>
        {tab("charters", "Charters")}
        {tab("bestball", "Best Ball")}
      </div>
      {sub === "charters" ? <Charters initialLeagueId={initialLeagueId} onSummaryChange={onSummaryChange} /> : <BestBall />}
    </div>
  );
}
