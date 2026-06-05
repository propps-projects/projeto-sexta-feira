import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createUIResource } from "@mcp-ui/server";
import { z } from "zod";
import { loadLessons, findLesson, formatDuration, formatTimestamp } from "./lib/lessons.ts";
import { loadTranscript, excerptFor } from "./lib/transcripts.ts";
import { openDb, searchChunks } from "./lib/store.ts";
import { embedQuery } from "./lib/embeddings.ts";
import { type AdapterMode } from "./ui/player.ts";
import { buildPlayerWidgetHtml } from "./ui/widget-template.ts";
import { buildPlayerWidgetHtmlVideo } from "./ui/widget-template-video.ts";
import { type Tenant } from "./lib/tenant.ts";
import { resolveCourse, type Course } from "./lib/courses.ts";
import { listLessonsForCourse, findLessonInCourse, excerptFromTranscript } from "./lib/lessons-pg.ts";
import { searchChunksForCourse } from "./lib/store-pg.ts";

// ChatGPT Apps SDK widget URI for the lesson player. Registered as an MCP
// resource on /mcp-gpt; referenced from play_lesson's `openai/outputTemplate`.
const PLAYER_WIDGET_URI = "ui://widget/lesson-player.html";

/**
 * Builds an McpServer with all tools registered. Used by both the stdio entry
 * (src/server.ts) and the HTTP entry (src/server-http.ts) — same tools, two
 * transports. A new instance is created per HTTP session.
 *
 * `adapterMode` controls which MCP-UI adapter the `play_lesson` resource uses:
 *   - "mcpApps"  → MIME `text/html;profile=mcp-app` (Claude clients)
 *   - "appsSdk"  → MIME `text/html+skybridge`      (ChatGPT Apps SDK)
 *
 * `tenant` is the resolved tenant for path-based routing (/t/:slug/mcp).
 * Null = legacy single-tenant mode (local files, no enforcement).
 *
 * `auth` carries OAuth claims for tenant sessions: which student is logged
 * in and which courses they have active access to. The course resolution
 * helper enforces that resolved courses must be in accessibleCourseIds.
 * Legacy sessions pass null and skip the check.
 */
export interface AuthCtx {
  studentId: string | null;
  accessibleCourseIds: string[] | null;
}

