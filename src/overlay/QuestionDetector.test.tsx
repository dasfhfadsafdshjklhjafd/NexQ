import { invoke as tauriInvoke } from "@tauri-apps/api/core";
vi.mock("@tauri-apps/api/core", async (original) => ({...await original<typeof import("@tauri-apps/api/core")>(),invoke:vi.fn(async () => undefined)}));
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

// Transcript event handlers the component subscribes, so a test can send lines.
const listeners = vi.hoisted(() => ({
  update: [] as Array<(e: { segment: unknown }) => void>,
  final: [] as Array<(e: { segment: unknown }) => void>,
}));
vi.mock("../lib/events", () => {
  const subscribe = (list: Array<(e: { segment: unknown }) => void>) => (h: (e: { segment: unknown }) => void) => {
    list.push(h);
    return Promise.resolve(() => { list.splice(list.indexOf(h), 1); });
  };
  return {
    onQuestionDetected: () => Promise.resolve(() => {}),
    onTranscriptUpdate: subscribe(listeners.update),
    onTranscriptFinal: subscribe(listeners.final),
  };
});
vi.mock("../lib/userAction", () => ({ runUserAction: vi.fn(() => Promise.resolve()) }));
vi.mock("../lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/ipc")>()),
  cancelGeneration: vi.fn(() => Promise.resolve()),
}));

import { AUTO_TRIGGER_DELAY_MS, QuestionDetector, QuestionPanel, lastSentence, looksLikeQuestion, lineQuestions } from "./QuestionDetector";
import { runUserAction } from "../lib/userAction";
import { cancelGeneration } from "../lib/ipc";
import { useStreamStore } from "../stores/streamStore";
import { useAIActionsStore } from "../stores/aiActionsStore";
import { useQuestionStore } from "../stores/questionStore";
import { useToastStore } from "../stores/toastStore";
import { useConfigStore } from "../stores/configStore";
import { DEFAULT_SOURCES_CONFIG, useSourcesStore } from "../stores/sourcesStore";
import { resetMeetingScopedStores } from "../stores/resetMeeting";
import { useTranscriptStore } from "../stores/transcriptStore";
import type { GlobalDefaults, TranscriptSegment, TurnSignal } from "../lib/types";

const seg = (text: string, is_final = true): TranscriptSegment =>
  ({ id: "them_1", text, speaker: "Them", timestamp_ms: 1, is_final, confidence: 1 }) as TranscriptSegment;

function setDefaults(defaults: Partial<GlobalDefaults>) {
  const { configs } = useAIActionsStore.getState();
  useAIActionsStore.setState({ configs: { ...configs, globalDefaults: { ...configs.globalDefaults, ...defaults } } });
}

const setAutoTrigger = (on: boolean) => setDefaults({ autoTrigger: on });

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.mocked(runUserAction).mockReset().mockImplementation(() => Promise.resolve());
  vi.mocked(cancelGeneration).mockClear();
  useQuestionStore.getState().clear();
  useStreamStore.getState().resetForMeeting();
  listeners.update.length = 0;
  listeners.final.length = 0;
});

/** A line from the other party carrying a provider turn signal. */
const turnLine = (text: string, turn: TurnSignal, id = "them_t1"): TranscriptSegment =>
  ({ id, text, speaker: "Them", timestamp_ms: 1, is_final: turn === "end", confidence: 1, turn }) as TranscriptSegment;

/** Delivers a line as the transcript events do (store first, as useTranscript does). */
function send(line: TranscriptSegment) {
  act(() => {
    if (line.is_final) useTranscriptStore.setState({ segments: [line] });
    for (const h of [...(line.is_final ? listeners.final : listeners.update)]) h({ segment: line });
  });
}

/** Lets queued Auto-Answer steps (and their stops) finish. */
async function settle() {
  for (let i = 0; i < 6; i++) await act(async () => { await vi.advanceTimersByTimeAsync(0); });
}

