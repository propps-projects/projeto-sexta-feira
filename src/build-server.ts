import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createUIResource } from "@mcp-ui/server";
import { z } from "zod";
import { loadLessons, findLesson, formatDuration, formatTimestamp } from "./lib/lessons.ts";
import { loadTranscript, excerptFor } from "./lib/transcripts.ts";
import { openDb, searchChunks } from "./lib/store.ts";
import { embedQuery } from "./lib/embeddings.ts";
import { type AdapterMode } from "./ui/player.ts";
import { buildPlayerWidgetHtml, injectPlayerDataApps } from "./ui/widget-template.ts";
import { buildPlayerWidgetHtmlVideo, injectPlayerData } from "./ui/widget-template-video.ts";
import {
  buildPlayerWidgetUri,
  parsePlayerDataFromUri,
  PLAYER_WIDGET_URI_TEMPLATE,
  PLAYER_WIDGET_URI_LEGACY,
} from "./lib/widget-uri.ts";
import { type Tenant } from "./lib/tenant.ts";
import { resolveCourse, type Course } from "./lib/courses.ts";
import { listLessonsForCourse, findLessonInCourse, excerptFromTranscript } from "./lib/lessons-pg.ts";
import { searchChunksForCourse } from "./lib/store-pg.ts";
import { recordToolCall, recordSearchQuery } from "./lib/analytics.ts";
import { recordPlayLesson, getProgressForCourse } from "./lib/student-progress.ts";
import { checkAndCount } from "./lib/rate-limit.ts";
import type { McpUser, AccessibleCourse } from "./lib/mcp-users.ts";

// Phase 10 — stateless widget URIs.
//
// Each play_lesson call returns a UNIQUE per-call URI of the form
//   ui://widget/lesson-player-v3/<base64url-of-json-data>.html
// resolved by a ResourceTemplate. The resource read callback decodes the
// data segment and injects it inline as window._playerData so the widget
// hydrates without depending on the host re-dispatching postMessage.
// Survives MCP session resets after a deploy: old conversations re-fetch
// the same URI on the new server process and get the same HTML.
//
// The static v2 URI is still registered as a back-compat shim for conversations
// produced before Phase 10 — it returns the widget HTML without inline data,
// which falls back to the postMessage/openai.toolOutput hydration path that
// the old hosts used.
const PLAYER_WIDGET_URI_V2 = PLAYER_WIDGET_URI_LEGACY;

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
  /** Legacy tenant-scoped Bearer (per-tenant student record). */
  studentId: string | null;
  accessibleCourseIds: string[] | null;
  /** Global Bearer (Phase 5+): single email identity, cross-tenant. */
  mcpUser?: McpUser | null;
  accessibleCourses?: AccessibleCourse[] | null;
}

