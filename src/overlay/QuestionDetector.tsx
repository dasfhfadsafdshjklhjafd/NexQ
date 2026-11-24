import { useEffect, useRef, useCallback } from "react";
import { HelpCircle, Sparkles, Check, Clock, X } from "lucide-react";
import { onQuestionDetected, onTranscriptFinal, onTranscriptUpdate } from "../lib/events";
import { runUserAction } from "../lib/userAction";
import {
  REFUSED, answerRunning, autoAnswerRunning, decideTurnStep, inTurn, logAutoAnswer, runYourAction, sameQuestion,
  stopAutoAnswer,
} from "../lib/autoAnswer";
import { useMeetingWatch } from "../hooks/useMeetingWatch";
import { QuestionHistory } from "./QuestionHistory";
import { useStreamStore } from "../stores/streamStore";
import { useTranscriptStore } from "../stores/transcriptStore";
import { useAIActionsStore } from "../stores/aiActionsStore";
import { useQuestionStore } from "../stores/questionStore";
import { showToast } from "../stores/toastStore";
import type { DetectedQuestion, TranscriptSegment, TranscriptUpdateEvent } from "../lib/types";

/**
 * Quiet time after the other party's last words before Auto-Trigger answers
 * their question, so a question still being asked isn't answered half-way.
 */
export const AUTO_TRIGGER_DELAY_MS = 1500;

const isOtherParty = (speaker: string) => speaker === "Them" || speaker === "Interviewer";

import { lastSentence, lineQuestions, looksLikeQuestion } from "../lib/questionText";
export { lastSentence, lineQuestions, looksLikeQuestion } from "../lib/questionText";

/**
 * Starts an automatic answer to `question` (a line's question), unless another
 * answer is running: then the question stays a card to click.
 */
function startAutoAnswer(question: DetectedQuestion, segmentId: string | undefined, early: boolean, detail?: string) {
  const store = useQuestionStore.getState();
  if (answerRunning()) {
    store.holdBack(segmentId, question.text);
    logAutoAnswer("held");
    return;
  }
  if (segmentId !== undefined) store.answerLine(question, segmentId);
  const requestId = crypto.randomUUID();
  store.beginTracked(question.text,requestId,segmentId);
  const done = runUserAction("Assist", question.text, { requestId }).catch((err) => {
    // Keep failed questions available to retry.
    const now = useQuestionStore.getState();
    now.finishTracked(requestId,"");
    now.holdBack(segmentId, question.text);
    if (now.autoAnswer?.requestId === requestId) now.setAutoAnswer(null);
    logAutoAnswer("held");
    if (!String(err).includes(REFUSED)) showToast("Auto-Answer failed. The question is available to retry.", "error");
  });
  if (segmentId !== undefined) store.setAutoAnswer({ requestId, segmentId, question: question.text, early, done });
  logAutoAnswer(early ? "early" : "answered", detail);
}

/** Auto-Answer for a line that carries the provider's turn signal. */
async function onTurnSignal(seg: TranscriptSegment, signalAt: number) {
  if (!seg.turn || !useAIActionsStore.getState().configs.globalDefaults.autoTrigger) return;
  const store = useQuestionStore.getState();
  const sentence = lastSentence(seg.text);
  const question = sentence && looksLikeQuestion(sentence) ? sentence : null;
  const current = store.autoAnswer;
  const step = decideTurnStep(seg.turn, seg.id, question, current);
  if (step.kind === "none") return;
  if (step.kind === "confirm") {
    if (current) store.setAutoAnswer({ ...current, early: false });
    logAutoAnswer("kept");
    return;
  }
  // The early answer was premature: it gives way.
  if (current && (step.kind === "withdraw" || step.replaces)) {
    store.setAutoAnswer(null);
    if (step.kind === "withdraw") store.holdBack(seg.id, current.question);
    logAutoAnswer("withdrawn");
    await stopAutoAnswer(current);
  }
  if (step.kind === "answer") {
    const q = { text: step.question, confidence: 0.9, timestamp_ms: seg.timestamp_ms, source: seg.speaker };
    startAutoAnswer(q, seg.id, step.early, `${seg.turn}, ${Date.now() - signalAt} ms after the signal`);
  }
}

