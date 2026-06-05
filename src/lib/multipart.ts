/**
 * Tiny wrapper around busboy for multipart/form-data parsing. Returns fields
 * + a single named file as a Buffer. Used by /admin/courses/:slug/materials
 * and /admin/courses/:slug/lessons/upload.
 */

import { IncomingMessage } from "node:http";
import Busboy from "busboy";

export interface ParsedMultipart {
  fields: Record<string, string>;
  files: Record<string, { filename: string; mimeType: string; buffer: Buffer }>;
}

export async function parseMultipart(
  req: IncomingMessage,
  opts: { maxFileBytes?: number; maxTotalBytes?: number } = {},
): Promise<ParsedMultipart> {
  const maxFile = opts.maxFileBytes ?? 25 * 1024 * 1024;     // 25 MB per file
  const maxTotal = opts.maxTotalBytes ?? 30 * 1024 * 1024;   // 30 MB total

  return new Promise((resolve, reject) => {
    const contentType = req.headers["content-type"];
    if (!contentType || !contentType.includes("multipart/form-data")) {
      return reject(new Error("Expected multipart/form-data"));
    }
    const bb = Busboy({
      headers: req.headers,
      limits: { fileSize: maxFile, files: 5, fields: 30, fieldSize: 1024 * 1024 },
    });
    const result: ParsedMultipart = { fields: {}, files: {} };
    let totalBytes = 0;
    let aborted = false;

    bb.on("field", (name, value) => {
      if (aborted) return;
      result.fields[name] = value;
    });

    bb.on("file", (name, stream, info) => {
      if (aborted) return;
      const chunks: Buffer[] = [];
      let fileBytes = 0;
      stream.on("data", (d: Buffer) => {
        fileBytes += d.length;
        totalBytes += d.length;
        if (totalBytes > maxTotal || fileBytes > maxFile) {
          aborted = true;
          stream.resume();
          reject(new Error(`Upload exceeds ${(maxTotal / 1024 / 1024).toFixed(0)} MB cap`));
          return;
        }
        chunks.push(d);
      });
      stream.on("end", () => {
        if (aborted) return;
        result.files[name] = {
          filename: info.filename ?? "upload",
          mimeType: info.mimeType ?? "application/octet-stream",
          buffer: Buffer.concat(chunks),
        };
      });
    });

    bb.on("finish", () => {
      if (!aborted) resolve(result);
    });
    bb.on("error", (err: Error) => {
      aborted = true;
      reject(err);
    });
    req.pipe(bb);
  });
}
