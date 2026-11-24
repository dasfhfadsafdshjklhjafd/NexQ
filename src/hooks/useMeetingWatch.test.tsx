import { act, renderHook } from "@testing-library/react";
import { describe,expect,it,vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { currentScanPrefix,scanBatch,useMeetingWatch, stableScanPrefix } from "./useMeetingWatch";
import { useTranscriptStore } from "../stores/transcriptStore";
import { useConfigStore } from "../stores/configStore";
import { useQuestionStore } from "../stores/questionStore";
import { useStreamStore } from "../stores/streamStore";
import type { TranscriptSegment } from "../lib/types";

vi.mock("@tauri-apps/api/core",()=>({invoke:vi.fn()}));
const line = (id:string,text:string,timestamp_ms=120000):TranscriptSegment =>
  ({id,text,timestamp_ms,speaker:"Them",is_final:true,confidence:1});

describe("meeting watcher",() => {
  it("revisits changed text and advances across long lines without dropping their middle",() => {
    const text = "abc ".repeat(2700);
    const checked = new Map<string,string>();
    while (checked.get("a") !== text) {
      const step = scanBatch([line("a",text)],checked).batch[0];
      expect(step.prefix.length).toBeGreaterThan(checked.get("a")?.length || 0);
      checked.set("a",step.prefix);
    }
    expect(scanBatch([line("a",text)],checked).batch).toHaveLength(0);
    expect(scanBatch([line("a",text.replace("abc","xyz"))],checked).batch[0].text.startsWith("xyz")).toBe(true);
  });
  it("sends only new words after an append, with the previous sentence as context",() => {
    const prior = "Why use an index? Now how";
    const result = scanBatch([line("a",prior+" does it affect writes?")],new Map([["a",prior]]));
    expect(result.batch[0].text).toBe(" does it affect writes?");
    expect(result.context).toContain(prior);
  });
  it("keeps an active request attached to its row through repeated clicks and cancellation",() => {
    const store = useQuestionStore.getState();
    store.clear();
    store.addWatchedQuestion({text:"Why?",timestamp_ms:1,source:"Them",confidence:1});
    const id = useQuestionStore.getState().questions[0].segmentId!;
    store.beginTracked("Why?","first",id);
    store.beginTracked("Why?","another",id);
    expect(useQuestionStore.getState().questions[0].requestId).toBe("first");
    store.holdBack(id,"Why?");
    store.finishTracked("first","");
    expect(useQuestionStore.getState().questions[0]).toMatchObject({heldBack:true,requestId:undefined,failed:false});
    store.clear();
  });
  it("scans a question once after two agreeing provisional updates and reconciles its final",async () => {
    vi.useFakeTimers();
    const before = useConfigStore.getState();
    useQuestionStore.getState().clear(); useTranscriptStore.getState().clearSegments();
    useConfigStore.setState({llmProvider:"custom",llmModel:"interview",customLlmBaseUrl:"http://127.0.0.1:8000/v1"});
    const scan = vi.mocked(invoke);
    scan.mockReset().mockResolvedValueOnce({version:1}).mockResolvedValueOnce({questions:[{line:0,text:"How do you index orders?",sameAs:null}]}).mockResolvedValue({questions:[]});
    const view = renderHook(()=>useMeetingWatch(true));
    const update = async (text:string,final=false) => {
      act(()=>useTranscriptStore.setState({segments:[{...line("preview",text),is_final:final}]}));
      await act(async()=>{await vi.advanceTimersByTimeAsync(900);});
    };
    try {
      await update("How do you index users?");
      await update("How do you index orders?");
      expect(useQuestionStore.getState().questions).toHaveLength(0);
      await update("How do you index orders? Suppose the table grows.");
      expect(useQuestionStore.getState().questions).toHaveLength(1);
      expect(view.result.current.progress.count).toBe(0);
      await update("How do you index orders? Suppose the table grows.",true);
      expect(view.result.current.progress.count).toBe(1);
      expect(useQuestionStore.getState().questions).toHaveLength(1);
      const last = scan.mock.calls[scan.mock.calls.length-1][1] as {payload:{lines:{text:string}[]}};
      expect(last.payload.lines[0].text).toBe(" Suppose the table grows.");
    } finally {
      view.unmount(); scan.mockReset(); useQuestionStore.getState().clear(); useTranscriptStore.getState().clearSegments();
      useConfigStore.setState(before); vi.useRealTimers();
    }
  });
  it("scans during an answer, groups a restatement and retains a distinct follow-up",async () => {
    vi.useFakeTimers();
    const before = useConfigStore.getState();
    useQuestionStore.getState().clear();
    useTranscriptStore.setState({segments:[line("a","How do you partition it?")]});
    useConfigStore.setState({llmProvider:"custom",llmModel:"interview-now",customLlmBaseUrl:"http://127.0.0.1:8000/v1"});
    const mock = vi.mocked(invoke);
    mock.mockResolvedValueOnce({version:1}).mockResolvedValueOnce({questions:[{line:0,text:"How do you partition it?",sameAs:null}]});
    const view = renderHook(()=>useMeetingWatch(true));
    try {
      await act(async()=>{await vi.advanceTimersByTimeAsync(100);});
      expect(view.result.current.progress.count).toBe(1);
      useStreamStore.setState({isStreaming:true});
      const target = useQuestionStore.getState().questions[0];
      useQuestionStore.getState().beginTracked(target.text,"r1");
      mock.mockResolvedValueOnce({questions:[
        {line:0,text:"What is your partition strategy?",sameAs:0},
        {line:0,text:"How do late arrivals affect it?",sameAs:null}
      ]});
      act(()=>useTranscriptStore.setState({segments:[line("a","How do you partition it?"),
        line("b","What is your partition strategy? How do late arrivals affect it?",180000)]}));
      await act(async()=>{await vi.advanceTimersByTimeAsync(900);});
      const state = useQuestionStore.getState();
      expect(view.result.current.progress).toEqual({count:2,at:180000});
      expect(state.questions).toHaveLength(2);
      expect(state.questions[1].variants).toEqual(["What is your partition strategy?"]);
      expect(state.questions[1].answer).toBeUndefined();
      state.finishTracked("r1","Partition by event date.");
      expect(useQuestionStore.getState().questions[1].answer).toBe("Partition by event date.");
    } finally {
      view.unmount(); useQuestionStore.getState().clear(); useTranscriptStore.getState().clearSegments();
      useConfigStore.setState(before); useStreamStore.getState().resetForMeeting(); vi.useRealTimers();
    }
  });
});


it("waits for a stable statement boundary and then releases an imperative to the watcher", () => {
  expect(stableScanPrefix("Previous clause. Routine narration.", "Previous clause. Routine narration. More words")).toBe("Previous clause.");
  expect(stableScanPrefix("Other candidates can't.", "Other candidates can't. Next")).toBe("Other candidates can't.");
  expect(stableScanPrefix("Can teams own it?", "When can teams own it?")).toBe("");
  expect(stableScanPrefix("Who runs   this?", "Who runs this?")).toBe("Who runs this?");
  expect(stableScanPrefix("Tell me about sales.", "Tell me about support.")).toBe("");
  expect(stableScanPrefix("Tell me about support.", "Tell me about support. ")).toBe("");
  expect(stableScanPrefix("Tell me about support.", "Tell me about support. For example")).toBe("Tell me about support.");
});

it("retains a completed question across capitalization updates without accepting changed words", () => {
  expect(currentScanPrefix("Why work for US. Next up", "Why work for us.")).toBe("Why work for US.");
  expect(currentScanPrefix("Why wait for us. Next up", "Why work for us.")).toBeUndefined();
  expect(currentScanPrefix("Why work", "Why work for us.")).toBeUndefined();
  const text = "Why work for US. Next question.";
  expect(scanBatch([line("a",text)],new Map([["a","Why work for us."]])).batch[0].text).toBe(" Next question.");
});