/** Answers keep running until cancelled, like real streams. */
function answersRunUntilStopped() {
  const running = new Map<string, () => void>();
  vi.mocked(runUserAction).mockImplementation((_mode, _q, opts) => {
    const id = opts?.requestId ?? "?";
    useStreamStore.setState({ isStreaming: true, streamRequestId: id });
    return new Promise<void>((resolve) => running.set(id, resolve));
  });
  vi.mocked(cancelGeneration).mockImplementation(async (id) => {
    useStreamStore.setState({ isStreaming: false, streamRequestId: null });
    if (id) running.get(id)?.();
  });
}

const askedFor = () => vi.mocked(runUserAction).mock.calls.map((c) => c[1]);
const requestOf = (n: number) => vi.mocked(runUserAction).mock.calls[n][2]?.requestId;

describe("Auto-Answer with the provider's turn signals (Cartesia, Deepgram Flux)", () => {
  it("answers as soon as the provider says the speaker finished, with no quiet wait", async () => {
    vi.useFakeTimers();
    setAutoTrigger(true);
    render(<QuestionDetector />);
    send(turnLine("Thanks. What would you do first?", "end"));
    await settle();
    expect(askedFor()).toEqual(["What would you do first?"]);
    // The quiet wait doesn't answer it a second time.
    await act(async () => { await vi.advanceTimersByTimeAsync(AUTO_TRIGGER_DELAY_MS * 3); });
    expect(runUserAction).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Answering")).toBeTruthy();
  });

  it("starts early on 'probably done' and keeps that answer when the turn ends the same", async () => {
    vi.useFakeTimers();
    setAutoTrigger(true);
    render(<QuestionDetector />);
    send(turnLine("What would you do first?", "eager_end"));
    await settle();
    expect(askedFor()).toEqual(["What would you do first?"]);
    send(turnLine("What would you do first?", "end"));
    await settle();
    expect(runUserAction).toHaveBeenCalledTimes(1);
    expect(cancelGeneration).not.toHaveBeenCalled();
  });

  it("stops the early answer when they keep talking, and answers the whole question at the end", async () => {
    vi.useFakeTimers();
    setAutoTrigger(true);
    answersRunUntilStopped();
    render(<QuestionDetector />);
    send(turnLine("What would you do", "eager_end"));
    await settle();
    const early = requestOf(0);
    send(turnLine("What would you do", "resumed"));
    await settle();
    expect(cancelGeneration).toHaveBeenCalledWith(early);
    expect(screen.queryByText("Answered")).toBeNull();

    send(turnLine("What would you do if the build broke?", "end"));
    await settle();
    expect(askedFor()).toEqual(["What would you do", "What would you do if the build broke?"]);
  });

  it("replaces the early answer when the turn ends with a different question", async () => {
    vi.useFakeTimers();
    setAutoTrigger(true);
    answersRunUntilStopped();
    render(<QuestionDetector />);
    send(turnLine("What would you do?", "eager_end"));
    await settle();
    send(turnLine("What would you do if the build broke?", "end"));
    await settle();
    expect(cancelGeneration).toHaveBeenCalledWith(requestOf(0));
    expect(askedFor()).toEqual(["What would you do?", "What would you do if the build broke?"]);
  });

  it("never stops an answer you asked for: the question waits as a card to click", async () => {
    vi.useFakeTimers();
    setAutoTrigger(true);
    useStreamStore.setState({ isStreaming: true, streamRequestId: "yours" });
    render(<QuestionDetector />);
    send(turnLine("What would you do first?", "end"));
    await settle();
    await act(async () => { await vi.advanceTimersByTimeAsync(AUTO_TRIGGER_DELAY_MS * 3); });
    expect(runUserAction).not.toHaveBeenCalled();
    expect(cancelGeneration).not.toHaveBeenCalled();
    expect(screen.getByText(/What would you do first\?/)).toBeTruthy();
    expect(screen.queryByText("Answered")).toBeNull();
  });

  it("clicking another question during an automatic answer stops it and answers yours", async () => {
    vi.useFakeTimers();
    setAutoTrigger(true);
    answersRunUntilStopped();
    useQuestionStore.getState().addQuestion(
      { text: "Which database did you pick?", confidence: 1, timestamp_ms: 1, source: "Them" }, "them_old");
    useQuestionStore.getState().markAssisted(0);
    useQuestionStore.getState().holdBack("them_old", "Which database did you pick?");
    render(<QuestionDetector />);
    send(turnLine("What would you do first?", "end"));
    await settle();
    const automatic = requestOf(0);

    fireEvent.click(screen.getByText(/Which database did you pick\?/));
    await settle();
    expect(cancelGeneration).toHaveBeenCalledWith(automatic);
    expect(askedFor()).toEqual(["What would you do first?", "Which database did you pick?"]);
    // The question it stopped goes back to a card to click.
    expect(useQuestionStore.getState().questions[0]).toMatchObject({ assisted: false, heldBack: true });
  });

  it("clicking the question being answered doesn't restart its answer", async () => {
    vi.useFakeTimers();
    setAutoTrigger(true);
    answersRunUntilStopped();
    render(<QuestionDetector />);
    send(turnLine("What would you do first?", "end"));
    await settle();

    fireEvent.click(screen.getByRole("button", { name: /Question: What would you do first\?/ }));
    await settle();
    expect(cancelGeneration).not.toHaveBeenCalled();
    expect(runUserAction).toHaveBeenCalledTimes(1);
  });

  it("a click that gets no answer stays a card to click, and says why", async () => {
    vi.useFakeTimers();
    setAutoTrigger(false);
    vi.mocked(runUserAction).mockRejectedValue("Generation already in progress");
    useQuestionStore.getState().addQuestion(
      { text: "What would you do first?", confidence: 1, timestamp_ms: 1, source: "Them" }, "them_1");
    render(<QuestionDetector />);

    fireEvent.click(screen.getByRole("button", { name: /Question: What would you do first\?/ }));
    await settle();
    expect(screen.queryByText("Answered")).toBeNull();
    expect(useToastStore.getState().toasts.map((t) => t.message)).toContain("Another answer is still running");
  });

  it("answers nothing on turn signals with Auto-Answer off", async () => {
    vi.useFakeTimers();
    setAutoTrigger(false);
    render(<QuestionDetector />);
    send(turnLine("What would you do first?", "eager_end"));
    send(turnLine("What would you do first?", "end"));
    await settle();
    expect(runUserAction).not.toHaveBeenCalled();
  });
});

