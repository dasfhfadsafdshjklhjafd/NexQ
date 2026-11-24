import { useEffect, useState } from "react";
import { lineQuestions } from "../lib/questionText";
import { invoke } from "@tauri-apps/api/core";
import { useConfigStore } from "../stores/configStore";
import { useTranscriptStore } from "../stores/transcriptStore";
import { useQuestionStore } from "../stores/questionStore";
import type { TranscriptSegment } from "../lib/types";

type Line = Pick<TranscriptSegment,"id"|"text"|"speaker"|"timestamp_ms">;
type Found = {line:number; text:string; sameAs:number|null};
export type ScanMode = "local" | "connecting" | "watching" | "retrying" | "fallback";
const speaker = (line: {speaker:string}) => /^(you|user)$/i.test(line.speaker) ? "You" : "Them";

export function scanBatch(lines: Line[], checked: Map<string,string>) {
  const batch: {line:Line; text:string; prefix:string}[] = [];
  let context = "";
  for (const line of lines) {
    const prior = checked.get(line.id) || "";
    if (!line.text.trim() || prior === line.text) {
      if (batch.length) break;
      context = (context + "\n" + speaker(line) + ": " + line.text).slice(-3000);
      continue;
    }
    let start = 0;
    while (start < prior.length && prior[start] === line.text[start]) start++;
    const end = Math.min(start + 3500,line.text.length);
    if (start && batch.length) break;
    if (start) context = (context + "\n" + speaker(line) + ": " + line.text.slice(Math.max(0,start-1200),start)).slice(-3000);
    const text = line.text.slice(start,end);
    batch.push({line,text,prefix:line.text.slice(0,end)});
    if (batch.length >= 6 || end < line.text.length) break;
  }
  return {batch,context};
}

// A layout change may unmount the overlay. Keep committed progress for this meeting.
let checkpoint: {generation:number; url:string; checked:Map<string,string>} | undefined;

export function useMeetingWatch(on: boolean) {
  const provider = useConfigStore(s => s.llmProvider);
  const model = useConfigStore(s => s.llmModel);
  const url = useConfigStore(s => s.customLlmBaseUrl);
  const generation = useQuestionStore(s => s.generation);
  const enabled = on && provider === "custom" && ["interview","interview-now"].includes(model)
    && /^http:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?\/v1\/?$/i.test(url || "");
  const [mode,setMode] = useState<ScanMode>(enabled ? "connecting" : "local");
  const [progress,setProgress] = useState({count:0,at:0});
  useEffect(() => {
    if (!enabled) { setMode("local"); return; }
    if (!checkpoint || checkpoint.generation !== generation || checkpoint.url !== url)
      checkpoint = {generation,url,checked:new Map()};
    const checked = checkpoint.checked;
    let stopped = false, running = false, supported = false, failures = 0;
    let probeAfter = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finals = () => useTranscriptStore.getState().segments.filter(s => s.is_final && s.text.trim());
    const alive = () => !stopped && useQuestionStore.getState().generation === generation;
    function updateProgress() {
      let count = 0, at = 0;
      for (const line of finals()) {
        if (checked.get(line.id) !== line.text) break;
        count++; at = Math.max(at,line.timestamp_ms);
      }
      setProgress(old => old.count === count && old.at === at ? old : {count,at});
    }
    function schedule(ms:number) {
      if (!alive() || running || timer !== undefined) return;
      timer = setTimeout(() => {timer = undefined; void pump();},ms);
    }
    async function pump() {
      running = true;
      let again: number|undefined;
      try {
        if (!supported && Date.now() >= probeAfter) {
          try {
            const result = await invoke<{version:number}>("scan_interview_transcript",{baseUrl:url,payload:null});
            supported = result.version === 1;
          } catch { /* The loopback service may still be starting. */ }
          if (!alive()) return;
          probeAfter = Date.now() + 30000;
        }
        const {batch:pending,context} = scanBatch(finals(),checked);
        for (const b of pending) if (!b.text.trim()) checked.set(b.line.id,b.prefix);
        let batch = pending.filter(b => b.text.trim());
        if (!batch.length) {
          updateProgress();
          if (pending.length) again = 0;
          setMode(old => old === "connecting" ? (supported ? "watching" : "fallback") : old);
          return;
        }
        // On retry, isolate the oldest pending line. Healthy neighbours still
        // get semantic detection if the service repeatedly rejects that line.
        if (failures > 0) batch = batch.slice(0,1);
        const store = useQuestionStore.getState();
        const known = store.questions.filter(q => q.segmentId).slice(0,80).reverse();
        let questions:Found[] = [];
        let fallback = !supported;
        if (supported) {
          const payload = {context,known:known.map(q => ({speaker:speaker({speaker:q.source}),text:q.text.slice(0,1000)})),
            lines:batch.map(b => ({speaker:speaker(b.line),text:b.text}))};
          try {
            const result = await invoke<{questions:Found[]}>("scan_interview_transcript",{baseUrl:url,payload});
            if (!alive()) return;
            if (!Array.isArray(result?.questions)) throw Error("Invalid watcher result");
            questions = result.questions;
          } catch (error) {
            if (!alive()) return;
            setMode("retrying");
            if (/\b409\b/.test(String(error))) { again = 1000; return; }
            failures++;
            if (failures === 1) { again = 1500; return; }
            fallback = true;
          }
        }
        const current = new Map(finals().map(s => [s.id,s]));
        const valid = batch.map(b => current.get(b.line.id)?.text.startsWith(b.prefix));
        if (fallback) {
          batch.forEach((b,i) => {
            if (!valid[i]) return;
            const continuedAt = b.prefix.length - b.text.length;
            const previous = new Map(lineQuestions(b.prefix.slice(0,continuedAt)).map(q => [q.offset,q.text]));
            for (const q of lineQuestions(b.prefix)) {
              if (previous.get(q.offset) === q.text) continue;
              store.addLineQuestion({text:q.text,source:b.line.speaker,timestamp_ms:b.line.timestamp_ms,confidence:0.8},
                b.line.id + "#" + q.offset);
            }
          });
        }
        const seen = new Set<string>();
        for (const q of questions) {
          if (!valid[q.line]) continue;
          const key = JSON.stringify([q.line,q.text.trim().toLowerCase(),q.sameAs]);
          if (seen.has(key)) continue;
          seen.add(key);
          const line = batch[q.line].line;
          if (q.sameAs !== null && known[q.sameAs]?.segmentId) {
            store.rememberVariant(known[q.sameAs].segmentId!,q.text);
          } else {
            store.addWatchedQuestion({text:q.text,source:line.speaker,timestamp_ms:line.timestamp_ms,confidence:1});
          }
        }
        batch.forEach((b,i) => {if (valid[i]) checked.set(b.line.id,b.prefix);});
        failures = 0;
        setMode(fallback ? "fallback" : "watching");
        updateProgress();
        again = 200;
      } finally {
        running = false;
        if (again !== undefined) schedule(again);
      }
    }
    setMode("connecting");
    updateProgress();
    schedule(0);
    const unsub = useTranscriptStore.subscribe((s,old) => {
      if (s.segments !== old.segments) {updateProgress(); schedule(650);}
    });
    return () => {stopped = true; clearTimeout(timer); unsub();};
  },[enabled,generation,url]);
  return {mode:enabled ? mode : "local" as ScanMode,progress};
}
