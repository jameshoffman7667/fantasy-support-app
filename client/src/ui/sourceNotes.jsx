import { useState } from "react";
import { ExternalLink } from "lucide-react";
import { C } from "./theme.js";
import { Modal } from "./common.jsx";

/**
 * v4.16.0 (P-28): wherever sources are listed for news or articles, tapping the summary opens this pop-up with what was
 * pulled from each source; tapping a source's line opens the page it came from (when the search gave a link for it).
 */
export function notesOf(item) {
  if (item?.sourceNotes?.length) return item.sourceNotes;
  return (item?.sources || []).map((source) => ({ source, detail: null, url: null }));
}

/** The pop-up's list. Pure view. */
export function SourceNoteList({ notes }) {
  if (!notes.length) return <div style={{ color: C.textFaint }} className="text-xs">No sources were listed for this one.</div>;
  return (
    <div className="space-y-1.5" data-source-notes>
      {notes.map((n, i) => {
        const body = (
          <>
            <div style={{ color: C.text }} className="text-sm font-medium flex items-center gap-1">{n.source}{n.url && <ExternalLink size={12} style={{ color: C.textMuted }} aria-hidden />}</div>
            <div style={{ color: n.detail ? C.textMuted : C.textFaint }} className="text-xs leading-snug">{n.detail || "No detail was given for this source."}</div>
            {!n.url && <div style={{ color: C.textFaint }} className="text-[10px] mt-0.5">No link available for this source.</div>}
          </>
        );
        const box = { background: C.bg, border: `1px solid ${C.border}` };
        return n.url ? (
          <a key={i} href={n.url} target="_blank" rel="noopener noreferrer" style={box} className="block rounded-md px-3 py-2" data-source-note={n.source} data-source-link>{body}</a>
        ) : (
          <div key={i} style={box} className="rounded-md px-3 py-2" data-source-note={n.source}>{body}</div>
        );
      })}
    </div>
  );
}

/** Wraps the summary text: a button that opens the pop-up. `item` = { sources, sourceNotes }, `summary` = the item's own summary. */
export function SourceSummary({ title, item, summary = null, children, className = "", style = {} }) {
  const [open, setOpen] = useState(false);
  const notes = notesOf(item);
  return (
    <>
      <button type="button" onClick={(e) => { e.preventDefault(); e.stopPropagation(); setOpen(true); }} className={`text-left ${className}`} style={style} title="Tap for the detail from each source" data-source-summary>
        {children}
      </button>
      {open && (
        <Modal title={title} onClose={() => setOpen(false)}>
          <div className="space-y-2.5 text-sm" data-source-modal>
            {summary && <div style={{ color: C.text }} className="leading-snug">{summary}</div>}
            <div style={{ color: C.textMuted }} className="text-xs">What each source said. Tap one to open the page it came from.</div>
            <SourceNoteList notes={notes} />
          </div>
        </Modal>
      )}
    </>
  );
}