describe("Auto-Answer without turn signals (Deepgram Nova and the others)", () => {
  it("a refused automatic answer leaves the question to click, not marked answered", async () => {
    vi.useFakeTimers();
    setAutoTrigger(true);
    useStreamStore.setState({ isStreaming: true, streamRequestId: "yours" });
    useTranscriptStore.setState({ segments: [seg("What would you do first?")] });
    render(<QuestionDetector />);
    await act(async () => { await vi.advanceTimersByTimeAsync(AUTO_TRIGGER_DELAY_MS * 3); });
    await settle();
    expect(runUserAction).not.toHaveBeenCalled();
    expect(screen.queryByText("Answered")).toBeNull();
  });

  it("a line that grows into another question replaces the running automatic answer", async () => {
    vi.useFakeTimers();
    setAutoTrigger(true);
    answersRunUntilStopped();
    useTranscriptStore.setState({ segments: [seg("What would you do")] });
    render(<QuestionDetector />);
    await act(async () => { await vi.advanceTimersByTimeAsync(AUTO_TRIGGER_DELAY_MS); });
    await settle();
    expect(askedFor()).toEqual(["What would you do"]);

    act(() => useTranscriptStore.setState({ segments: [seg("What would you do if the build broke?")] }));
    await settle();
    expect(cancelGeneration).toHaveBeenCalledWith(requestOf(0));
    await act(async () => { await vi.advanceTimersByTimeAsync(AUTO_TRIGGER_DELAY_MS - 1); });
    expect(runUserAction).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    await settle();
    expect(askedFor()).toEqual(["What would you do", "What would you do if the build broke?"]);
  });
});

