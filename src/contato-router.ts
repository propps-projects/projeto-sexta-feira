/**
 * Formulário de contato "Falar com Askine™" da landing page.
 *
 * POST /contato  { nome, email, assunto, mensagem }
 *   → envia um e-mail transacional via Brevo para a caixa de contato.
 *   → replyTo aponta para o e-mail do visitante (responde direto na sua caixa).
 *
 * Env:
 *   BREVO_API_KEY        (obrigatório) — chave da API transacional do Brevo
 *   CONTACT_TO_EMAIL     (default box@askine.cc) — destino das mensagens
 *   CONTACT_FROM_EMAIL   (default no-reply@askine.cc) — remetente verificado no Brevo
 *   CONTACT_FROM_NAME    (default "Askine LP")
 */

import type { IncomingMessage, ServerResponse } from "node:http";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const BREVO_ENDPOINT = "https://api.brevo.com/v3/smtp/email";

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const c of req) {
    total += (c as Buffer).length;
    if (total > 64 * 1024) throw new Error("payload_too_large"); // 64KB de teto
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );
}

export type ContatoRoute = { kind: "submit" };

export function matchContatoRoute(path: string, method: string): ContatoRoute | null {
  if (path === "/contato" && method === "POST") return { kind: "submit" };
  return null;
}

export async function handleContatoRoute(
  _route: ContatoRoute,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  let raw: string;
  try {
    raw = await readBody(req);
  } catch {
    return json(res, 413, { ok: false, error: "Mensagem muito longa." });
  }

  let data: Record<string, unknown>;
  try {
    data = JSON.parse(raw || "{}");
  } catch {
    return json(res, 400, { ok: false, error: "Requisição inválida." });
  }

  const nome = String(data.nome ?? "").trim().slice(0, 120);
  const email = String(data.email ?? "").trim().slice(0, 160);
  const assunto = String(data.assunto ?? "").trim().slice(0, 140);
  const mensagem = String(data.mensagem ?? "").trim().slice(0, 2000);

  if (!nome || !assunto || !mensagem) return json(res, 400, { ok: false, error: "Preencha todos os campos." });
  if (!EMAIL_RE.test(email)) return json(res, 400, { ok: false, error: "E-mail inválido." });

  const apiKey = process.env.BREVO_API_KEY;
  if (!apiKey) {
    console.error("[contato] BREVO_API_KEY ausente — não foi possível enviar.");
    return json(res, 503, { ok: false, error: "Envio indisponível no momento." });
  }

  const to = process.env.CONTACT_TO_EMAIL ?? "box@askine.cc";
  const fromEmail = process.env.CONTACT_FROM_EMAIL ?? "no-reply@askine.cc";
  const fromName = process.env.CONTACT_FROM_NAME ?? "Askine LP";

  const htmlContent =
    `<h2 style="margin:0 0 12px">Nova mensagem — Falar com Askine™</h2>` +
    `<p><strong>Nome:</strong> ${esc(nome)}</p>` +
    `<p><strong>E-mail:</strong> ${esc(email)}</p>` +
    `<p><strong>Assunto:</strong> ${esc(assunto)}</p>` +
    `<p><strong>Mensagem:</strong></p>` +
    `<p style="white-space:pre-wrap">${esc(mensagem)}</p>`;
  const textContent = `Nova mensagem — Falar com Askine\n\nNome: ${nome}\nE-mail: ${email}\nAssunto: ${assunto}\n\n${mensagem}`;

  try {
    const r = await fetch(BREVO_ENDPOINT, {
      method: "POST",
      headers: { "api-key": apiKey, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        sender: { name: fromName, email: fromEmail },
        to: [{ email: to }],
        replyTo: { email, name: nome },
        subject: `[Contato LP] ${assunto}`,
        htmlContent,
        textContent,
      }),
    });
    if (!r.ok) {
      const detail = await r.text().catch(() => "");
      console.error(`[contato] Brevo respondeu ${r.status}: ${detail.slice(0, 400)}`);
      return json(res, 502, { ok: false, error: "Não foi possível enviar agora." });
    }
  } catch (err) {
    console.error("[contato] falha ao chamar Brevo:", err);
    return json(res, 502, { ok: false, error: "Não foi possível enviar agora." });
  }

  return json(res, 200, { ok: true });
}
