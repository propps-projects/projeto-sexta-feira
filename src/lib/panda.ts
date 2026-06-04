import "dotenv/config";

const BASE = "https://api-v2.pandavideo.com.br";

export interface PandaVideo {
  id: string;
  title: string;
  description: string;
  status: string;
  folder_id: string;
  length: number;
  video_player: string;
  video_hls: string;
  thumbnail: string;
  preview: string;
  width: number;
  height: number;
  playable: boolean;
  created_at: string;
}

function apiKey(): string {
  const key = process.env.PANDA_API_KEY;
  if (!key) throw new Error("PANDA_API_KEY not set in .env");
  return key;
}

async function pandaGet<T>(path: string, query: Record<string, string | number> = {}): Promise<T> {
  const url = new URL(BASE + path);
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, String(v));
  const res = await fetch(url, {
    headers: { Authorization: apiKey(), Accept: "application/json" },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Panda ${res.status} ${res.statusText} on ${path}: ${body}`);
  }
  return res.json() as Promise<T>;
}

export async function listFolderVideos(folderId: string): Promise<PandaVideo[]> {
  const out: PandaVideo[] = [];
  let page = 1;
  while (true) {
    const { videos, pages } = await pandaGet<{ videos: PandaVideo[]; pages: number; total: number }>(
      "/videos",
      { folder_id: folderId, limit: 100, page },
    );
    out.push(...videos);
    if (page >= pages) break;
    page++;
  }
  return out;
}

/**
 * Strips ".mp4" and the "05 Produtificação NN" prefix to get a friendlier display title.
 * Returns { lessonNumber, cleanTitle }.
 */
export function parseLessonTitle(raw: string): { lessonNumber: number | null; cleanTitle: string } {
  const noExt = raw.replace(/\.(mp4|mov|m4v)$/i, "").trim();
  // Matches "05 Produtificação 13 Escalonamento" — module + topic name + lesson number + title
  const match = noExt.match(/^\d+\s+\S+\s+(\d+)\s+(.+)$/u);
  if (match) return { lessonNumber: parseInt(match[1], 10), cleanTitle: match[2].trim() };
  const fallback = noExt.match(/^(\d+)\s+(.+)$/);
  if (fallback) return { lessonNumber: parseInt(fallback[1], 10), cleanTitle: fallback[2].trim() };
  return { lessonNumber: null, cleanTitle: noExt };
}