describe("Auto-Trigger", () => {
  it("answers a question once the other party has been quiet for a moment", () => {
    vi.useFakeTimers();
    setAutoTrigger(true);
    useTranscriptStore.setState({ segments: [seg("Thanks for joining. What would you do first?")] });
    render(<QuestionDetector />);
    act(() => vi.advanceTimersByTime(AUTO_TRIGGER_DELAY_MS - 100));
    expect(runUserAction).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(100));
    expect(runUserAction).toHaveBeenCalledWith("Assist", "What would you do first?", expect.anything());
    act(() => vi.advanceTimersByTime(AUTO_TRIGGER_DELAY_MS * 3));
    expect(runUserAction).toHaveBeenCalledTimes(1);
  });

  it("waits while they keep talking, and answers the finished question", () => {
    vi.useFakeTimers();
    setAutoTrigger(true);
    useTranscriptStore.setState({ segments: [seg("What would you do")] });
    render(<QuestionDetector />);
    act(() => vi.advanceTimersByTime(AUTO_TRIGGER_DELAY_MS - 500));
    act(() => useTranscriptStore.setState({ segments: [seg("What would you do if the build broke?", false)] }));
    act(() => vi.advanceTimersByTime(AUTO_TRIGGER_DELAY_MS - 500));
    act(() => useTranscriptStore.setState({ segments: [seg("What would you do if the build broke?")] }));
    act(() => vi.advanceTimersByTime(AUTO_TRIGGER_DELAY_MS - 1));
    expect(runUserAction).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(1));
    expect(runUserAction).toHaveBeenCalledWith("Assist", "What would you do if the build broke?", expect.anything());
  });

  it("only shows the question when turned off", () => {
    vi.useFakeTimers();
    setAutoTrigger(false);
    useTranscriptStore.setState({ segments: [seg("What would you do first?")] });
    render(<QuestionDetector />);
    act(() => vi.advanceTimersByTime(AUTO_TRIGGER_DELAY_MS * 3));
    expect(runUserAction).not.toHaveBeenCalled();
    expect(screen.getByText(/What would you do first\?/)).toBeTruthy();
  });
});

describe("QuestionPanel", () => {
  it("keeps detecting with Auto-Answer off, so the user picks what to answer", () => {
    vi.useFakeTimers();
    setDefaults({ questionDetection: true, autoTrigger: false });
    useTranscriptStore.setState({ segments: [seg("What would you do first?")] });
    render(<QuestionPanel />);
    act(() => vi.advanceTimersByTime(AUTO_TRIGGER_DELAY_MS * 3));
    expect(runUserAction).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Get AI assistance for this question" }));
    expect(runUserAction).toHaveBeenCalledWith("Assist", "What would you do first?", {questionId:"them_1#0"});
  });

  it("shows nothing and answers nothing with detection off", () => {
    vi.useFakeTimers();
    setDefaults({ questionDetection: false, autoTrigger: true });
    useTranscriptStore.setState({ segments: [seg("What would you do first?")] });
    render(<QuestionPanel />);
    act(() => vi.advanceTimersByTime(AUTO_TRIGGER_DELAY_MS * 3));
    expect(screen.queryByText(/What would you do first\?/)).toBeNull();
    expect(runUserAction).not.toHaveBeenCalled();
    setDefaults({ questionDetection: true });
  });
});

