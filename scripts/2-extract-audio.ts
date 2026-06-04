import "dotenv/config";
import { readFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { spawn } from "node:child_process";

interface Lesson {
  id: string;
  lessonNumber: number | null;
  title: string;
  hlsUrl: string;
}

const lessons: Lesson[] = JSON.parse(readFileSync("data/lessons.json", "utf8"));
mkdirSync("data/audio", { recursive: true });

function run(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    p.stderr.on("data", (d) => (stderr += d));
    p.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd} exited ${code}\n${stderr.slice(-500)}`));
    });
  });
}

let done = 0;
for (const l of lessons) {
  const out = `data/audio/${String(l.lessonNumber ?? l.id).padStart(2, "0")}-${l.id}.wav`;
  if (existsSync(out) && statSync(out).size > 1000) {
    console.log(`skip #${l.lessonNumber} (already extracted)`);
    done++;
    continue;
  }
  console.log(`extracting #${l.lessonNumber} ${l.title}...`);
  // 16kHz mono PCM — Whisper's native input format. No re-encode needed downstream.
  await run("ffmpeg", [
    "-y",
    "-loglevel", "error",
    "-i", l.hlsUrl,
    "-vn",
    "-acodec", "pcm_s16le",
    "-ar", "16000",
    "-ac", "1",
    out,
  ]);
  const sizeMB = (statSync(out).size / 1024 / 1024).toFixed(1);
  console.log(`  -> ${out} (${sizeMB} MB)`);
  done++;
}

console.log(`\nExtracted ${done}/${lessons.length} audio files to data/audio/`);
