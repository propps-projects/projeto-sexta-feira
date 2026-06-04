import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { loadLessons, findLesson, formatDuration, formatTimestamp } from "./lib/lessons.ts";
import { loadTranscript, excerptFor } from "./lib/transcripts.ts";
import { openDb, searchChunks } from "./lib/store.ts";
import { embedQuery } from "./lib/embeddings.ts";
import { playerResource, type AdapterMode } from "./ui/player.ts";

/**
 * Builds an McpServer with all tools registered. Used by both the stdio entry
 * (src/server.ts) and the HTTP entry (src/server-http.ts) — same tools, two
 * transports. A new instance is created per HTTP session.
 *
 * `adapterMode` controls which MCP-UI adapter the `play_lesson` resource uses:
 *   - "mcpApps"  → MIME `text/html;profile=mcp-app` (Claude clients)
 *   - "appsSdk"  → MIME `text/html+skybridge`      (ChatGPT Apps SDK)
 *
 * One server instance per session means the choice can vary by endpoint.
 */
export function buildServer(adapterMode: AdapterMode = "mcpApps"): McpServer {
  const server = new McpServer(
    { name: "agentclass", version: "0.1.0" },
    {
      capabilities: { tools: {}, resources: {} },
      instructions: [
        "Você é o tutor do micro-curso de Produtificação (13 aulas) do projeto VMA.",
        "Sempre que o aluno fizer perguntas sobre o conteúdo, use search_course para fundamentar a resposta",
        "nos trechos reais das aulas — cite o número da aula e o timestamp.",
        "Quando fizer sentido mostrar o vídeo, chame play_lesson com startSec apontando para o trecho",
        "que melhor responde a pergunta.",
        "Responda em português brasileiro, didático mas direto.",
      ].join(" "),
    },
  );

  // All tools are read-only against curated local data — declare it so hosts (ChatGPT in
  // particular) stop labeling them "destructive" / "open-world".
  const readOnlyAnnotations = {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  } as const;

  server.registerTool(
    "list_lessons",
    {
      title: "Listar aulas do curso",
      description: "Lista as 13 aulas do curso com número, título e duração. Use isto para dar uma visão geral ou quando o aluno perguntar 'o que tem no curso'.",
      inputSchema: {},
      outputSchema: {
        lessons: z.array(z.object({
          lessonNumber: z.number().nullable(),
          title: z.string(),
          durationSec: z.number(),
          id: z.string(),
        })),
        totalDurationSec: z.number(),
      },
      annotations: readOnlyAnnotations,
    },
    async () => {
      const lessons = loadLessons();
      const total = lessons.reduce((n, l) => n + l.durationSec, 0);
      const lines = lessons.map(
        (l) => `${String(l.lessonNumber ?? "?").padStart(2, "0")}. **${l.title}** — ${formatDuration(l.durationSec)} \`(id: ${l.id})\``,
      );
      const text =
        `# Micro-curso: Produtificação (${lessons.length} aulas, ${formatDuration(total)} total)\n\n` +
        lines.join("\n");
      const structuredContent = {
        lessons: lessons.map((l) => ({
          lessonNumber: l.lessonNumber,
          title: l.title,
          durationSec: l.durationSec,
          id: l.id,
        })),
        totalDurationSec: total,
      };
      return { content: [{ type: "text", text }], structuredContent };
    },
  );

  server.registerTool(
    "get_lesson",
    {
      title: "Detalhes de uma aula",
      description: "Retorna metadados e a transcrição completa de uma aula específica. Forneça lessonNumber (1-13) OU lessonId.",
      inputSchema: {
        lessonNumber: z.number().int().min(1).max(99).optional().describe("Número da aula (1-13)"),
        lessonId: z.string().optional().describe("UUID da aula no Panda"),
        includeFullTranscript: z.boolean().optional().default(false).describe("Se true, inclui a transcrição completa. Default: false."),
      },
      outputSchema: {
        lessonNumber: z.number().nullable(),
        title: z.string(),
        id: z.string(),
        durationSec: z.number(),
        transcriptAvailable: z.boolean(),
        segments: z.array(z.object({ start: z.number(), end: z.number(), text: z.string() })).optional(),
      },
      annotations: readOnlyAnnotations,
    },
    async ({ lessonNumber, lessonId, includeFullTranscript }) => {
      const lesson = findLesson({ lessonId, lessonNumber });
      if (!lesson) return { isError: true, content: [{ type: "text", text: `Aula não encontrada.` }] };
      const t = loadTranscript(lesson.id, lesson.lessonNumber);
      let body = `# Aula ${lesson.lessonNumber}: ${lesson.title}\n\n- Duração: ${formatDuration(lesson.durationSec)}\n- ID: \`${lesson.id}\`\n`;
      if (t) {
        body += `- Segmentos transcritos: ${t.segments.length}\n\n`;
        if (includeFullTranscript) {
          body += `## Transcrição\n\n` + t.segments.map((s) => `[${formatTimestamp(s.start)}] ${s.text}`).join("\n");
        } else {
          body += `\n_(Use \`includeFullTranscript: true\` para ver a transcrição inteira, ou \`search_course\` para buscar trechos específicos.)_`;
        }
      } else {
        body += `\n_(Transcrição ainda não gerada — rode \`npm run ingest:3-transcribe\`.)_`;
      }
      const structuredContent = {
        lessonNumber: lesson.lessonNumber,
        title: lesson.title,
        id: lesson.id,
        durationSec: lesson.durationSec,
        transcriptAvailable: !!t,
        ...(t && includeFullTranscript ? { segments: t.segments } : {}),
      };
      return { content: [{ type: "text", text: body }], structuredContent };
    },
  );

  server.registerTool(
    "search_course",
    {
      title: "Buscar no conteúdo do curso",
      description: "Busca semântica nas transcrições das 13 aulas. Use isto sempre que o aluno perguntar sobre um conceito — retorna trechos relevantes com aula e timestamp para fundamentar a resposta.",
      inputSchema: {
        query: z.string().min(2).describe("Pergunta ou termo em linguagem natural"),
        limit: z.number().int().min(1).max(15).optional().default(5),
        lessonNumber: z.number().int().min(1).max(99).optional().describe("Restringe a busca a uma aula específica"),
      },
      outputSchema: {
        query: z.string(),
        hits: z.array(z.object({
          lessonNumber: z.number().nullable(),
          lessonTitle: z.string(),
          startSec: z.number(),
          endSec: z.number(),
          text: z.string(),
          distance: z.number(),
        })),
      },
      annotations: readOnlyAnnotations,
    },
    async ({ query, limit, lessonNumber }) => {
      const db = openDb();
      const qv = await embedQuery(query);
      const hits = searchChunks(db, qv, lessonNumber ? Math.max(limit * 4, 20) : limit);
      const filtered = (lessonNumber ? hits.filter((h) => h.lessonNumber === lessonNumber) : hits).slice(0, limit);
      if (!filtered.length) {
        return { content: [{ type: "text", text: `Sem resultados para "${query}".` }], structuredContent: { query, hits: [] } };
      }
      const blocks = filtered.map((h, i) => {
        return `### ${i + 1}. Aula ${h.lessonNumber} — ${h.title} · ${formatTimestamp(h.startSec)}–${formatTimestamp(h.endSec)}\n\n> ${h.text}\n\n_Para mostrar este trecho:_ \`play_lesson(lessonNumber: ${h.lessonNumber}, startSec: ${Math.floor(h.startSec)})\``;
      });
      const text = `# ${filtered.length} trecho(s) encontrado(s) para: "${query}"\n\n` + blocks.join("\n\n");
      const structuredContent = {
        query,
        hits: filtered.map((h) => ({
          lessonNumber: h.lessonNumber,
          lessonTitle: h.title,
          startSec: h.startSec,
          endSec: h.endSec,
          text: h.text,
          distance: h.distance,
        })),
      };
      return { content: [{ type: "text", text }], structuredContent };
    },
  );

  server.registerTool(
    "play_lesson",
    {
      title: "Renderizar player da aula no chat",
      description: "Renderiza o player de vídeo Panda inline no chat, opcionalmente começando em um timestamp. Use quando o aluno pedir 'me mostra essa parte' ou quando uma resposta se beneficie de ver o vídeo.",
      inputSchema: {
        lessonNumber: z.number().int().min(1).max(99).optional().describe("Número da aula (1-13)"),
        lessonId: z.string().optional().describe("UUID da aula no Panda"),
        startSec: z.number().min(0).optional().describe("Segundo no qual começar a reprodução (deep-link)"),
      },
      outputSchema: {
        lessonNumber: z.number().nullable(),
        title: z.string(),
        id: z.string(),
        embedUrl: z.string(),
        startSec: z.number().optional(),
      },
      annotations: readOnlyAnnotations,
    },
    async ({ lessonNumber, lessonId, startSec }) => {
      const lesson = findLesson({ lessonId, lessonNumber });
      if (!lesson) return { isError: true, content: [{ type: "text", text: `Aula não encontrada.` }] };
      const resource = playerResource(lesson, startSec, adapterMode);
      const directUrl = new URL(lesson.embedUrl);
      if (startSec && startSec > 0) {
        directUrl.searchParams.set("startTime", String(Math.floor(startSec)));
        directUrl.searchParams.set("t", String(Math.floor(startSec)));
      }
      const label = startSec
        ? `**Aula ${lesson.lessonNumber} — ${lesson.title}** (a partir de ${formatTimestamp(startSec)})\n\nSe o player não aparecer aqui, [clica aqui pra abrir no navegador](${directUrl.toString()}).`
        : `**Aula ${lesson.lessonNumber} — ${lesson.title}**\n\nSe o player não aparecer aqui, [clica aqui pra abrir no navegador](${directUrl.toString()}).`;
      const structuredContent = {
        lessonNumber: lesson.lessonNumber,
        title: lesson.title,
        id: lesson.id,
        embedUrl: directUrl.toString(),
        ...(startSec ? { startSec } : {}),
      };
      return { content: [{ type: "text", text: label }, resource], structuredContent };
    },
  );

  server.registerTool(
    "excerpt_transcript",
    {
      title: "Trecho exato da transcrição",
      description: "Retorna a transcrição literal entre dois timestamps de uma aula. Útil para citar o instrutor com precisão.",
      inputSchema: {
        lessonNumber: z.number().int().min(1).max(99).optional(),
        lessonId: z.string().optional(),
        startSec: z.number().min(0),
        endSec: z.number().min(0),
      },
      outputSchema: {
        lessonNumber: z.number().nullable(),
        title: z.string(),
        startSec: z.number(),
        endSec: z.number(),
        segments: z.array(z.object({ start: z.number(), end: z.number(), text: z.string() })),
      },
      annotations: readOnlyAnnotations,
    },
    async ({ lessonNumber, lessonId, startSec, endSec }) => {
      const lesson = findLesson({ lessonId, lessonNumber });
      if (!lesson) return { isError: true, content: [{ type: "text", text: `Aula não encontrada.` }] };
      const t = loadTranscript(lesson.id, lesson.lessonNumber);
      if (!t) return { isError: true, content: [{ type: "text", text: `Transcrição da aula ${lesson.lessonNumber} não gerada ainda.` }] };
      const segs = excerptFor(t, startSec, endSec);
      const structuredContent = {
        lessonNumber: lesson.lessonNumber,
        title: lesson.title,
        startSec,
        endSec,
        segments: segs,
      };
      if (!segs.length) return { content: [{ type: "text", text: `Sem conteúdo entre ${formatTimestamp(startSec)} e ${formatTimestamp(endSec)} na aula ${lesson.lessonNumber}.` }], structuredContent };
      const body =
        `# Aula ${lesson.lessonNumber} — ${lesson.title}\n## ${formatTimestamp(startSec)} → ${formatTimestamp(endSec)}\n\n` +
        segs.map((s) => `[${formatTimestamp(s.start)}] ${s.text}`).join("\n");
      return { content: [{ type: "text", text: body }], structuredContent };
    },
  );

  return server;
}