describe("QuestionPanel coming back (layout switch, Settings)", () => {
  const question = "What would you do first?";

  it("doesn't answer an answered question again, and still shows it as answered", () => {
    vi.useFakeTimers();
    setDefaults({ questionDetection: true, autoTrigger: true });
    useTranscriptStore.setState({ segments: [seg(question)] });
    const { unmount } = render(<QuestionPanel />);
    act(() => vi.advanceTimersByTime(AUTO_TRIGGER_DELAY_MS));
    expect(runUserAction).toHaveBeenCalledTimes(1);

    unmount();
    act(() => useQuestionStore.getState().finishTracked(requestOf(0)!, "Start with the requirements."));
    render(<QuestionPanel />);
    act(() => vi.advanceTimersByTime(AUTO_TRIGGER_DELAY_MS * 3));
    expect(runUserAction).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Answered" })).toBeTruthy();
  });

  it("shows a question asked while away without answering it, then answers the next one", () => {
    vi.useFakeTimers();
    setDefaults({ questionDetection: true, autoTrigger: true });
    useTranscriptStore.setState({ segments: [] });
    const { unmount } = render(<QuestionPanel />);
    unmount();

    useTranscriptStore.setState({ segments: [seg(question)] });
    render(<QuestionPanel />);
    act(() => vi.advanceTimersByTime(AUTO_TRIGGER_DELAY_MS * 3));
    expect(screen.getByText(/What would you do first\?/)).toBeTruthy();
    expect(runUserAction).not.toHaveBeenCalled();

    act(() => useTranscriptStore.setState({
      segments: [seg(question), { ...seg("And how long would it take?"), id: "them_2" }],
    }));
    act(() => vi.advanceTimersByTime(AUTO_TRIGGER_DELAY_MS));
    expect(runUserAction).toHaveBeenCalledWith("Assist", "And how long would it take?", expect.anything());
  });

  it("doesn't answer a question still waiting when the panel went away", () => {
    vi.useFakeTimers();
    setDefaults({ questionDetection: true, autoTrigger: true });
    useTranscriptStore.setState({ segments: [seg(question)] });
    const { unmount } = render(<QuestionPanel />);
    act(() => vi.advanceTimersByTime(AUTO_TRIGGER_DELAY_MS - 1));
    unmount();

    render(<QuestionPanel />);
    act(() => vi.advanceTimersByTime(AUTO_TRIGGER_DELAY_MS * 3));
    expect(runUserAction).not.toHaveBeenCalled();
    expect(screen.getByText(/What would you do first\?/)).toBeTruthy();
  });

  it("keeps a dismissed question dismissed", () => {
    setDefaults({ questionDetection: true, autoTrigger: false });
    useTranscriptStore.setState({ segments: [seg(question)] });
    const { unmount } = render(<QuestionPanel />);
    fireEvent.click(screen.getByRole("button", { name: "Dismiss question" }));
    unmount();

    render(<QuestionPanel />);
    expect(screen.queryByText(/What would you do first\?/)).toBeNull();
  });

  it("starts empty in a new meeting, and answers its first question", async () => {
    setDefaults({ questionDetection: true, autoTrigger: true });
    useTranscriptStore.setState({ segments: [seg(question)] });
    const { unmount } = render(<QuestionPanel />);
    expect(screen.getByText(/What would you do first\?/)).toBeTruthy();
    unmount();

    await resetMeetingScopedStores();
    vi.useFakeTimers();
    render(<QuestionPanel />);
    expect(screen.queryByText(/What would you do first\?/)).toBeNull();

    // Same line id as the last meeting's: the new meeting's line is still checked.
    act(() => useTranscriptStore.setState({ segments: [seg(question)] }));
    act(() => vi.advanceTimersByTime(AUTO_TRIGGER_DELAY_MS));
    expect(runUserAction).toHaveBeenCalledWith("Assist", question, expect.anything());
  });
});

