/**
 * Connection check for the assembly monitor, without a browser or camera.
 *
 * It opens a Gemini Live session with the same model, system instruction and
 * tools the app uses, sends the checklist plus a few "tick" messages, answers
 * the model's tool calls, and prints what happened.
 *
 * Run from video-labeler-demo/:  npm run smoke
 */
import { readFileSync } from "fs";
import { join } from "path";
import { GoogleGenAI, LiveServerMessage, Session } from "@google/genai";
import { createRun, startRun } from "../src/assembly/engine";
import {
  buildSyncMessage,
  buildTickMessage,
} from "../src/assembly/instructions";
import { buildLiveConfig, DEFAULT_MODEL } from "../src/assembly/liveConfig";
import { PEN_ASSEMBLY } from "../src/assembly/procedures";
import { blockedWithoutVideo, executeTool } from "../src/assembly/tools";

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

const TICKS = 3;
const TIMEOUT_MS = 60000;

async function main() {
  const apiKey = readEnv("REACT_APP_GEMINI_API_KEY");
  if (!apiKey || apiKey.includes("your_gemini_api_key")) {
    console.error("No API key. Set REACT_APP_GEMINI_API_KEY in .env first.");
    process.exit(1);
  }
  const model = readEnv("REACT_APP_GEMINI_MODEL") || DEFAULT_MODEL;
  const procedure = PEN_ASSEMBLY;
  let run = startRun(createRun(procedure), Date.now());

  const ai = new GoogleGenAI({ apiKey });
  let session: Session | null = null;
  let ticksSent = 0;
  let toolCalls = 0;
  let blockedCalls = 0;
  let audioChunks = 0;
  let spoken = "";
  let finish: (reason: string) => void = () => {};
  const done = new Promise<string>((resolve) => {
    finish = resolve;
  });

  const sendTick = () => {
    ticksSent += 1;
    const text = buildTickMessage(procedure, run, Date.now());
    console.log(`\n> ${text}`);
    session?.sendRealtimeInput({ text });
  };

  const onmessage = (message: LiveServerMessage) => {
    if (message.setupComplete) {
      console.log("Setup complete: the model accepted the configuration.");
      const sync = buildSyncMessage(procedure, run);
      console.log(`\n> ${sync}`);
      session?.sendRealtimeInput({ text: sync });
      return;
    }
    if (message.toolCall?.functionCalls) {
      const functionResponses = message.toolCall.functionCalls.map((fc) => {
        toolCalls += 1;
        // this check sends no video, so the app's no-picture guard applies
        const blocked = blockedWithoutVideo(fc.name ?? "");
        if (blocked) {
          blockedCalls += 1;
          console.log(`< tool ${fc.name}(${JSON.stringify(fc.args)})`);
          console.log(`  -> refused: no picture is being sent`);
          return { id: fc.id, name: fc.name, response: { result: blocked } };
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
        console.log(`< tool ${fc.name}(${JSON.stringify(fc.args)})`);
        console.log(`  -> ${result.message}`);
        return { id: fc.id, name: fc.name, response: { result } };
      });
      session?.sendToolResponse({ functionResponses });
      return;
    }
    const content = message.serverContent;
    if (!content) {
      return;
    }
    if (content.outputTranscription?.text) {
      spoken += content.outputTranscription.text;
    }
    audioChunks +=
      content.modelTurn?.parts?.filter((p) => p.inlineData).length ?? 0;
    if (content.turnComplete) {
      if (spoken.trim()) {
        console.log(`< AI said: "${spoken.trim()}"`);
      }
      spoken = "";
      console.log("< turn complete");
      if (ticksSent < TICKS) {
        setTimeout(sendTick, 1000);
      } else {
        finish("finished");
      }
    }
  };

  console.log(`Connecting to ${model} ...`);
  session = await ai.live.connect({
    model,
    config: buildLiveConfig(procedure, "coach"),
    callbacks: {
      onopen: () => console.log("Connection open."),
      onmessage,
      onerror: (e: any) => finish(`error: ${e?.message ?? e}`),
      onclose: (e: any) =>
        finish(`closed by server: ${e?.code ?? ""} ${e?.reason ?? ""}`),
    },
  });

  const timer = setTimeout(() => finish("timeout"), TIMEOUT_MS);
  const reason = await done;
  clearTimeout(timer);
  session.close();

  console.log("\n---");
  console.log(`Ended: ${reason}`);
  console.log(
    `Ticks sent: ${ticksSent}, tool calls received: ${toolCalls}, audio chunks: ${audioChunks}`
  );
  if (blockedCalls > 0) {
    console.log(
      `Note: the model tried ${blockedCalls} checklist update(s) without seeing any video. The app refuses these.`
    );
  }
  const ok = reason === "finished" && toolCalls > 0;
  console.log(
    ok
      ? "PASS: the connection works and the model answers with tool calls."
      : "FAIL: see the output above."
  );
  process.exit(ok ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