/** The overlay's question card, unless question detection is off. */
export function QuestionPanel() {
  const questionDetection = useAIActionsStore((s) => s.configs.globalDefaults.questionDetection);
  if (!questionDetection) return null;
  return (
    <div className="max-h-[42%] shrink-0 overflow-y-auto rounded-xl border border-info/10 bg-info/5 px-3 py-1.5">
      <QuestionDetector />
    </div>
  );
}

export function QuestionDetector() {
  const questions = useQuestionStore((s) => s.questions);
  const addQuestion = useQuestionStore((s) => s.addQuestion);
  const justMountedRef = useRef(true);
  const segments = useTranscriptStore((s) => s.segments);
  const autoTrigger = useAIActionsStore((s) => s.configs.globalDefaults.autoTrigger);
  const watch = useMeetingWatch(true);
  const local = watch.mode === "local";
  const busy = useStreamStore((s) => s.isStreaming || s.phase === "sending");

  useEffect(() => {
    if (!local) return;
    const p = onQuestionDetected((event) => {
      if (isOtherParty(event.source)) {
        addQuestion(event,crypto.randomUUID());
      }
    });
    return () => { p.then((u) => u()); };
  }, [addQuestion,local]);

  // Providers that detect turns (Cartesia, Deepgram Flux): answer on their
  // "done", or early on "probably done", instead of waiting for quiet.
  useEffect(() => {
    if (!autoTrigger || !local) return;
    const onLine = ({ segment }: TranscriptUpdateEvent) => {
      if (!segment.turn || !isOtherParty(segment.speaker)) return;
      useQuestionStore.getState().markTurnLine(segment.id);
      const at = Date.now();
      void inTurn(() => onTurnSignal(segment, at));
    };
    const updates = onTranscriptUpdate(onLine);
    const finals = onTranscriptFinal(onLine);
    return () => {
      updates.then((u) => u());
      finals.then((u) => u());
    };
  }, [autoTrigger,local]);

  useEffect(() => {
    const store = useQuestionStore.getState();
    if (!local) return;
    const { checkLine, panelSeen, setPanelSeen, holdBackUnanswered } = store;
    for (const seg of segments) {
      if (!seg.is_final || !checkLine(seg.id, seg.text)) continue;
      if (!isOtherParty(seg.speaker)) {
        if (/^(you|user)$/i.test(seg.speaker)) {
          for (const q of lineQuestions(seg.text)) store.addLineQuestion({
            text:q.text,confidence:0.8,timestamp_ms:seg.timestamp_ms,source:seg.speaker
          },seg.id + "#" + q.offset);
        }
        continue;
      }
      if (seg.turn || store.isTurnLine(seg.id)) {
        const sentence = lastSentence(seg.text);
        if (sentence && looksLikeQuestion(sentence)) addQuestion({ text: sentence, confidence: 0.8, timestamp_ms: seg.timestamp_ms, source: seg.speaker }, seg.id);
        continue;
      }
      for (const {text: sentence, offset} of lineQuestions(seg.text)) {
        const id = seg.id + "#" + offset;
        const q = { text: sentence, confidence: 0.8, timestamp_ms: seg.timestamp_ms, source: seg.speaker };
        if (!store.addLineQuestion(q, id)) continue;
        // The line grew into another question after Auto-Answer answered it:
        // that answer was for an incomplete question and gives way. (Lines
        // with turn signals are handled on those signals.)
        const ref = store.autoAnswer;
        if (autoTrigger && ref && ref.segmentId === id && !sameQuestion(ref.question, sentence)) {
          store.setAutoAnswer(null);
          store.reviseLine(id, sentence);
          logAutoAnswer("withdrawn");
          void inTurn(() => stopAutoAnswer(ref));
        }
      }
    }
    // Back from a layout switch or Settings: what is unanswered now can be
    // minutes old, so it stays a card to click rather than getting answered.
    if (justMountedRef.current && panelSeen) holdBackUnanswered();
    justMountedRef.current = false;
    setPanelSeen();
  }, [segments, addQuestion, autoTrigger,local]);

  const handleAssist = useCallback((index: number) => {
    const question = questions[index];
    if (!question || question.requestId) return;
    // Its automatic answer is on the way: a click doesn't restart it.
    const store = useQuestionStore.getState();
    if (autoAnswerRunning() && store.autoAnswer?.segmentId === question.segmentId) return;
    store.markAssisted(index);
    runYourAction("Assist", question.text, undefined, question.segmentId).catch((err) => {
      // No answer came, so it stays a card to click.
      useQuestionStore.getState().holdBack(question.segmentId, question.text);
      showToast(String(err).includes(REFUSED) ? "Another answer is still running" : "Couldn't generate AI response", "error");
    });
  }, [questions]);

  const handleDismiss = useCallback((index: number, e: React.MouseEvent) => {
    e.stopPropagation();
    useQuestionStore.getState().dismiss(index);
  }, []);

  const visible = questions.filter(q => !q.dismissed && (isOtherParty(q.source) || q.manual));
  const latest = visible[0] || null;
  const latestStatus = latest?.requestId ? "Answering" : latest?.answer ? "Answered" : latest?.assisted ? "Sent" : "Assist";
  const previousQuestions = visible.slice(1, 4);

  // Settle the question itself. Unrelated narration must not postpone it.
  // Oldest first, so a second question arriving during generation waits its turn.
  const pending = questions.slice().reverse().find(q => (isOtherParty(q.source) || q.manual) && !q.dismissed && !q.assisted && !q.heldBack
    && !useQuestionStore.getState().isTurnLine(q.segmentId));
  const revising = pending && segments.some(seg => !seg.is_final && pending.segmentId?.startsWith(seg.id + "#")
    && !seg.text.includes(pending.text));
  const partialContinuation = pending && !/[.?!。？！]$/.test(pending.text) && segments.some(seg =>
    !seg.is_final && pending.segmentId?.startsWith(seg.id + "#"));
  useEffect(() => {
    if (!autoTrigger || !pending || busy || revising || partialContinuation) return;
    const timer = setTimeout(() => void inTurn(() => {
      if (answerRunning() || !useAIActionsStore.getState().configs.globalDefaults.autoTrigger) return;
      const store = useQuestionStore.getState();
      const index = store.questions.findIndex(q => q === pending);
      if (index < 0 || pending.assisted || pending.heldBack) return;
      store.markAssisted(index);
      startAutoAnswer(pending, pending.segmentId, false, "after the question settled");
    }), local && !pending.manual ? AUTO_TRIGGER_DELAY_MS : 0);
    return () => clearTimeout(timer);
  }, [autoTrigger, pending, busy, revising, partialContinuation, local]);

  return (
    <div className="flex flex-col gap-2.5" role="region" aria-label="Detected questions">
      <QuestionHistory mode={watch.mode} progress={watch.progress} onRetry={handleAssist} />
      {/* Latest question — prominent card */}
      <div
        className={`group flex items-start gap-3 rounded-lg transition-all duration-200 ${
          latest ? "cursor-pointer hover:bg-info/10 question-card-enter" : ""
        }`}
        onClick={() => latest && handleAssist(questions.indexOf(latest))}
        onKeyDown={(e) => { if (latest && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); handleAssist(questions.indexOf(latest)); } }}
        role={latest ? "button" : undefined}
        tabIndex={latest ? 0 : undefined}
        aria-label={latest ? `Question: ${latest.text}. ${latestStatus}` : undefined}
      >
        <div className="relative mt-0.5 shrink-0" aria-hidden="true">
          <HelpCircle className={`h-5 w-5 transition-colors ${latest ? "text-info" : "text-muted-foreground/50"}`} />
          {latest && !latest.assisted && (
            <span className="absolute -top-0.5 -right-0.5 h-2 w-2 rounded-full bg-info animate-pulse" />
          )}
          {latest?.assisted && (
            <span className="absolute -top-0.5 -right-0.5 flex h-3 w-3 items-center justify-center rounded-full bg-success">
              <Check className="h-2 w-2 text-white" />
            </span>
          )}
        </div>

        <div className="flex-1 min-w-0">
          {latest ? (
            <p className="line-clamp-2 text-sm leading-snug font-medium text-foreground/90" title={latest.text}>
              &ldquo;{latest.text}&rdquo;
            </p>
          ) : (
            <p className="text-xs text-muted-foreground/50">
              Listening for questions from the other party
            </p>
          )}
        </div>

        {latest && (
          <div className="flex shrink-0 items-center gap-1">
            <button
              onClick={(e) => { e.stopPropagation(); handleAssist(questions.indexOf(latest)); }}
              aria-label={latest.assisted ? latestStatus : "Get AI assistance for this question"}
              className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold transition-all duration-150 cursor-pointer ${
                latest.assisted
                  ? "bg-success/10 border border-success/20 text-success"
                  : "bg-info/10 border border-info/20 text-info hover:bg-info/20"
              }`}
            >
              {latest.assisted ? (
                <><Check className="h-3.5 w-3.5" aria-hidden="true" />{latestStatus}</>
              ) : (
                <><Sparkles className="h-3.5 w-3.5" aria-hidden="true" />Assist</>
              )}
            </button>
            <button
              onClick={(e) => handleDismiss(questions.indexOf(latest), e)}
              aria-label="Dismiss question"
              className="rounded-lg p-1.5 text-muted-foreground/30 opacity-0 transition-all duration-150 hover:bg-destructive/10 hover:text-destructive group-hover:opacity-100 cursor-pointer"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        )}
      </div>

      {/* Previous questions — compact list */}
      {previousQuestions.length > 0 && (
        <div className="hidden flex-col gap-1 sm:flex">
          {previousQuestions.map((q) => {
            const realIdx = questions.indexOf(q);
            return (
              <div
                key={`q-${realIdx}-${q.timestamp_ms}`}
                className={`group/q flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-left transition-all duration-150 question-card-enter ${
                  q.assisted
                    ? "bg-success/5 border border-success/10"
                    : "bg-card/20 hover:bg-card/40 hover:border-border/20 cursor-pointer"
                }`}
                onClick={() => !q.assisted && handleAssist(realIdx)}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); handleAssist(realIdx); } }}
                title={q.text}
              >
                <div className="shrink-0">
                  {q.assisted ? (
                    <div className="flex h-4 w-4 items-center justify-center rounded-full bg-success/20">
                      <Check className="h-2.5 w-2.5 text-success" />
                    </div>
                  ) : (
                    <div className="flex h-4 w-4 items-center justify-center rounded-full bg-muted/30">
                      <Clock className="h-2.5 w-2.5 text-muted-foreground/60" />
                    </div>
                  )}
                </div>

                <span className={`flex-1 truncate text-xs leading-snug transition-colors ${
                  q.assisted
                    ? "text-success/70 font-medium"
                    : "text-muted-foreground/60 group-hover/q:text-foreground/80"
                }`}>
                  {q.text}
                </span>

                {!q.assisted && (
                  <Sparkles className="h-3 w-3 shrink-0 text-info/0 group-hover/q:text-info/60 transition-colors" />
                )}
                <button
                  onClick={(e) => handleDismiss(realIdx, e)}
                  aria-label="Dismiss question"
                  className="rounded p-0.5 text-muted-foreground/0 opacity-0 transition-all duration-150 hover:bg-destructive/10 hover:text-destructive group-hover/q:opacity-100 group-hover/q:text-muted-foreground/30 cursor-pointer"
                >
                  <X className="h-3 w-3" />
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