describe("QuestionDetector", () => {
  it("checks the newest sentence of a line", () => {
    expect(lastSentence("So here's the situation. What would you do?")).toBe("What would you do?");
    expect(looksLikeQuestion(lastSentence("We run preview days. How many do you run"))).toBe(true);
  });

  it("finds Chinese and Japanese questions", () => {
    expect(lastSentence("今天讨论进度。计划完成了吗？")).toBe("计划完成了吗？");
    expect(lastSentence("ありがとうございます。\n準備できましたか")).toBe("準備できましたか");
    for (const q of ["计划完成了？", "准备好了吗", "你的计划呢", "這個問題怎麼解決", "准备什么时候发布", "いつ始めますか。", "一緒に行きませんか"]) {
      expect(looksLikeQuestion(q), q).toBe(true);
    }
    for (const s of ["会议结束了。", "我们开始吧", "没什么问题", "无论如何都要按时完成", "会議は終了しました。", "とても静か", "コーヒーとか"]) {
      expect(looksLikeQuestion(s), s).toBe(false);
    }
  });

  it("ignores a bare tag, which leaves nothing to answer", () => {
    for (const tag of ["Right?", "right", "Okay?", "Yeah, right?", "So, right?", "You know?", "Isn't it?", "Really?"]) {
      expect(looksLikeQuestion(tag), tag).toBe(false);
    }
    for (const q of ["Why?", "Is that right?", "Right now?", "And you?", "Can you start?"]) {
      expect(looksLikeQuestion(q), q).toBe(true);
    }
  });

  it("looks past a trailing tag for the question before it", () => {
    expect(lastSentence("Is that what you were thinking about? Right?")).toBe("Is that what you were thinking about?");
    expect(lastSentence("Can something change? Okay? Yeah, right?")).toBe("Can something change?");
    expect(lastSentence("Right?")).toBe("Right?");
  });

  it("finds a question a line gains after its first final", () => {
    useTranscriptStore.setState({ segments: [seg("So here's the situation.")] });
    render(<QuestionDetector />);
    expect(screen.queryByText(/What would you do/)).toBeNull();

    act(() => useTranscriptStore.setState({ segments: [seg("So here's the situation. What would you do?")] }));
    expect(screen.getByText(/What would you do\?/)).toBeTruthy();
  });
});

describe("continuous interviewer speech", () => {
  const q1 = "how would you deduplicate this table.";
  const q2 = "what would you build for our team?";
  const recap = "That was a clear answer to that interview question, when do you use an index? ";
  const intro = "Interview question number seven of our ten practice questions is, ";
  const first = recap + intro + q1 + " Here is an example. I bring experience. ";
  const both = first + "Interview question number eight is what would you build? for our team the speaker continues.";

  it("extracts the two new prompts and ignores retrospective narration", () => {
    expect(lineQuestions(both).map(q => q.text)).toEqual([q1, q2]);
    expect(lineQuestions(intro + "how would you deduplicate this...")).toEqual([]);
  });

  it("automatically drains later questions once each while the line grows and an answer is busy", async () => {
    vi.useFakeTimers();
    setAutoTrigger(true);
    answersRunUntilStopped();
    useTranscriptStore.setState({ segments: [] });
    render(<QuestionPanel />);
    send(seg(first));
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    send(seg(first + " Still explaining the answer."));
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    expect(askedFor()).toEqual([q1]);
    send(seg(both));
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    expect(askedFor()).toEqual([q1]);
    act(() => useStreamStore.setState({ isStreaming: false, phase: "idle" }));
    await act(async () => { await vi.advanceTimersByTimeAsync(AUTO_TRIGGER_DELAY_MS); });
    expect(askedFor()).toEqual([q1,q2]);
    expect(cancelGeneration).not.toHaveBeenCalled();
    act(() => useStreamStore.setState({ isStreaming: false, phase: "idle" }));
    send({ ...seg(both), id: "replayed", timestamp_ms: 5000 });
    await act(async () => { await vi.advanceTimersByTimeAsync(4000); });
    expect(askedFor()).toEqual([q1,q2]);
  });
});

