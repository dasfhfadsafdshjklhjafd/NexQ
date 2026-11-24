import { create } from "zustand";
import type { DetectedQuestion } from "../lib/types";

export interface TrackedQuestion extends DetectedQuestion {
  assisted: boolean;
  requestId?: string;
  answer?: string;
  failed?: boolean;
  dismissed?: boolean;
  variants?: string[];
  manual?: boolean;
  /** Transcript line the question came from (lines grow while someone talks). */
  segmentId?: string;
  /** Unanswered when the panel came back, so it may be old: Auto-Answer skips it. */
  heldBack?: boolean;
}

/** An automatic answer NexQ started, so it knows what it may stop. */
export interface AutoAnswerRef {
  requestId: string;
  /** Transcript line the question came from. */
  segmentId: string;
  question: string;
  /** Started on "probably done" and not yet confirmed by the turn's end. */
  early: boolean;
  /** Settles once the answer has finished, was stopped, or was refused. */
  done: Promise<void>;
}

/** Text of each final line when it was last checked for a question. */
const checkedText = new Map<string, string>();
// Keep identities after a card scrolls out or is dismissed. Reset per meeting.
const recentQuestions = new Map<string, { id: string; at: number }>();

/**
 * Lines from a provider that detects turns (Cartesia, Deepgram Flux): Auto-Answer
 * follows the provider's signals there, not the quiet wait.
 */
const turnLines = new Set<string>();

interface QuestionState {
  questions: TrackedQuestion[];
  /** Whether the question panel has looked at this meeting's transcript yet. */
  panelSeen: boolean;
  generation: number;
  queueSelection: (question: DetectedQuestion) => void;
  beginTracked: (text: string, requestId: string, segmentId?: string) => void;
  finishTracked: (requestId: string | null, answer: string) => void;
  rememberVariant: (id: string, text: string) => void;

  addQuestion: (question: DetectedQuestion, segmentId?: string) => void;
  addLineQuestion: (question: DetectedQuestion, segmentId: string) => boolean;
  /** Records a final line's text. False when it was already checked as it is. */
  checkLine: (id: string, text: string) => boolean;
  setPanelSeen: () => void;
  holdBackUnanswered: () => void;
  markAssisted: (index: number) => void;
  dismiss: (index: number) => void;
  clear: () => void;

  /** The newest automatic answer NexQ started (it may have finished since). */
  autoAnswer: AutoAnswerRef | null;
  setAutoAnswer: (ref: AutoAnswerRef | null) => void;
  /** Shows `question` as the line's question, answered (a new card if the line has none). */
  answerLine: (question: DetectedQuestion, segmentId: string) => void;
  /** The question stays a card to click; Auto-Answer leaves it alone. */
  holdBack: (segmentId: string | undefined, text: string) => void;
  /** The line's question became `text`: a new question, not answered yet. */
  reviseLine: (segmentId: string, text: string) => void;
  markTurnLine: (segmentId: string) => void;
  isTurnLine: (segmentId: string | undefined) => boolean;
}

