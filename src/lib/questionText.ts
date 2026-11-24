// Chinese and Japanese question signals, kept in step with
// src-tauri/src/intelligence/question_detector.rs.
const CHINESE_QUESTION_WORDS = ["什么", "什麼", "怎么", "怎麼", "为什么", "為什麼", "哪", "谁", "誰", "多少", "如何"];
// A question word meaning "any" or "no matter" (没什么问题, 无论如何) doesn't ask anything.
const CHINESE_NON_QUESTION_PHRASES = [
  "没什么", "沒什麼", "什么都", "什麼都", "什么也", "什麼也", "不怎么", "不怎麼",
  "哪怕", "谁都", "誰都", "谁也", "誰也", "无论", "無論", "不管", "多多少少",
];
// A bare か also ends ordinary words (静か, 確か, とか).
const JAPANESE_QUESTION_ENDINGS = ["ですか", "ますか", "ませんか", "でしたか", "ましたか", "でしょうか", "ましょうか", "のか", "ないか"];

// A tag on its own ("Right?", "You know?") asks nothing the AI could answer.
const TAG_QUESTIONS = new Set([
  "right", "okay", "ok", "yeah", "yep", "yes", "no", "nope", "sure", "correct", "true", "really",
  "agreed", "alright", "all right", "huh", "hmm", "hm", "eh", "see", "you see", "you know",
  "isn't it", "sorry", "pardon", "hello", "cool", "good",
]);
const TAG_LEAD_INS = new Set(["and", "so", "but", "well", "oh", "um", "uh", "okay", "ok", "yeah", "yes", "no"]);

function isTagQuestion(sentence: string): boolean {
  const words = sentence.toLowerCase().split(/[\s,.?？!…]+/u).filter(Boolean);
  while (words.length > 1 && TAG_LEAD_INS.has(words[0])) words.shift();
  return TAG_QUESTIONS.has(words.join(" "));
}

function isCjkQuestion(sentence: string): boolean {
  const body = sentence.replace(/[.!。！…]+$/u, "");
  return /[吗嗎呢]$/u.test(body)
    || JAPANESE_QUESTION_ENDINGS.some((ending) => body.endsWith(ending))
    || (CHINESE_QUESTION_WORDS.some((word) => body.includes(word))
      && !CHINESE_NON_QUESTION_PHRASES.some((phrase) => body.includes(phrase)));
}

export function looksLikeQuestion(text: string): boolean {
  const trimmed = text.trim();
  if (isTagQuestion(trimmed)) return false;
  if (/[?？]$/u.test(trimmed) || isCjkQuestion(trimmed)) return true;
  const lower = trimmed.toLowerCase();
  const qWords = [
    "what ", "how ", "why ", "when ", "where ", "who ", "which ",
    "can you", "could you", "would you", "do you", "are you",
    "is there", "have you", "tell me", "explain",
  ];
  return qWords.some((w) => lower.startsWith(w));
}

/**
 * The newest sentence of a transcript line. Lines grow into paragraphs, so a
 * question is usually the last sentence, not the whole line. A tag after it
 * ("Is that what you meant? Right?") doesn't count as the newest sentence.
 */
export function lastSentence(text: string): string {
  const sentences = text.trim().match(/[^.?!。？！\n]+[.?!。？！]*/gu) ?? [];
  let last = sentences.length - 1;
  while (last > 0 && isTagQuestion(sentences[last])) last--;
  return (sentences[last] ?? "").trim();
}

/** Find each prompt in a growing ASR paragraph, even between runs of narration. */
export function lineQuestions(line: string): { text: string; offset: number }[] {
  const result: { text: string; offset: number }[] = [];
  for (const part of line.matchAll(/[^.?!。？！\n]+[.?!。？！]*/gu)) {
    const raw = part[0].trim();
    // Interview tutorials often quote the last prompt while reviewing its answer.
    if (/\b(?:answer|response)\s+to\s+(?:that|the|this|your|our|my|the previous|the last)\s+(?:interview\s+)?question\b/i.test(raw)) continue;
    const intro = /\b(?:interview\s+)?question\s+(?:(?:number\s+)?(?:\d+|[a-z]+(?:-[a-z]+)?)(?:\s+of\b[^.!?]{0,120}?)?\s+)?(?:is|asks?)\s*[:,–—-]?\s+|\b(?:next|first|last|interview)\s+question\s*[:,–—-]\s*/i.exec(raw);
    let text = intro ? raw.slice(intro.index + intro[0].length).trim() : raw;
    if (!text || /(?:\.{2,}|…)$/.test(text)) continue;
    if (!looksLikeQuestion(text) && /^(?:and|so|okay|now)[,\s]+/i.test(text)) {
      const stripped = text.replace(/^(?:and|so|okay|now)[,\s]+/i, "");
      if (looksLikeQuestion(stripped)) text = stripped;
    }
    if (!looksLikeQuestion(text)) continue;
    // A short prepositional complement sometimes lands just beyond a spurious question mark.
    if (/\?$/.test(text)) {
      const tail = line.slice(part.index! + part[0].length);
      const complement = /^\s+((?:for|with|at|from|to)\s+(?:us|them|you|him|her|me|this company|our company|our team))\b/i.exec(tail);
      if (complement && /^[a-z]/.test(complement[1])) text = text.slice(0, -1) + " " + complement[1] + "?";
    }
    result.push({ text, offset: part.index! + part[0].search(/\S/) });
  }
  return result;
}