describe("Personal sources and automatic answers", () => {
  const providerBefore = useConfigStore.getState().llmProvider;

  /** Claude subscription, a notes folder and a ready tool, both pills on. */
  function bothPillsOn() {
    useConfigStore.setState({ llmProvider: "claude_cli" });
    useSourcesStore.setState({
      config: {
        ...DEFAULT_SOURCES_CONFIG,
        notes_folders: [{ id: "f1", label: "Vault", path: "D:\Vault", enabled: true }],
        mcp_servers: [
          {
            id: "s1", key: "mira", label: "Mira", enabled: true, needs_sign_in: false, env: [],
            transport: { type: "stdio", command: "node", args: [] },
            tools: [{ name: "person_brief", full_name: "mcp__mira__person_brief", allowed: true }],
            last_check: { ok: true, tool_count: 1, error: null, checked_at_ms: 1 },
          },
        ],
      },
      toggles: { notes: true, tools: true },
    });
  }

  afterEach(() => {
    useConfigStore.setState({ llmProvider: providerBefore });
    useSourcesStore.setState({ config: DEFAULT_SOURCES_CONFIG, toggles: { notes: false, tools: false } });
  });

  it("Auto-Answer never sends sources, even with both pills on", async () => {
    vi.useFakeTimers();
    setAutoTrigger(true);
    bothPillsOn();
    render(<QuestionDetector />);
    send(turnLine("Thanks. What would you do first?", "end"));
    await settle();
    expect(askedFor()).toEqual(["What would you do first?"]);
    const opts = vi.mocked(runUserAction).mock.calls[0][2] as Record<string, unknown>;
    expect(opts).not.toHaveProperty("sources");
  });

  it("clicking a question card is your own request, so it sends the pills that are on", async () => {
    vi.useFakeTimers();
    setAutoTrigger(false);
    bothPillsOn();
    useQuestionStore.getState().addQuestion(
      { text: "Which database did you pick?", confidence: 1, timestamp_ms: 1, source: "Them" }, "them_old");
    render(<QuestionDetector />);
    fireEvent.click(screen.getByText(/Which database did you pick\?/));
    await settle();
    expect(vi.mocked(runUserAction)).toHaveBeenCalledWith(
      "Assist", "Which database did you pick?", { questionId:"them_old", sources: { notes: true, tools: true } },
    );
  });
});

describe("watcher outage in an active meeting", () => {
  it("answers each question once across busy replies, a permanently bad line and recovery", async () => {
    vi.useFakeTimers();
    const before = useConfigStore.getState();
    const previousDefaults = useAIActionsStore.getState().configs;
    useConfigStore.setState({llmProvider:"custom",llmModel:"interview",customLlmBaseUrl:"http://127.0.0.1:8000/v1"});
    setDefaults({questionDetection:true,autoTrigger:true});
    const old = {...seg("Why partition orders?"), id:"old"};
    const older = {...seg("How do joins work?"), id:"older", timestamp_ms:0};
    const bad = {...seg("How would you index sales?"),id:"bad",timestamp_ms:300000};
    const fresh = {...seg("Why sort invoices?"),id:"fresh",timestamp_ms:302000};
    useTranscriptStore.setState({segments:[older,old]});
    let busyReplies = 2;
    const invoke = vi.mocked(tauriInvoke);
    invoke.mockImplementation(async (_name,args) => {
      const payload = (args as {payload:{lines:{text:string}[]}|null}).payload;
      if (!payload) return {version:1};
      if (payload.lines.some(line => line.text === bad.text)) {
        if (busyReplies > 0) {busyReplies--; throw Error("Transcript watcher HTTP 409");}
        throw Error("Transcript watcher HTTP 502");
      }
      return {questions:payload.lines.map((line,i) => ({line:i,text:line.text,sameAs:null}))};
    });
    const advance = async (ms:number) => { await act(async () => {await vi.advanceTimersByTimeAsync(ms);}); await settle(); };
    const view = render(<QuestionDetector/>);
    try {
      await advance(250);
      await advance(250);
      expect(askedFor()).toEqual([older.text,old.text]);
      act(() => useTranscriptStore.setState({segments:[older,old,bad,fresh]}));
      for (let i=0;i<18;i++) await advance(1000);
      expect(askedFor()).toEqual([older.text,old.text,bad.text,fresh.text]);
      expect(useQuestionStore.getState().questions).toHaveLength(4);
      expect(screen.getByText(/4\/4 final lines checked/)).toBeTruthy();
      expect(screen.getByText(/AI watcher/)).toBeTruthy();
    } finally {
      view.unmount(); invoke.mockReset(); useConfigStore.setState(before);
      useTranscriptStore.getState().clearSegments(); useAIActionsStore.setState({configs:previousDefaults});
    }
  });
});
