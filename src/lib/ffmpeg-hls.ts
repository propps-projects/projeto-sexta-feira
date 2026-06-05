/**
 * HLS → MP3 conversion via ffmpeg. ffmpeg follows the .m3u8 playlist and
 * downloads + concatenates segments natively; we get a single MP3 file
 * sized to fit Whisper's 25MB upload cap.
 *
 * Output: 32kbps mono 16kHz mp3 — preserves ASR-quality speech while
 * staying well under the cap (~250KB/min).
 */

import { spawn } from "node:child_process";
import { unlink } from "node:fs/promises";

export function spawnFfmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    p.stderr.on("data", (d) => (stderr += d));
    p.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited ${code}: ${stderr.slice(-600)}`));
    });
    p.on("error", (err) => reject(err));
  });
}

export async function hlsToMp3(hlsUrl: string, outPath: string): Promise<void> {
  await spawnFfmpeg([
    "-y",
    "-loglevel", "error",
    // Reconnect on network blips — HLS is chunked and can stall mid-segment.
    "-reconnect", "1",
    "-reconnect_streamed", "1",
    "-reconnect_delay_max", "10",
    "-i", hlsUrl,
    "-vn",                      // drop video
    "-ac", "1",                 // mono
    "-ar", "16000",             // 16kHz
    "-b:a", "32k",              // 32kbps
    "-codec:a", "libmp3lame",
    outPath,
  ]);
}

export async function safeUnlink(path: string): Promise<void> {
  try { await unlink(path); } catch { /* ignore */ }
}
