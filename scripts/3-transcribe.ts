import "dotenv/config";
import { readFileSync, writeFileSync, existsSync, mkdirSync, openAsBlob, statSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";

interface Lesson {
  id: string;
  lessonNumber: number | null;
  title: string;
  durationSec: number;
}

interface Segment { start: number; end: number; text: string }
interface Transcript {
  lessonId: string;
  lessonNumber: number | null;
  title: string;
  language: string;
  durationSec: number;
  segments: Segment[];
  fullText: string;
}

// OpenAI's verbose_json shape (the only response_format that returns timestamped segments).
interface OpenAIVerboseJson {
  task: string;
  language: string;
  duration: number;
  text: string;
  segments: Array<{ id: number; start: number; end: number; text: string }>;
}

const apiKey = process.env.OPENAI_API_KEY;
if (!apiKey || apiKey.startsWith("sk-REPLACE")) throw new Error("OPENAI_API_KEY not set in .env");
const language = process.env.COURSE_LANG || "pt";

const lessons: Lesson[] = JSON.parse(readFileSync("data/lessons.json", "utf8"));
mkdirSync("data/transcripts", { recursive: true });

function run(cmd: string, args: string[]): Promise<void> {
  return new Promise((res, rej) => {
    const p = spawn(cmd, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    p.stderr.on("data", (d) => (stderr += d));
    p.on("close", (code) => (code === 0 ? res() : rej(new Error(`${cmd} exited ${code}: ${stderr.slice(-500)}`))));
  });
}

function basename(lesson: Lesson) {
  return `${String(lesson.lessonNumber ?? lesson.id).padStart(2, "0")}-${lesson.id}`;
}

/**
 * Compress 16kHz mono WAV → 32kbps mono mp3 in a temp file.
 * Brings every lesson well under the 25 MB OpenAI upload cap and keeps ASR quality fine for speech.
 */
async function toMp3(wavAbsPath: string, lessonBase: string): Promise<string> {
  const out = resolve(tmpdir(), `agentclass-${lessonBase}.mp3`);
  if (existsSync(out)) unlinkSync(out);
  await run("ffmpeg", [
    "-y",
    "-loglevel", "error",
    "-i", wavAbsPath,
    "-vn",
    "-ac", "1",
    "-ar", "16000",
    "-b:a", "32k",
    "-codec:a", "libmp3lame",
    out,
  ]);
  return out;
}

async function transcribe(mp3Path: string, lessonTitle: string): Promise<OpenAIVerboseJson> {
  const form = new FormData();
  form.append("file", await openAsBlob(mp3Path), `${lessonTitle}.mp3`);
  form.append("model", "whisper-1");
  form.append("language", language);
  form.append("response_format", "verbose_json");
  // Bias the model with course context so it spells domain terms consistently.
  form.append("prompt", "Curso de Produtificação. Termos: ICP, funil de consciência, funil de prontidão, esteira de produção, recorrência, escalonamento, validação de conceito.");

  const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  });
  if (!res.ok) throw new Error(`OpenAI ${res.status}: ${await res.text()}`);
  return res.json() as Promise<OpenAIVerboseJson>;
}

for (const lesson of lessons) {
  const base = basename(lesson);
  const audioPath = resolve(`data/audio/${base}.wav`);
  const outPath = resolve(`data/transcripts/${base}.json`);

  if (existsSync(outPath)) {
    console.log(`skip #${lesson.lessonNumber} (transcript exists)`);
    continue;
  }
  if (!existsSync(audioPath)) {
    console.warn(`skip #${lesson.lessonNumber} — audio missing at ${audioPath}`);
    continue;
  }

  console.log(`\n=== #${lesson.lessonNumber} ${lesson.title} (${lesson.durationSec}s) ===`);
  const t0 = Date.now();

  console.log(`  compressing to mp3...`);
  const mp3 = await toMp3(audioPath, base);
  const mp3Mb = (statSync(mp3).size / 1024 / 1024).toFixed(1);
  console.log(`  -> ${mp3Mb} MB; uploading to Whisper...`);

  const result = await transcribe(mp3, lesson.title);
  unlinkSync(mp3);

  const transcript: Transcript = {
    lessonId: lesson.id,
    lessonNumber: lesson.lessonNumber,
    title: lesson.title,
    language: result.language || language,
    durationSec: Math.round(result.duration ?? lesson.durationSec),
    segments: result.segments.map((s) => ({ start: s.start, end: s.end, text: s.text.trim() })),
    fullText: result.text.trim(),
  };
  writeFileSync(outPath, JSON.stringify(transcript, null, 2));

  const sec = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`  ✓ ${transcript.segments.length} segments in ${sec}s -> ${outPath}`);
}

console.log(`\nDone. Transcripts in data/transcripts/`);
