import "dotenv/config";
import { writeFileSync, mkdirSync } from "node:fs";
import { listFolderVideos, parseLessonTitle } from "../src/lib/panda.ts";

const folderId = process.env.PANDA_FOLDER_ID;
if (!folderId) throw new Error("PANDA_FOLDER_ID not set in .env");

const videos = await listFolderVideos(folderId);

const lessons = videos
  .map((v) => {
    const { lessonNumber, cleanTitle } = parseLessonTitle(v.title);
    return {
      id: v.id,
      lessonNumber,
      title: cleanTitle,
      rawTitle: v.title,
      durationSec: Math.round(v.length),
      embedUrl: v.video_player,
      hlsUrl: v.video_hls,
      thumbnailUrl: v.thumbnail,
      status: v.status,
    };
  })
  .sort((a, b) => (a.lessonNumber ?? 999) - (b.lessonNumber ?? 999));

mkdirSync("data", { recursive: true });
writeFileSync("data/lessons.json", JSON.stringify(lessons, null, 2));

console.log(`Saved ${lessons.length} lessons to data/lessons.json`);
for (const l of lessons) {
  const dur = `${Math.floor(l.durationSec / 60)}m${(l.durationSec % 60).toString().padStart(2, "0")}s`;
  console.log(`  #${String(l.lessonNumber ?? "?").padStart(2, "0")} [${dur}] ${l.title}`);
}
