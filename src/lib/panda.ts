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

/** Per-tenant API client. apiKey is required — pass tenant.pandaApiKey at
 *  runtime, or omit to fall back to process.env.PANDA_API_KEY (MVP scripts). */
export class PandaClient {
  constructor(private readonly apiKey: string) {
    if (!apiKey) throw new Error("PandaClient requires an API key");
  }

  static fromEnv(): PandaClient {
    const key = process.env.PANDA_API_KEY;
    if (!key) throw new Error("PANDA_API_KEY not set in .env");
    return new PandaClient(key);
  }

  private async get<T>(path: string, query: Record<string, string | number> = {}): Promise<T> {
    const url = new URL(BASE + path);
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, String(v));
    const res = await fetch(url, {
      headers: { Authorization: this.apiKey, Accept: "application/json" },
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Panda ${res.status} ${res.statusText} on ${path}: ${body}`);
    }
    return res.json() as Promise<T>;
  }

  async listFolderVideos(folderId: string): Promise<PandaVideo[]> {
    const out: PandaVideo[] = [];
    let page = 1;
    while (true) {
      const { videos, pages } = await this.get<{ videos: PandaVideo[]; pages: number; total: number }>(
        "/videos",
        { folder_id: folderId, limit: 100, page },
      );
      out.push(...videos);
      if (page >= pages) break;
      page++;
    }
    return out;
  }
}

// Legacy wrappers preserved for the MVP scripts/1-fetch-lessons.ts
export async function listFolderVideos(folderId: string): Promise<PandaVideo[]> {
  return PandaClient.fromEnv().listFolderVideos(folderId);
}

/**
 * Strips ".mp4" and the "05 Produtificação NN" prefix to get a friendlier display title.
 */
export function parseLessonTitle(raw: string): { lessonNumber: number | null; cleanTitle: string } {
  const noExt = raw.replace(/\.(mp4|mov|m4v)$/i, "").trim();
  const match = noExt.match(/^\d+\s+\S+\s+(\d+)\s+(.+)$/u);
  if (match) return { lessonNumber: parseInt(match[1], 10), cleanTitle: match[2].trim() };
  const fallback = noExt.match(/^(\d+)\s+(.+)$/);
  if (fallback) return { lessonNumber: parseInt(fallback[1], 10), cleanTitle: fallback[2].trim() };
  return { lessonNumber: null, cleanTitle: noExt };
}
