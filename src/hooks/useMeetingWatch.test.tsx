import { act, renderHook } from "@testing-library/react";
import { describe,expect,it,vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { scanBatch,useMeetingWatch } from "./useMeetingWatch";
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
