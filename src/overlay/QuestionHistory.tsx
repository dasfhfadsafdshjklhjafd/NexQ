import { useState } from "react";
import { useMeetingStore } from "../stores/meetingStore";
import { useTranscriptStore } from "../stores/transcriptStore";
import { useQuestionStore, type TrackedQuestion } from "../stores/questionStore";
import type { ScanMode } from "../hooks/useMeetingWatch";

const mine = (q:TrackedQuestion) => /^(you|user)$/i.test(q.source);
function stateOf(q:TrackedQuestion) {
  if (q.dismissed) return "Dismissed";
  if (q.requestId) return "Answering";
  if (q.answer) return "Answered";
  if (q.failed) return "Failed";
  if (mine(q)) return "You asked";
  if (q.heldBack) return "Held";
  return q.assisted ? "Sent" : "Queued";
}
function elapsed(at:number,start:number|null) {
  const seconds = Math.floor(Math.max(0,at - (start || 0))/1000);
  return Math.floor(seconds/60) + ":" + String(seconds%60).padStart(2,"0");
}

export function QuestionHistory({mode,progress,onRetry}: {
  mode:ScanMode; progress:{at:number;count:number}; onRetry:(index:number)=>void
}) {
  const [expanded,setExpanded] = useState(false);
  const questions = useQuestionStore(s => s.questions);
  const start = useMeetingStore(s => s.meetingStartTime);
  const segments = useTranscriptStore(s => s.segments);
  const finals = segments.filter(s => s.is_final && s.text.trim());
  const local = mode === "local";
  const at = local ? finals[finals.length-1]?.timestamp_ms || 0 : progress.at;
  const count = local ? finals.length : progress.count;
  const interviewer = questions.filter(q => !mine(q));
  const answered = interviewer.filter(q => q.answer).length;
  const queued = interviewer.filter(q => stateOf(q) === "Queued").length;
  const working = interviewer.filter(q => stateOf(q) === "Answering").length;
  return <details onToggle={e => setExpanded(e.currentTarget.open)} className="text-xs text-muted-foreground">
    <summary className="cursor-pointer px-2 py-1" aria-label="Meeting question history">
      {answered}/{interviewer.length} answered · {queued} queued{working > 0 && " · answering"}
      <span className="block text-meta">{local ? "Local detector" : mode === "retrying" ? "Watcher retrying" :
        mode === "connecting" ? "Connecting watcher" : "AI watcher"} · {count}/{finals.length} final lines checked
        {count > 0 && " · last line " + elapsed(at,start)}</span>
    </summary>
    {expanded && <div className="max-h-52 overflow-y-auto px-2 pb-2">
      <p className="mb-1">{interviewer.length} from them · {questions.length-interviewer.length} from you</p>
      {questions.slice().reverse().map(q => <details key={q.segmentId || q.timestamp_ms+"-"+q.text} className="border-t border-border/30 py-1">
        <summary className="cursor-pointer">{elapsed(q.timestamp_ms,start)} · {stateOf(q)} · {q.text}</summary>
        {q.variants?.map(v => <div key={v}>Also asked as “{v}”</div>)}
        {q.answer && <p className="select-text whitespace-pre-wrap text-foreground">{q.answer}</p>}
        {(q.failed || q.heldBack) && !q.dismissed && <button onClick={() => onRetry(questions.indexOf(q))}>Answer this question</button>}
      </details>)}
    </div>}
  </details>;
}
