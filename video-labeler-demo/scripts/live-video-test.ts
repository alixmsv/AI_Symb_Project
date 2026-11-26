/**
 * End-to-end test with the real model and a recorded run, without a browser.
 *
 * It plays a folder of frames (one JPEG per second, as the app sends them)
 * into a Gemini Live session, asks the model to look every few seconds like
 * the app does, applies its tool calls to the checklist, and prints the
 * result.
 *
 *   python scripts/make_test_video.py --frames <dir>
 *   npm run video-test -- <dir>/pen-assembly-correct complete
 *   npm run video-test -- <dir>/pen-assembly-spring-skipped skip:S2
 */
import { readdirSync, readFileSync } from "fs";
import { join } from "path";
import { GoogleGenAI, LiveServerMessage, Session } from "@google/genai";
import {
  createRun,
  openIssues,
  progress,
  startRun,
  summarizeState,
} from "../src/assembly/engine";
import {
  buildSyncMessage,
  buildTickMessage,
} from "../src/assembly/instructions";
import { buildLiveConfig, DEFAULT_MODEL } from "../src/assembly/liveConfig";
import { PEN_ASSEMBLY } from "../src/assembly/procedures";
import { executeTool, TurnGuard } from "../src/assembly/tools";

function readEnv(name: string): string | undefined {
  if (process.env[name]) {
    return process.env[name];
  }
  try {
    const file = readFileSync(join(__dirname, "..", ".env"), "utf8");
    const line = file
      .split(/\r?\n/)
      .find((l) => l.replace(/^﻿/, "").trim().startsWith(`${name}=`));
    return line?.slice(line.indexOf("=") + 1).trim().replace(/^["']|["']$/g, "");
  } catch {
    return undefined;
  }
}

const TICK_SECONDS = Number(process.env.TICK_SECONDS ?? 3);
const TURN_TIMEOUT_MS = 20000;
const GRACE_SECONDS = 8;

async function main() {
  const [frameDir, expectation = "complete"] = process.argv.slice(2);
  if (!frameDir) {
    console.error("Usage: npm run video-test -- <frames folder> [complete|skip:S2]");
    process.exit(1);
  }
  const apiKey = readEnv("REACT_APP_GEMINI_API_KEY");
  if (!apiKey) {
    console.error("No API key. Set REACT_APP_GEMINI_API_KEY in .env first.");
    process.exit(1);
  }
  const frames = readdirSync(frameDir)
    .filter((f) => f.toLowerCase().endsWith(".jpg"))
    .sort()
    .map((f) => readFileSync(join(frameDir, f)).toString("base64"));
  if (frames.length === 0) {
    console.error(`No .jpg frames in ${frameDir}`);
    process.exit(1);
  }

  const model = readEnv("REACT_APP_GEMINI_MODEL") || DEFAULT_MODEL;
  const mode = process.env.GUIDANCE === "coach" ? "coach" : "watch";
  const procedure = PEN_ASSEMBLY;
  let run = startRun(createRun(procedure), Date.now());

  const ai = new GoogleGenAI({ apiKey });
  let session: Session | null = null;
  let frameIndex = 0;
  let ready = false;
  let awaiting = false;
  let awaitingSince = 0;
  let lastTurnEnd = 0;
  let ticks = 0;
  let spoken = "";
  const guard = new TurnGuard();
  let finish: (reason: string) => void = () => {};
  const done = new Promise<string>((resolve) => {
    finish = resolve;
  });
  const clock = () => `[${String(frameIndex).padStart(2, " ")}s]`;

  const onmessage = (message: LiveServerMessage) => {
    if (message.setupComplete) {
      session?.sendRealtimeInput({ text: buildSyncMessage(procedure, run) });
      guard.begin("sync");
      ready = true;
      awaiting = true;
      awaitingSince = Date.now();
      return;
    }
    if (message.toolCall?.functionCalls) {
      const functionResponses = message.toolCall.functionCalls.map((fc) => {
        const args = fc.args as Record<string, unknown>;
        const refused = guard.check(fc.name ?? "", fc.args);
        if (refused) {
          console.log(
            `${clock()} REFUSED ${fc.name}(${JSON.stringify(args)}) -> ${refused.message}`
          );
          return { id: fc.id, name: fc.name, response: { result: refused } };
        }
        const { state, result } = executeTool(
          procedure,
          run,
          fc.name ?? "",
          fc.args,
          "ai",
          Date.now()
        );
        run = state;
        const what =
          fc.name === "log_observation"
            ? `sees: ${args.observation}`
            : `${fc.name}(${JSON.stringify(args)}) -> ${result.message}`;
        console.log(`${clock()} ${what}`);
        return { id: fc.id, name: fc.name, response: { result } };
      });
      session?.sendToolResponse({ functionResponses });
      awaiting = true;
      awaitingSince = Date.now();
      return;
    }
    const content = message.serverContent;
    if (!content) {
      return;
    }
    if (content.outputTranscription?.text) {
      spoken += content.outputTranscription.text;
    }
    if (content.turnComplete) {
      if (spoken.trim()) {
        console.log(`${clock()} AI says: "${spoken.trim()}"`);
      }
      spoken = "";
      awaiting = false;
      lastTurnEnd = Date.now();
      guard.begin("look");
    }
  };

  console.log(
    `Model ${model}, ${frames.length} frames, look every ${TICK_SECONDS}s, voice mode "${mode}"`
  );
  session = await ai.live.connect({
    model,
    config: buildLiveConfig(procedure, mode),
    callbacks: {
      onopen: () => {},
      onmessage,
      onerror: (e: any) => finish(`error: ${e?.message ?? e}`),
      onclose: (e: any) =>
        finish(`closed by server: ${e?.code ?? ""} ${e?.reason ?? ""}`),
    },
  });

  // one frame per second, like the app
  let afterEnd = 0;
  const frameTimer = setInterval(() => {
    if (!ready) {
      return;
    }
    if (frameIndex < frames.length) {
      session?.sendRealtimeInput({
        video: { data: frames[frameIndex], mimeType: "image/jpeg" },
      });
      frameIndex += 1;
    } else {
      // keep showing the last frame for a moment so the model can catch up
      session?.sendRealtimeInput({
        video: { data: frames[frames.length - 1], mimeType: "image/jpeg" },
      });
      afterEnd += 1;
      if (afterEnd >= GRACE_SECONDS && !awaiting) {
        finish("video finished");
      }
      if (afterEnd >= GRACE_SECONDS + 20) {
        finish("video finished (model still busy)");
      }
    }
  }, 1000);

  // ticks: same rules as useAssemblyMonitor
  const tickTimer = setInterval(() => {
    const now = Date.now();
    if (!ready || frameIndex === 0 || run.completedAt !== null) {
      return;
    }
    if (awaiting && now - awaitingSince < TURN_TIMEOUT_MS) {
      return;
    }
    if (now - lastTurnEnd < TICK_SECONDS * 1000) {
      return;
    }
    session?.sendRealtimeInput({ text: buildTickMessage(procedure, run, now) });
    guard.begin("look");
    ticks += 1;
    awaiting = true;
    awaitingSince = now;
  }, 250);

  const reason = await done;
  clearInterval(frameTimer);
  clearInterval(tickTimer);
  session.close();

  const { done: stepsDone, total } = progress(procedure, run);
  const issues = run.issues;
  console.log("\n--- result ---");
  console.log(`Ended: ${reason}. Ticks sent: ${ticks}.`);
  console.log(summarizeState(procedure, run));
  issues.forEach((i) =>
    console.log(
      `Alert ${i.id} [${i.severity}] ${i.type} on ${i.stepId ?? "-"} by ${
        i.source
      }: ${i.message}${i.resolvedAt ? ` (resolved: ${i.resolution})` : ""}`
    )
  );

  let ok: boolean;
  if (expectation.startsWith("skip:")) {
    const stepId = expectation.slice(5);
    ok = issues.some((i) => i.type === "skipped_step" && i.stepId === stepId);
    console.log(
      ok
        ? `PASS: the skipped step ${stepId} was caught.`
        : `FAIL: expected a skipped-step alert for ${stepId}.`
    );
  } else {
    ok = stepsDone === total && openIssues(run).length === 0;
    const falseAlarms = issues.length;
    console.log(
      ok
        ? `PASS: all ${total} steps recognised${
            falseAlarms ? `, but ${falseAlarms} false alarm(s) were raised on the way` : ", no alerts"
          }.`
        : `FAIL: ${stepsDone}/${total} steps recognised, ${openIssues(run).length} open alert(s).`
    );
  }
  process.exit(ok ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