// The panel unmounts on a layout switch and while Settings is open, so what it
// has found and answered lives here, for the meeting.
export const useQuestionStore = create<QuestionState>((set, get) => ({
  questions: [],
  panelSeen: false,
  generation: 0,
  queueSelection: (q) => set(state => {
    const existing = state.questions.find(p => p.text === q.text && p.source === q.source);
    if (existing?.requestId) return state;
    if (existing) return {questions:state.questions.map(p => p === existing ?
      {...p,manual:true,dismissed:false,heldBack:false,assisted:false,failed:false,answer:undefined} : p)};
    return {questions:[{...q,segmentId:crypto.randomUUID(),assisted:false,manual:true},...state.questions]};
  }),
  beginTracked: (text, requestId, segmentId) => set(state => {
    if (state.questions.some(q => q.requestId === requestId)) return state;
    const target = state.questions.find(q => !q.dismissed && q.text === text && (!segmentId || q.segmentId === segmentId));
    if (!target) return state;
    return {questions:state.questions.map(q => q === target ? {...q, assisted:true, requestId, failed:false} : q)};
  }),
  finishTracked: (requestId, answer) => set(state => {
    if (!requestId || !state.questions.some(q => q.requestId === requestId)) return state;
    return {questions:state.questions.map(q => q.requestId === requestId ?
      {...q, requestId:undefined, answer:answer || q.answer, assisted:!!answer, failed:!answer, heldBack:!answer} : q)};
  }),
  rememberVariant: (id, text) => set(state => ({questions:state.questions.map(q =>
    q.segmentId === id && q.text !== text && !q.variants?.includes(text)
      ? {...q,variants:[...(q.variants || []),text]} : q)})),
  autoAnswer: null,

  addQuestion: (q, segmentId) =>
    set((state) => {
      const prev = state.questions;
      // The same line grew: update its question in place (unless already answered).
      if (segmentId) {
        const i = prev.findIndex((p) => p.segmentId === segmentId);
        if (i >= 0) {
          if (prev[i].assisted || prev[i].text === q.text) return state;
          return { questions: prev.map((p, j) => (j === i ? { ...p, text: q.text, heldBack: false } : p)) };
        }
      }
      if (prev.length > 0 && prev[0].text === q.text && prev[0].source === q.source) return state;
      return { questions: [{ ...q, assisted: false, segmentId }, ...prev] };
    }),

  addLineQuestion: (q, id) => {
    const key = (/^(you|user)$/i.test(q.source) ? "you:" : "them:") + q.text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
    const previous = recentQuestions.get(key);
    if (previous && (previous.id === id || Math.abs(q.timestamp_ms - previous.at) <= 90_000)) return false;
    recentQuestions.set(key, { id, at: q.timestamp_ms });
    get().addQuestion(q, id);
    return true;
  },

  checkLine: (id, text) => {
    if (checkedText.get(id) === text) return false;
    checkedText.set(id, text);
    return true;
  },

  setPanelSeen: () => set({ panelSeen: true }),

  holdBackUnanswered: () =>
    set((state) => ({
      questions: state.questions.map((q) => (q.assisted ? q : { ...q, heldBack: true })),
    })),

  markAssisted: (index) =>
    set((state) => ({
      questions: state.questions.map((q, i) => (i === index ? { ...q, assisted: true } : q)),
    })),

  dismiss: (index) =>
    set((state) => ({ questions: state.questions.map((q,i) => i === index ? {...q,dismissed:true,heldBack:true} : q) })),

  clear: () => {
    checkedText.clear();
    recentQuestions.clear();
    turnLines.clear();
    set(s => ({ questions: [], panelSeen: false, autoAnswer: null, generation:s.generation+1 }));
  },

  setAutoAnswer: (ref) => set({ autoAnswer: ref }),

  answerLine: (q, segmentId) =>
    set((state) => {
      const i = state.questions.findIndex((p) => p.segmentId === segmentId);
      if (i < 0) {
        return { questions: [{ ...q, assisted: true, segmentId }, ...state.questions] };
      }
      return {
        questions: state.questions.map((p, j) =>
          j === i ? { ...p, text: q.text, assisted: true, heldBack: false } : p),
      };
    }),

  holdBack: (segmentId, text) =>
    set((state) => ({
      questions: state.questions.map((q) =>
        (segmentId !== undefined ? q.segmentId === segmentId : q.text === text)
          ? { ...q, assisted: false, heldBack: true }
          : q),
    })),

  reviseLine: (segmentId, text) =>
    set((state) => ({
      questions: state.questions.map((q) =>
        q.segmentId === segmentId ? { ...q, text, assisted: false, heldBack: false, requestId:undefined, answer:undefined, failed:false } : q),
    })),

  markTurnLine: (segmentId) => {
    turnLines.add(segmentId);
  },

  isTurnLine: (segmentId) => segmentId !== undefined && turnLines.has(segmentId),
}));