export function buildServer(
  adapterMode: AdapterMode = "mcpApps",
  tenant: Tenant | null = null,
  auth: AuthCtx = { studentId: null, accessibleCourseIds: null, mcpUser: null, accessibleCourses: null },
): McpServer {
  const isGlobal = !!auth.mcpUser;
  // Public base URL — used to advertise the connector icon (MCP `icons` field
  // in serverInfo) so clients like Claude.ai render the Askine logo instead of
  // a generic globe. Served raster PNG via /brand/favicon.png with CORS `*`.
  const baseUrl = (process.env.PUBLIC_URL ?? "http://localhost:3333").replace(/\/+$/, "");
  const server = new McpServer(
    {
      name: isGlobal ? "askine" : tenant ? `askine-${tenant.slug}` : "agentclass",
      version: "0.1.0",
      title: "Askine",
      websiteUrl: baseUrl,
      icons: [
        { src: `${baseUrl}/brand/favicon.png`, mimeType: "image/png", sizes: ["300x300"] },
      ],
    },
    {
      capabilities: { tools: {}, resources: {} },
      instructions: isGlobal
        ? [
            "Você é o tutor agêntico Askine. O usuário tem acesso a um ou mais cursos de diferentes infoprodutores.",
            "Primeiro use list_courses para ver quais cursos o aluno tem acesso. Depois identifique pela pergunta",
            "qual curso é relevante e use o courseId nas próximas chamadas. Quando ambíguo, pergunte ao aluno.",
            "Sempre use search_course pra fundamentar respostas em trechos reais das aulas — cite aula e timestamp.",
            "Quando fizer sentido mostrar o vídeo, chame play_lesson com startSec apontando para o trecho.",
            "Responda em português brasileiro, didático mas direto.",
          ].join(" ")
        : [
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
  // GPT_USE_VIDEO flag REMOVED (was a production footgun): ChatGPT's widget CSP
  // hardcodes `media-src 'self'`, which blocks the blob: URLs hls.js/MSE feed a
  // native <video> — so the <video> path NEVER plays in ChatGPT (confirmed; see
  // PLAN.md "manter iframe no ChatGPT"). The choice is now hardcoded per host:
  //   ChatGPT (appsSdk) → iframe→Panda   (its CSP allows frame-src to Panda)
  //   Claude  (mcpApps) → <video>+hls.js (its CSP allows blob: in media-src)
  const widgetHtml = adapterMode === "appsSdk"
    ? buildPlayerWidgetHtml()
    : buildPlayerWidgetHtmlVideo();
  // Wrap once for mime/headers; reuse for both v2 (legacy static) and v3
  // (template) registrations. The HTML text is the same shell — v3 also
  // gets an inline `window._playerData` injected at read time.
  const widgetWrapped = createUIResource({
    uri: PLAYER_WIDGET_URI_V2,
    content: { type: "rawHtml", htmlString: widgetHtml },
    encoding: "text",
    adapters: adapterMode === "appsSdk"
      ? { appsSdk: { enabled: true } }
      : { mcpApps: { enabled: true } },
    uiMetadata: { "preferred-frame-size": ["100%", "480px"] },
  });
  const widgetMime = widgetWrapped.resource.mimeType;
  const widgetText = (widgetWrapped.resource as { text: string }).text;
  const injectForAdapter = adapterMode === "appsSdk" ? injectPlayerDataApps : injectPlayerData;

  const widgetMeta = {
    title: "Player de Aula",
    mimeType: widgetMime,
    _meta: {
      "openai/widgetDescription": "Player de vídeo da aula do curso, com deep-link opcional para timestamp.",
      ...(widgetDomain ? { "openai/widgetDomain": widgetDomain } : {}),
    },
  } as const;

  const widgetContentMeta = {
    ui: { csp: widgetCsp },
    "openai/widgetCSP": {
      connect_domains: widgetCsp.connectDomains,
      resource_domains: widgetCsp.resourceDomains,
      frame_domains: widgetCsp.frameDomains,
      redirect_domains: [],
    },
  };

  // v2 (legacy static URI) — back-compat for conversations created BEFORE
  // Phase 10. Returns the widget HTML with no inline data; the host falls
  // back to its old postMessage/openai.toolOutput hydration path.
  server.registerResource(
    "lesson-player-v2",
    PLAYER_WIDGET_URI_V2,
    widgetMeta,
    async (uri) => ({
      contents: [{
        uri: uri.toString(),
        mimeType: widgetMime,
        text: widgetText,
        _meta: widgetContentMeta,
      }],
    }),
  );

  // v3 (stateless template) — new conversations. Each play_lesson call
  // returns a URI of the form `ui://widget/lesson-player-v3/<base64url>.html`
  // and this read callback decodes the base64 data, injects it as
  // `window._playerData`, and returns the hydrated HTML. The widget then
  // renders immediately on first paint — no postMessage required, no
  // dependence on the original MCP session still being alive on the server.
  server.registerResource(
    "lesson-player-v3",
    new ResourceTemplate(PLAYER_WIDGET_URI_TEMPLATE, { list: undefined }),
    widgetMeta,
    async (uri) => {
      const data = parsePlayerDataFromUri(uri.toString());
      const hydrated = injectForAdapter(widgetText, data);
      return {
        contents: [{
          uri: uri.toString(),
          mimeType: widgetMime,
          text: hydrated,
          _meta: widgetContentMeta,
        }],
      };
    },
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

  async function resolveCourseCtx(args: { courseId?: string; courseSlug?: string } = {}): Promise<CourseCtx> {
    // ----- Global mode (Phase 5+): cross-tenant courses by UUID or slug -----
    if (isGlobal) {
      const accessible = auth.accessibleCourses ?? [];
      if (!accessible.length) {
        return { mode: "error", message: "Você ainda não tem acesso a nenhum curso. Confirme que comprou o curso no Hotmart e aguarde alguns minutos." };
      }
      if (args.courseId) {
        const hit = accessible.find((c) => c.courseId === args.courseId);
        if (!hit) return { mode: "error", message: `Você não tem acesso ao courseId "${args.courseId}".` };
        return { mode: "tenant", course: {
          id: hit.courseId, tenantId: hit.tenantId, name: hit.courseName,
          slug: hit.courseSlug, sourceType: "panda", ingestStatus: "ready",
        } };
      }
      if (args.courseSlug) {
        const matches = accessible.filter((c) => c.courseSlug === args.courseSlug);
        if (matches.length === 1) {
          const hit = matches[0];
          return { mode: "tenant", course: {
            id: hit.courseId, tenantId: hit.tenantId, name: hit.courseName,
            slug: hit.courseSlug, sourceType: "panda", ingestStatus: "ready",
          } };
        }
        if (matches.length > 1) {
          const list = matches.map((c) => `  - ${c.displayName} (courseId: ${c.courseId})`).join("\n");
          return { mode: "error", message: `Mais de um curso com slug "${args.courseSlug}". Use o courseId:\n${list}` };
        }
      }
      if (accessible.length === 1) {
        const hit = accessible[0];
        return { mode: "tenant", course: {
          id: hit.courseId, tenantId: hit.tenantId, name: hit.courseName,
          slug: hit.courseSlug, sourceType: "panda", ingestStatus: "ready",
        } };
      }
      const list = accessible.map((c) => `  - ${c.displayName} (courseId: ${c.courseId})`).join("\n");
      return { mode: "error", message: `Mais de um curso disponível. Use list_courses pra ver os IDs e passe courseId:\n${list}` };
    }

    // ----- Legacy single-tenant mode -----
    if (!tenant) return { mode: "legacy" };

    // ----- Tenant-scoped mode (per-tenant Bearer) -----
    if (!auth.studentId || auth.accessibleCourseIds === null) {
      return { mode: "error", message: "Sessão sem autenticação válida. Faça login novamente." };
    }
    const accessible = new Set(auth.accessibleCourseIds);
    const r = await resolveCourse(tenant.id, args.courseSlug);
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
      const owned = r.available.filter((c) => accessible.has(c.id));
      if (owned.length === 1) return { mode: "tenant", course: owned[0] };
      if (owned.length === 0) return { mode: "error", message: "Você não tem acesso a nenhum curso deste tenant ainda." };
      const list = owned.map((c) => `  - ${c.slug}: ${c.name}`).join("\n");
      return { mode: "error", message: `Há mais de um curso disponível. Forneça \`courseSlug\` em algum dos seguintes:\n${list}` };
    }
    if (r.available.length === 0) {
      return { mode: "error", message: `Nenhum curso ativo encontrado para este tenant. Aguarde o ingest concluir.` };
    }
    return { mode: "error", message: `Curso "${args.courseSlug}" não encontrado.` };
  }

  // courseSlug is added to every tool's inputSchema so multi-course tenants
  // can disambiguate. Single-course tenants and the legacy MVP ignore it.
  const courseSlugField = z
    .string()
    .optional()
    .describe("Slug do curso (omita se o tenant tem apenas 1 curso ativo)");

  // courseId is the global UUID — preferred in /mcp (global) mode where
  // slugs collide across tenants. Get the UUID from list_courses output.
  const courseIdField = z
    .string()
    .optional()
    .describe("UUID do curso (preferido no modo global; obtido via list_courses)");

  // Telemetry helper — fires only for tenant sessions (skips legacy MVP).
  // All inserts are async fire-and-forget; never blocks the tool response.
  function logTool(args: {
    toolName: string;
    input: Record<string, unknown>;
    courseId: string | null;
    output?: Record<string, unknown> | null;
    latencyMs: number;
  }): void {
    if (!tenant) return;
    recordToolCall({
      tenantId: tenant.id,
      studentId: auth.studentId,
      courseId: args.courseId,
      toolName: args.toolName,
      input: args.input,
      outputSummary: args.output ?? null,
      latencyMs: args.latencyMs,
    });
  }

  /**
   * Returns null when the call is allowed; returns an MCP isError response
   * when the student is rate-limited. Tenant-only — legacy single-tenant
   * MCP sessions are not gated.
   */
  async function rateLimitOrError(toolName: string): Promise<
    { isError: true; content: Array<{ type: "text"; text: string }> } | null
  > {
    // Identify the caller across both modes:
    //   - tenant-scoped Bearer: (tenant, student) keys the bucket
    //   - global Bearer (Phase 5+): mcpUser keys the bucket
    //   - legacy / no-auth (impossible after Phase 9.1): skip
    let tenantId: string;
    let studentId: string;
    if (tenant && auth.studentId) {
      tenantId = tenant.id;
      studentId = auth.studentId;
    } else if (auth.mcpUser) {
      // Global mode: synthetic tenant + use the global user id. Phase
      // 9.2 closes the previously uncapped global path.
      tenantId = "_global";
      studentId = auth.mcpUser.id;
    } else {
      return null;
    }
    const r = await checkAndCount({ tenantId, studentId, toolName });
    if (r.ok) return null;
    const mins = Math.ceil(r.retryAfterSec / 60);
    return {
      isError: true,
      content: [{
        type: "text",
        text: `Muitas chamadas. Limite de ${r.limit} chamadas de \`${toolName}\` por hora atingido. Tente de novo em ~${mins}min.`,
      }],
    };
  }

  server.registerTool(
    "list_lessons",
    {
      title: "Listar aulas do curso",
      description: "Lista todas as aulas do curso com número, título e duração. Use isto para dar uma visão geral ou quando o aluno perguntar 'o que tem no curso'.",
      inputSchema: { courseId: courseIdField, courseSlug: courseSlugField },
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
    async ({ courseId, courseSlug }) => {
      const t0 = Date.now();
      const limited = await rateLimitOrError("list_lessons");
      if (limited) return limited;
      const ctx = await resolveCourseCtx({ courseId, courseSlug });
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
      logTool({
        toolName: "list_lessons",
        input: { courseSlug },
        courseId: ctx.mode === "tenant" ? ctx.course.id : null,
        output: { count: lessons.length, totalDurationSec: total },
        latencyMs: Date.now() - t0,
      });
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
        courseId: courseIdField, courseSlug: courseSlugField,
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
    async ({ courseId, courseSlug, lessonNumber, lessonId, includeFullTranscript }) => {
      const t0 = Date.now();
      const limited = await rateLimitOrError("get_lesson");
      if (limited) return limited;
      const ctx = await resolveCourseCtx({ courseId, courseSlug });
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
      logTool({
        toolName: "get_lesson",
        input: { courseSlug, lessonNumber, lessonId, includeFullTranscript },
        courseId: ctx.mode === "tenant" ? ctx.course.id : null,
        output: { lessonNumber: lesson.lessonNumber, transcriptAvailable: !!lesson.segments },
        latencyMs: Date.now() - t0,
      });
      return { content: [{ type: "text", text: body }], structuredContent };
    },
  );

  server.registerTool(
    "search_course",
    {
      title: "Buscar no conteúdo do curso",
      description: "Busca semântica nas transcrições e materiais do curso. Use isto sempre que o aluno perguntar sobre um conceito — retorna trechos relevantes com aula e timestamp para fundamentar a resposta.",
      inputSchema: {
        courseId: courseIdField, courseSlug: courseSlugField,
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
    async ({ courseId, courseSlug, query, limit, lessonNumber }) => {
      const t0 = Date.now();
      const limited = await rateLimitOrError("search_course");
      if (limited) return limited;
      const ctx = await resolveCourseCtx({ courseId, courseSlug });
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
      // Telemetry: record the tool call + (for tenant mode) the embedded
      // query so the admin can cluster top topics. result_lesson_ids comes
      // from the matched chunks' lesson IDs (unique-flatten).
      if (tenant && ctx.mode === "tenant") {
        const lessonIds = Array.from(new Set(hits.map((h) => h.lessonNumber).filter((n): n is number => n != null).map(String)));
        recordSearchQuery({
          tenantId: tenant.id,
          courseId: ctx.course.id,
          studentId: auth.studentId,
          query,
          queryEmbedding: qv,
          // result_lesson_ids in schema is UUID[]; we don't have the UUIDs here
          // from search results (we have lesson_number), so empty for now —
          // future improvement: have searchChunksForCourse return lesson UUIDs.
          resultLessonIds: [],
        });
        void lessonIds;
      }
      logTool({
        toolName: "search_course",
        input: { courseSlug, query, limit, lessonNumber },
        courseId: ctx.mode === "tenant" ? ctx.course.id : null,
        output: { hitCount: hits.length },
        latencyMs: Date.now() - t0,
      });
      return { content: [{ type: "text", text }], structuredContent: { query, hits } };
    },
  );

  server.registerTool(
    "play_lesson",
    {
      title: "Renderizar player da aula no chat",
      description: "Renderiza o player de vídeo Panda inline no chat, opcionalmente começando em um timestamp. Use quando o aluno pedir 'me mostra essa parte' ou quando uma resposta se beneficie de ver o vídeo.",
      inputSchema: {
        courseId: courseIdField, courseSlug: courseSlugField,
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
      // Tool-level _meta points to the LEGACY v2 URI for two reasons:
      //   1. ChatGPT Apps SDK caches widget HTML by `openai/outputTemplate`
      //      URI — a per-call URI would defeat the cache and break the iframe
      //      template lookup. v2 is stable.
      //   2. Tool metadata is a class-level template hint, not a per-call
      //      ref. The per-call URI with embedded data is set on the result
      //      below via `_meta.ui.resourceUri`.
      _meta: {
        ui: { resourceUri: PLAYER_WIDGET_URI_V2 },
        ...(adapterMode === "appsSdk"
          ? {
              "openai/outputTemplate": PLAYER_WIDGET_URI_V2,
              "openai/toolInvocation/invoking": "Carregando aula...",
              "openai/toolInvocation/invoked": "Aula carregada",
              "openai/widgetAccessible": true,
            }
          : {}),
      },
    },
    async ({ courseId, courseSlug, lessonNumber, lessonId, startSec }) => {
      const t0 = Date.now();
      const limited = await rateLimitOrError("play_lesson");
      if (limited) return limited;
      const ctx = await resolveCourseCtx({ courseId, courseSlug });
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
      logTool({
        toolName: "play_lesson",
        input: { courseSlug, lessonNumber, lessonId, startSec },
        courseId: ctx.mode === "tenant" ? ctx.course.id : null,
        output: { lessonNumber: lesson.lessonNumber, startSec: startSec ?? 0 },
        latencyMs: Date.now() - t0,
      });
      // Track per-student progress on the lesson the agent chose to play.
      if (tenant && auth.studentId && ctx.mode === "tenant") {
        recordPlayLesson({
          studentId: auth.studentId,
          lessonId: lesson.id,
          startSec: startSec ?? 0,
        });
      }
      // Phase 10: per-call URI carries the render data inline so the widget
      // hydrates even after the original MCP session is gone (deploy reset).
      const perCallUri = buildPlayerWidgetUri({
        hlsUrl: structuredContent.hlsUrl,
        embedUrl: structuredContent.embedUrl,
        title: structuredContent.title,
        id: structuredContent.id,
        lessonNumber: structuredContent.lessonNumber,
        ...(typeof structuredContent.startSec === "number"
          ? { startSec: structuredContent.startSec }
          : {}),
      });
      return {
        content: [{ type: "text", text: label }],
        structuredContent,
        _meta: {
          // Result-level pointer → the stateless v3 URI with embedded data.
          // Hosts that honor `_meta.ui.resourceUri` (Claude MCP Apps) will
          // resolve THIS URI and render the hydrated HTML directly.
          ui: { resourceUri: perCallUri },
          ...(adapterMode === "appsSdk"
            ? {
                // ChatGPT Apps SDK template lookup: keep the static v2 URI
                // (it caches by template). The structuredContent above still
                // gets posted to the widget via window.openai.toolOutput.
                "openai/outputTemplate": PLAYER_WIDGET_URI_V2,
              }
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
        courseId: courseIdField, courseSlug: courseSlugField,
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
    async ({ courseId, courseSlug, lessonNumber, lessonId, startSec, endSec }) => {
      const t0 = Date.now();
      const limited = await rateLimitOrError("excerpt_transcript");
      if (limited) return limited;
      const ctx = await resolveCourseCtx({ courseId, courseSlug });
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
      logTool({
        toolName: "excerpt_transcript",
        input: { courseSlug, lessonNumber, lessonId, startSec, endSec },
        courseId: ctx.mode === "tenant" ? ctx.course.id : null,
        output: { segmentCount: segs.length },
        latencyMs: Date.now() - t0,
      });
      return { content: [{ type: "text", text: body }], structuredContent };
    },
  );

  // list_courses is registered in both tenant-scoped and global modes.
  // Global mode returns cross-tenant courses with a `${infoprodutor} —
  // ${curso}` display name and the courseId UUID. Tenant mode keeps
  // the per-tenant catalog. Legacy MVP single-tenant skips it.
  if (tenant || isGlobal) {
    server.registerTool(
      "list_courses",
      {
        title: "Listar seus cursos",
        description: "Lista todos os cursos que o aluno tem acesso. Use isto SEMPRE no início pra descobrir o courseId. Em modo global, retorna cursos de múltiplos infoprodutores.",
        inputSchema: {},
        outputSchema: {
          courses: z.array(z.object({
            courseId: z.string(),
            slug: z.string(),
            name: z.string(),
            tenantName: z.string().optional(),
            displayName: z.string().optional(),
          })),
        },
        annotations: readOnlyAnnotations,
      },
      async () => {
        const t0 = Date.now();
        const limited = await rateLimitOrError("list_courses");
        if (limited) return limited;

        // ----- Global mode: cross-tenant courses -----
        if (isGlobal) {
          const courses = auth.accessibleCourses ?? [];
          logTool({
            toolName: "list_courses",
            input: {},
            courseId: null,
            output: { count: courses.length, mode: "global" },
            latencyMs: Date.now() - t0,
          });
          if (!courses.length) {
            return {
              content: [{ type: "text", text: "Você ainda não tem acesso a nenhum curso. Confirme que comprou no Hotmart." }],
              structuredContent: { courses: [] },
            };
          }
          const text = `# Seus cursos (${courses.length})\n\n` +
            courses.map((c, i) => `${i + 1}. **${c.displayName}** \`(courseId: ${c.courseId})\``).join("\n");
          return {
            content: [{ type: "text", text }],
            structuredContent: {
              courses: courses.map((c) => ({
                courseId: c.courseId,
                slug: c.courseSlug,
                name: c.courseName,
                tenantName: c.tenantName,
                displayName: c.displayName,
              })),
            },
          };
        }

        // ----- Tenant-scoped mode -----
        const { listCoursesForTenant } = await import("./lib/courses.ts");
        const all = await listCoursesForTenant(tenant!.id);
        const accessible = new Set(auth.accessibleCourseIds ?? []);
        const courses = all.filter((c) => accessible.has(c.id));
        logTool({
          toolName: "list_courses",
          input: {},
          courseId: null,
          output: { count: courses.length, mode: "tenant" },
          latencyMs: Date.now() - t0,
        });
        if (!courses.length) {
          return {
            content: [{ type: "text", text: "Você ainda não tem acesso a nenhum curso deste tenant." }],
            structuredContent: { courses: [] },
          };
        }
        const text = `# Seus cursos (${courses.length})\n\n` +
          courses.map((c, i) => `${i + 1}. **${c.name}** \`(courseId: ${c.id})\``).join("\n");
        return {
          content: [{ type: "text", text }],
          structuredContent: {
            courses: courses.map((c) => ({ courseId: c.id, slug: c.slug, name: c.name })),
          },
        };
      },
    );

    // ----- get_my_progress (tenant-only) -----
    server.registerTool(
      "get_my_progress",
      {
        title: "Meu progresso no curso",
        description: "Mostra as aulas que você já tocou no chat e onde parou. Use quando o aluno perguntar 'em que aula eu estou?' ou 'o que já vi?'.",
        inputSchema: { courseId: courseIdField, courseSlug: courseSlugField },
        outputSchema: {
          courseName: z.string(),
          totalLessons: z.number(),
          visitedLessons: z.number(),
          completionPct: z.number(),
          lessons: z.array(z.object({
            lessonNumber: z.number().nullable(),
            title: z.string(),
            visited: z.boolean(),
            lastPositionSec: z.number(),
            completed: z.boolean(),
          })),
        },
        annotations: readOnlyAnnotations,
      },
      async ({ courseId, courseSlug }) => {
        const t0 = Date.now();
        const limited = await rateLimitOrError("get_my_progress");
        if (limited) return limited;
        const ctx = await resolveCourseCtx({ courseId, courseSlug });
        if (ctx.mode !== "tenant") {
          return { isError: true, content: [{ type: "text", text: ctx.mode === "error" ? ctx.message : "Progresso só disponível em sessões autenticadas." }] };
        }
        if (!auth.studentId) {
          return { isError: true, content: [{ type: "text", text: "Sessão sem autenticação — não consigo recuperar seu progresso." }] };
        }

        const [allLessons, progressRows] = await Promise.all([
          listLessonsForCourse(ctx.course.id),
          getProgressForCourse(auth.studentId, ctx.course.id),
        ]);
        const progressById = new Map(progressRows.map((p) => [p.lessonId, p]));
        const lessonsOut = allLessons.map((l) => {
          const p = progressById.get(l.id);
          return {
            lessonNumber: l.lessonNumber,
            title: l.title,
            visited: !!p,
            lastPositionSec: p?.lastPositionSec ?? 0,
            completed: !!p?.completedAt,
          };
        });
        const visitedCount = lessonsOut.filter((l) => l.visited).length;
        const pct = allLessons.length ? Math.round((visitedCount / allLessons.length) * 100) : 0;
        const body =
          `# Seu progresso em ${ctx.course.name}\n\n` +
          `Visitadas: **${visitedCount} de ${allLessons.length}** (${pct}%)\n\n` +
          lessonsOut.map((l) => {
            const mark = l.completed ? "✅" : l.visited ? "▶" : "—";
            const pos = l.visited && l.lastPositionSec > 0
              ? ` (último ponto: ${formatTimestamp(l.lastPositionSec)})` : "";
            return `${mark} ${String(l.lessonNumber ?? "?").padStart(2, "0")}. ${l.title}${pos}`;
          }).join("\n");

        logTool({
          toolName: "get_my_progress",
          input: { courseSlug },
          courseId: ctx.course.id,
          output: { visitedCount, pct },
          latencyMs: Date.now() - t0,
        });
        return {
          content: [{ type: "text", text: body }],
          structuredContent: {
            courseName: ctx.course.name,
            totalLessons: allLessons.length,
            visitedLessons: visitedCount,
            completionPct: pct,
            lessons: lessonsOut,
          },
        };
      },
    );
  }

  return server;
}