export function buildServer(
  adapterMode: AdapterMode = "mcpApps",
  tenant: Tenant | null = null,
  auth: AuthCtx = { studentId: null, accessibleCourseIds: null },
): McpServer {
  const server = new McpServer(
    {
      name: tenant ? `askine-${tenant.slug}` : "agentclass",
      version: "0.1.0",
    },
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

  // On the Apps SDK endpoint we register the lesson-player widget as a top-level
  // MCP resource. ChatGPT resolves the URI from play_lesson's outputTemplate
  // _meta and renders this HTML in a sandboxed iframe. The HTML reads the
  // tool's structuredContent from window.openai.toolOutput.
  // CSP per https://developers.openai.com/apps-sdk/build/mcp-server (Apps SDK)
  // and the MCP Apps SEP spec: `_meta.ui.csp` goes inside the resource CONTENT
  // returned by the readCallback, NOT on the registration metadata. Sub-keys
  // are camelCase. The same shape works for both ChatGPT and Claude clients.
  const widgetCsp = {
    connectDomains: [
      "https://*.tv.pandavideo.com.br",
      "https://*.pandavideo.com.br",
      "https://cdn.pandavideo.com",
    ],
    resourceDomains: [
      "https://*.tv.pandavideo.com.br",
      "https://cdn.pandavideo.com",
    ],
    frameDomains: [
      "https://*.tv.pandavideo.com.br",
      "https://*.pandavideo.com.br",
      "https://player-vz-e2643eed-ceb.tv.pandavideo.com.br",
    ],
  } as const;
  const widgetDomain = process.env.WIDGET_DOMAIN;

  // Build the widget HTML wrapped with the per-host adapter so the host can
  // perform its initialization handshake and inject tool-result data into
  // the iframe.
  //   appsSdk  → MIME text/html+skybridge        (ChatGPT) — iframe to Panda
  //   mcpApps  → MIME text/html;profile=mcp-app  (Claude)  — <video> + hls.js
  //
  // ChatGPT honors `frameDomains` so the iframe to Panda works there.
  // Claude hardcodes `frame-src 'self' blob: data:` (see anthropics/
  // claude-ai-mcp #54 — closed "not planned"), so we can't iframe out;
  // <video> + hls.js (MediaSource Extensions) works because Claude's
  // media-src allows blob: and our connect_domains whitelists Panda.
  //
  // GPT_USE_VIDEO=true experimental flag: try the <video> path on the
  // ChatGPT endpoint too. Used to validate whether ChatGPT's media-src
  // CSP — which is NOT configurable via _meta.ui.csp — has become more
  // permissive since the last test. If it works, we eliminate the iframe
  // path entirely and remove the OpenAI submission risk (iframes get
  // "extra manual review and are often not approved").
  const gptUseVideo = process.env.GPT_USE_VIDEO === "true";
  const widgetHtml = adapterMode === "appsSdk"
    ? (gptUseVideo ? buildPlayerWidgetHtmlVideo() : buildPlayerWidgetHtml())
    : buildPlayerWidgetHtmlVideo();
  const widgetWrapped = createUIResource({
    uri: PLAYER_WIDGET_URI,
    content: { type: "rawHtml", htmlString: widgetHtml },
    encoding: "text",
    adapters: adapterMode === "appsSdk"
      ? { appsSdk: { enabled: true } }
      : { mcpApps: { enabled: true } },
    // Hint to the host how much space the widget needs. Without this Claude
    // collapses the iframe to a thin strip; with it the player gets enough
    // vertical room for the 16:9 video.
    uiMetadata: { "preferred-frame-size": ["100%", "480px"] },
  });
  const widgetMime = widgetWrapped.resource.mimeType;
  const widgetText = (widgetWrapped.resource as { text: string }).text;

  server.registerResource(
    "lesson-player",
    PLAYER_WIDGET_URI,
    {
      title: "Player de Aula",
      mimeType: widgetMime,
      _meta: {
        "openai/widgetDescription": "Player de vídeo da aula do curso, com deep-link opcional para timestamp.",
        ...(widgetDomain ? { "openai/widgetDomain": widgetDomain } : {}),
      },
    },
    async (uri) => ({
      contents: [{
        uri: uri.toString(),
        mimeType: widgetMime,
        text: widgetText,
        _meta: {
          // Standard MCP Apps CSP (also read by ChatGPT Apps SDK).
          ui: { csp: widgetCsp },
          // Legacy snake_case kept as compatibility belt for older clients.
          "openai/widgetCSP": {
            connect_domains: widgetCsp.connectDomains,
            resource_domains: widgetCsp.resourceDomains,
            frame_domains: widgetCsp.frameDomains,
            redirect_domains: [],
          },
        },
      }],
    }),
  );

  // ---------------------------------------------------------------------------
  // Course resolution helper — picks the active course for tenant sessions.
  //
  // Single-tenant (legacy /mcp) keeps reading the local VMA Produtificação
  // course from data/lessons.json. Multi-tenant (/t/:slug/mcp) queries the
  // tenant's ready courses, filters to ones the student has access to, and
  // resolves implicitly when there's exactly one.
  // ---------------------------------------------------------------------------
  type CourseCtx =
    | { mode: "legacy" }
    | { mode: "tenant"; course: Course }
    | { mode: "error"; message: string };

  async function resolveCourseCtx(courseSlug?: string): Promise<CourseCtx> {
    if (!tenant) return { mode: "legacy" };

    // Tenant mode requires an authenticated student with access claims.
    // Without claims (e.g. session not yet through OAuth), bail.
    if (!auth.studentId || auth.accessibleCourseIds === null) {
      return { mode: "error", message: "Sessão sem autenticação válida. Faça login novamente." };
    }
    const accessible = new Set(auth.accessibleCourseIds);

    const r = await resolveCourse(tenant.id, courseSlug);
    if (r.ok) {
      if (!accessible.has(r.course.id)) {
        return {
          mode: "error",
          message: `Você não tem acesso ao curso "${r.course.slug}". Caso tenha comprado recentemente, aguarde alguns minutos para o acesso ser liberado.`,
        };
      }
      return { mode: "tenant", course: r.course };
    }
    if (r.reason === "ambiguous") {
      // Filter to courses the student can access — disambiguate from the
      // student's perspective, not the tenant's full catalog.
      const owned = r.available.filter((c) => accessible.has(c.id));
      if (owned.length === 1) return { mode: "tenant", course: owned[0] };
      if (owned.length === 0) {
        return { mode: "error", message: "Você não tem acesso a nenhum curso deste tenant ainda." };
      }
      const list = owned.map((c) => `  - ${c.slug}: ${c.name}`).join("\n");
      return {
        mode: "error",
        message: `Há mais de um curso disponível. Forneça \`courseSlug\` em algum dos seguintes:\n${list}`,
      };
    }
    if (r.available.length === 0) {
      return {
        mode: "error",
        message: `Nenhum curso ativo encontrado para este tenant. Aguarde o ingest concluir.`,
      };
    }
    return {
      mode: "error",
      message: `Curso "${courseSlug}" não encontrado.`,
    };
  }

  // courseSlug is added to every tool's inputSchema so multi-course tenants
  // can disambiguate. Single-course tenants and the legacy MVP ignore it.
  const courseSlugField = z
    .string()
    .optional()
    .describe("Slug do curso (omita se o tenant tem apenas 1 curso ativo)");

  server.registerTool(
    "list_lessons",
    {
      title: "Listar aulas do curso",
      description: "Lista todas as aulas do curso com número, título e duração. Use isto para dar uma visão geral ou quando o aluno perguntar 'o que tem no curso'.",
      inputSchema: { courseSlug: courseSlugField },
      outputSchema: {
        courseName: z.string(),
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
    async ({ courseSlug }) => {
      const ctx = await resolveCourseCtx(courseSlug);
      if (ctx.mode === "error") {
        return { isError: true, content: [{ type: "text", text: ctx.message }] };
      }

      let lessons: Array<{ lessonNumber: number | null; title: string; durationSec: number; id: string }>;
      let courseName: string;
      if (ctx.mode === "legacy") {
        const ls = loadLessons();
        lessons = ls.map((l) => ({
          lessonNumber: l.lessonNumber,
          title: l.title,
          durationSec: l.durationSec,
          id: l.id,
        }));
        courseName = "Produtificação";
      } else {
        const ls = await listLessonsForCourse(ctx.course.id);
        lessons = ls.map((l) => ({
          lessonNumber: l.lessonNumber,
          title: l.title,
          durationSec: l.durationSec,
          id: l.id,
        }));
        courseName = ctx.course.name;
      }

      const total = lessons.reduce((n, l) => n + l.durationSec, 0);
      const lines = lessons.map(
        (l) => `${String(l.lessonNumber ?? "?").padStart(2, "0")}. **${l.title}** — ${formatDuration(l.durationSec)} \`(id: ${l.id})\``,
      );
      const text =
        `# ${courseName} (${lessons.length} aulas, ${formatDuration(total)} total)\n\n` +
        lines.join("\n");
      return {
        content: [{ type: "text", text }],
        structuredContent: { courseName, lessons, totalDurationSec: total },
      };
    },
  );

  server.registerTool(
    "get_lesson",
    {
      title: "Detalhes de uma aula",
      description: "Retorna metadados e (opcionalmente) a transcrição completa de uma aula. Forneça lessonNumber OU lessonId.",
      inputSchema: {
        courseSlug: courseSlugField,
        lessonNumber: z.number().int().min(1).max(99).optional().describe("Número da aula"),
        lessonId: z.string().optional().describe("UUID da aula"),
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
    async ({ courseSlug, lessonNumber, lessonId, includeFullTranscript }) => {
      const ctx = await resolveCourseCtx(courseSlug);
      if (ctx.mode === "error") {
        return { isError: true, content: [{ type: "text", text: ctx.message }] };
      }

      // Unified lesson + transcript fetch
      let lesson:
        | { lessonNumber: number | null; title: string; id: string; durationSec: number; segments: { start: number; end: number; text: string }[] | null }
        | null;
      if (ctx.mode === "legacy") {
        const l = findLesson({ lessonId, lessonNumber });
        if (!l) lesson = null;
        else {
          const t = loadTranscript(l.id, l.lessonNumber);
          lesson = {
            lessonNumber: l.lessonNumber,
            title: l.title,
            id: l.id,
            durationSec: l.durationSec,
            segments: t ? t.segments : null,
          };
        }
      } else {
        const l = await findLessonInCourse(ctx.course.id, { lessonId, lessonNumber });
        if (!l) lesson = null;
        else {
          lesson = {
            lessonNumber: l.lessonNumber,
            title: l.title,
            id: l.id,
            durationSec: l.durationSec,
            segments: l.transcript ? l.transcript.segments : null,
          };
        }
      }
      if (!lesson) return { isError: true, content: [{ type: "text", text: `Aula não encontrada.` }] };

      let body = `# Aula ${lesson.lessonNumber}: ${lesson.title}\n\n- Duração: ${formatDuration(lesson.durationSec)}\n- ID: \`${lesson.id}\`\n`;
      if (lesson.segments) {
        body += `- Segmentos transcritos: ${lesson.segments.length}\n\n`;
        if (includeFullTranscript) {
          body += `## Transcrição\n\n` + lesson.segments.map((s) => `[${formatTimestamp(s.start)}] ${s.text}`).join("\n");
        } else {
          body += `\n_(Use \`includeFullTranscript: true\` para ver a transcrição inteira, ou \`search_course\` para buscar trechos específicos.)_`;
        }
      } else {
        body += `\n_(Transcrição ainda não gerada.)_`;
      }
      const structuredContent = {
        lessonNumber: lesson.lessonNumber,
        title: lesson.title,
        id: lesson.id,
        durationSec: lesson.durationSec,
        transcriptAvailable: !!lesson.segments,
        ...(lesson.segments && includeFullTranscript ? { segments: lesson.segments } : {}),
      };
      return { content: [{ type: "text", text: body }], structuredContent };
    },
  );

  server.registerTool(
    "search_course",
    {
      title: "Buscar no conteúdo do curso",
      description: "Busca semântica nas transcrições e materiais do curso. Use isto sempre que o aluno perguntar sobre um conceito — retorna trechos relevantes com aula e timestamp para fundamentar a resposta.",
      inputSchema: {
        courseSlug: courseSlugField,
        query: z.string().min(2).describe("Pergunta ou termo em linguagem natural"),
        limit: z.number().int().min(1).max(15).optional().default(5),
        lessonNumber: z.number().int().min(1).max(99).optional().describe("Restringe a busca a uma aula específica"),
      },
      outputSchema: {
        query: z.string(),
        hits: z.array(z.object({
          lessonNumber: z.number().nullable(),
          lessonTitle: z.string(),
          startSec: z.number().nullable(),
          endSec: z.number().nullable(),
          text: z.string(),
          distance: z.number(),
        })),
      },
      annotations: readOnlyAnnotations,
    },
    async ({ courseSlug, query, limit, lessonNumber }) => {
      const ctx = await resolveCourseCtx(courseSlug);
      if (ctx.mode === "error") {
        return { isError: true, content: [{ type: "text", text: ctx.message }] };
      }
      const qv = await embedQuery(query);

      // Normalize hits into a unified shape regardless of source.
      type Hit = {
        lessonNumber: number | null;
        lessonTitle: string;
        startSec: number | null;
        endSec: number | null;
        text: string;
        distance: number;
      };

      let hits: Hit[];
      if (ctx.mode === "legacy") {
        const db = openDb();
        const raw = searchChunks(db, qv, lessonNumber ? Math.max(limit * 4, 20) : limit);
        const filtered = lessonNumber ? raw.filter((h) => h.lessonNumber === lessonNumber) : raw;
        hits = filtered.slice(0, limit).map((h) => ({
          lessonNumber: h.lessonNumber,
          lessonTitle: h.title,
          startSec: h.startSec,
          endSec: h.endSec,
          text: h.text,
          distance: h.distance,
        }));
      } else {
        const raw = await searchChunksForCourse(ctx.course.id, qv, { limit, lessonNumber });
        hits = raw.map((h) => ({
          lessonNumber: h.lessonNumber,
          lessonTitle: h.lessonTitle ?? h.materialName ?? "(sem título)",
          startSec: h.startSec,
          endSec: h.endSec,
          text: h.text,
          distance: h.distance,
        }));
      }

      if (!hits.length) {
        return { content: [{ type: "text", text: `Sem resultados para "${query}".` }], structuredContent: { query, hits: [] } };
      }
      const blocks = hits.map((h, i) => {
        const range = (h.startSec != null && h.endSec != null)
          ? ` · ${formatTimestamp(h.startSec)}–${formatTimestamp(h.endSec)}`
          : "";
        const playHint = (h.lessonNumber != null && h.startSec != null)
          ? `\n\n_Para mostrar este trecho:_ \`play_lesson(lessonNumber: ${h.lessonNumber}, startSec: ${Math.floor(h.startSec)})\``
          : "";
        return `### ${i + 1}. Aula ${h.lessonNumber ?? "?"} — ${h.lessonTitle}${range}\n\n> ${h.text}${playHint}`;
      });
      const text = `# ${hits.length} trecho(s) encontrado(s) para: "${query}"\n\n` + blocks.join("\n\n");
      return { content: [{ type: "text", text }], structuredContent: { query, hits } };
    },
  );

  server.registerTool(
    "play_lesson",
    {
      title: "Renderizar player da aula no chat",
      description: "Renderiza o player de vídeo Panda inline no chat, opcionalmente começando em um timestamp. Use quando o aluno pedir 'me mostra essa parte' ou quando uma resposta se beneficie de ver o vídeo.",
      inputSchema: {
        courseSlug: courseSlugField,
        lessonNumber: z.number().int().min(1).max(99).optional().describe("Número da aula"),
        lessonId: z.string().optional().describe("UUID da aula"),
        startSec: z.number().min(0).optional().describe("Segundo no qual começar a reprodução (deep-link)"),
      },
      outputSchema: {
        lessonNumber: z.number().nullable(),
        title: z.string(),
        id: z.string(),
        embedUrl: z.string(),
        hlsUrl: z.string(),
        startSec: z.number().optional(),
      },
      annotations: readOnlyAnnotations,
      // Both ChatGPT Apps SDK and Claude MCP Apps look at a tool-level _meta
      // pointer to render the registered widget resource as an iframe instead
      // of the legacy embedded mcp-ui card.
      //
      //   • Claude / MCP Apps SEP → `_meta.ui.resourceUri`
      //   • ChatGPT Apps SDK      → `_meta["openai/outputTemplate"]`
      //
      // We declare both. The host honors whichever it understands.
      _meta: {
        ui: { resourceUri: PLAYER_WIDGET_URI },
        ...(adapterMode === "appsSdk"
          ? {
              "openai/outputTemplate": PLAYER_WIDGET_URI,
              "openai/toolInvocation/invoking": "Carregando aula...",
              "openai/toolInvocation/invoked": "Aula carregada",
              "openai/widgetAccessible": true,
            }
          : {}),
      },
    },
    async ({ courseSlug, lessonNumber, lessonId, startSec }) => {
      const ctx = await resolveCourseCtx(courseSlug);
      if (ctx.mode === "error") {
        return { isError: true, content: [{ type: "text", text: ctx.message }] };
      }

      let lesson:
        | { lessonNumber: number | null; title: string; id: string; embedUrl: string; hlsUrl: string }
        | null;
      if (ctx.mode === "legacy") {
        const l = findLesson({ lessonId, lessonNumber });
        lesson = l ? {
          lessonNumber: l.lessonNumber,
          title: l.title,
          id: l.id,
          embedUrl: l.embedUrl,
          hlsUrl: l.hlsUrl,
        } : null;
      } else {
        const l = await findLessonInCourse(ctx.course.id, { lessonId, lessonNumber });
        lesson = l && l.embedUrl && l.hlsUrl ? {
          lessonNumber: l.lessonNumber,
          title: l.title,
          id: l.id,
          embedUrl: l.embedUrl,
          hlsUrl: l.hlsUrl,
        } : null;
      }
      if (!lesson) return { isError: true, content: [{ type: "text", text: `Aula não encontrada.` }] };

      const directUrl = new URL(lesson.embedUrl);
      if (startSec && startSec > 0) {
        directUrl.searchParams.set("startTime", String(Math.floor(startSec)));
        directUrl.searchParams.set("t", String(Math.floor(startSec)));
      }
      const structuredContent = {
        lessonNumber: lesson.lessonNumber,
        title: lesson.title,
        id: lesson.id,
        embedUrl: directUrl.toString(),
        hlsUrl: lesson.hlsUrl,
        ...(startSec ? { startSec: Math.floor(startSec) } : {}),
      };
      const label = startSec
        ? `**Aula ${lesson.lessonNumber} — ${lesson.title}** (a partir de ${formatTimestamp(startSec)})`
        : `**Aula ${lesson.lessonNumber} — ${lesson.title}**`;

      // No embedded resource — both hosts render the widget via the URI
      // declared on the tool _meta. Tool result carries only text + data.
      return {
        content: [{ type: "text", text: label }],
        structuredContent,
        _meta: {
          ui: { resourceUri: PLAYER_WIDGET_URI },
          ...(adapterMode === "appsSdk"
            ? { "openai/outputTemplate": PLAYER_WIDGET_URI }
            : {}),
        },
      };
    },
  );

  server.registerTool(
    "excerpt_transcript",
    {
      title: "Trecho exato da transcrição",
      description: "Retorna a transcrição literal entre dois timestamps de uma aula. Útil para citar o instrutor com precisão.",
      inputSchema: {
        courseSlug: courseSlugField,
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
    async ({ courseSlug, lessonNumber, lessonId, startSec, endSec }) => {
      const ctx = await resolveCourseCtx(courseSlug);
      if (ctx.mode === "error") {
        return { isError: true, content: [{ type: "text", text: ctx.message }] };
      }

      let lesson: { lessonNumber: number | null; title: string; id: string } | null;
      let segs: { start: number; end: number; text: string }[];
      if (ctx.mode === "legacy") {
        const l = findLesson({ lessonId, lessonNumber });
        if (!l) return { isError: true, content: [{ type: "text", text: `Aula não encontrada.` }] };
        const t = loadTranscript(l.id, l.lessonNumber);
        if (!t) return { isError: true, content: [{ type: "text", text: `Transcrição da aula ${l.lessonNumber} não gerada ainda.` }] };
        lesson = { lessonNumber: l.lessonNumber, title: l.title, id: l.id };
        segs = excerptFor(t, startSec, endSec);
      } else {
        const l = await findLessonInCourse(ctx.course.id, { lessonId, lessonNumber });
        if (!l) return { isError: true, content: [{ type: "text", text: `Aula não encontrada.` }] };
        if (!l.transcript) return { isError: true, content: [{ type: "text", text: `Transcrição da aula ${l.lessonNumber} não gerada ainda.` }] };
        lesson = { lessonNumber: l.lessonNumber, title: l.title, id: l.id };
        segs = excerptFromTranscript(l, startSec, endSec);
      }

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

  // Tenant-only: list courses available to the student. Single-tenant legacy
  // mode never has this tool registered — there's only one course (VMA).
  if (tenant) {
    server.registerTool(
      "list_courses",
      {
        title: "Listar cursos do tenant",
        description: "Lista todos os cursos ativos do tenant. Use isto quando o aluno quiser saber quais cursos pode acessar, ou pra escolher um curso quando há mais de um.",
        inputSchema: {},
        outputSchema: {
          courses: z.array(z.object({
            slug: z.string(),
            name: z.string(),
            ingestStatus: z.string(),
          })),
        },
        annotations: readOnlyAnnotations,
      },
      async () => {
        const { listCoursesForTenant } = await import("./lib/courses.ts");
        const all = await listCoursesForTenant(tenant.id);
        // Show only courses the student actually has access to.
        const accessible = new Set(auth.accessibleCourseIds ?? []);
        const courses = all.filter((c) => accessible.has(c.id));
        if (!courses.length) {
          return {
            content: [{ type: "text", text: "Você ainda não tem acesso a nenhum curso deste tenant." }],
            structuredContent: { courses: [] },
          };
        }
        const text = `# Seus cursos (${courses.length})\n\n` +
          courses.map((c, i) => `${i + 1}. **${c.name}** \`(slug: ${c.slug})\``).join("\n");
        return {
          content: [{ type: "text", text }],
          structuredContent: {
            courses: courses.map((c) => ({ slug: c.slug, name: c.name, ingestStatus: c.ingestStatus })),
          },
        };
      },
    );
  }

  return server;
}
