import type { TranscriptSegment } from "./meeting-intelligence-store.js";

type SummaryResult = {
  summary: string;
  actionItems: string[];
  provider: string;
};

function normalizeText(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

function transcriptText(segments: TranscriptSegment[]) {
  return segments
    .filter((segment) => segment.isFinal && segment.text.trim())
    .map((segment) => {
      const speaker =
        segment.participantName?.trim() ||
        segment.participantIdentity?.trim() ||
        "Participant";
      return speaker + ": " + normalizeText(segment.text);
    });
}

function sentenceCandidates(lines: string[]) {
  const sentences: string[] = [];
  for (const line of lines) {
    const body = line.replace(/^[^:]{1,120}:\s*/, "");
    for (const sentence of body.split(/(?<=[.!?])\s+/)) {
      const clean = normalizeText(sentence);
      if (clean.length >= 24) sentences.push(clean);
    }
  }
  return sentences;
}

function unique(items: string[], limit: number) {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const item of items) {
    const key = item.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(item);
    if (result.length >= limit) break;
  }

  return result;
}

function extractiveSummary(
  segments: TranscriptSegment[],
  notes: string
): SummaryResult {
  const lines = transcriptText(segments);
  const sentences = sentenceCandidates(lines);
  const noteSentences = sentenceCandidates(
    notes.trim() ? [notes] : []
  );

  const keyPoints = unique(
    [...noteSentences, ...sentences],
    8
  );

  const actionPattern =
    /\b(action|todo|to-do|follow[ -]?up|need to|needs to|will|should|must|deadline|assign|owner|next step)\b/i;

  const actionItems = unique(
    [...noteSentences, ...sentences]
      .filter((sentence) => actionPattern.test(sentence))
      .map((sentence) => sentence.replace(/^[-•]\s*/, "")),
    10
  );

  if (keyPoints.length === 0) {
    return {
      summary:
        notes.trim() ||
        "No finalized transcript segments are available yet.",
      actionItems,
      provider: "tamishra-extractive"
    };
  }

  return {
    summary: keyPoints.join(" "),
    actionItems,
    provider: "tamishra-extractive"
  };
}

function summarizerConfig() {
  const endpoint =
    process.env.WORKSPACE_MEET_SUMMARY_ENDPOINT?.trim() || "";
  const secret =
    process.env.WORKSPACE_MEET_SUMMARY_SECRET?.trim() || "";

  return endpoint ? { endpoint, secret } : null;
}

export async function generateMeetingSummary(input: {
  roomName: string;
  title: string;
  segments: TranscriptSegment[];
  notes: string;
}): Promise<SummaryResult> {
  const fallback = extractiveSummary(input.segments, input.notes);
  const config = summarizerConfig();

  if (!config) return fallback;

  const transcript = transcriptText(input.segments)
    .join("\n")
    .slice(0, 120_000);

  try {
    const response = await fetch(config.endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(config.secret
          ? { authorization: "Bearer " + config.secret }
          : {})
      },
      body: JSON.stringify({
        task: "meeting-summary",
        roomName: input.roomName,
        title: input.title,
        transcript,
        notes: input.notes.slice(0, 50_000),
        output: {
          summary: "string",
          actionItems: "string[]"
        }
      }),
      signal: AbortSignal.timeout(30_000)
    });

    const body = await response.json().catch(() => ({})) as {
      summary?: unknown;
      actionItems?: unknown;
      provider?: unknown;
    };

    if (!response.ok || typeof body.summary !== "string") {
      return fallback;
    }

    return {
      summary: normalizeText(body.summary).slice(0, 20_000),
      actionItems: Array.isArray(body.actionItems)
        ? body.actionItems
            .map((item) => normalizeText(String(item)).slice(0, 2000))
            .filter(Boolean)
            .slice(0, 20)
        : fallback.actionItems,
      provider:
        typeof body.provider === "string" && body.provider.trim()
          ? body.provider.trim().slice(0, 120)
          : "tamishra-summary-endpoint"
    };
  } catch {
    return fallback;
  }
}
