import http from "node:http";
import { normalizeHookEvent } from "./normalize.js";
import { validSignature } from "./security.js";
import {
  ADMIN_CSS,
  ADMIN_HTML,
  ADMIN_JS,
} from "./generated/admin-assets.js";

async function readBody(request, limit = 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw new Error("request body too large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function respond(response, status, body, contentType = "application/json") {
  response.writeHead(status, {
    "Content-Type": contentType,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
  });
  if (typeof body === "string") {
    response.end(body);
    return;
  }
  response.end(`${JSON.stringify(body)}\n`);
}

function localRequest(request) {
  return ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(
    request.socket.remoteAddress,
  );
}

function adminHtml(application) {
  let revision = "";
  try {
    revision = String(application?.status()?.runtime?.sourceRevision || "");
  } catch {
    revision = "";
  }
  const escaped = revision
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
  return ADMIN_HTML.replace("__WEBOT_RUNTIME_REVISION__", escaped);
}

export function createServer({
  application,
  config,
  runtime,
  padClient,
  padClients = padClient ? [padClient] : [],
  logger = console,
}) {
  const startedAt = Date.now();
  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, "http://127.0.0.1");
      const currentConfig = application?.config || config;
      const currentRuntime = application?.runtime || runtime;
      if (request.method === "GET" && url.pathname === "/health") {
        const health = application?.status() || {
          ok: true,
          service: "webot",
          uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
          channels: [...currentConfig.channels],
          outboundMode: currentConfig.outboundMode,
        };
        respond(
          response,
          health.ok === false ? 503 : 200,
          health,
        );
        return;
      }
      if (request.method === "GET" && url.pathname === "/") {
        respond(
          response,
          200,
          adminHtml(application),
          "text/html; charset=utf-8",
        );
        return;
      }
      if (request.method === "GET" && url.pathname === "/assets/admin.css") {
        respond(response, 200, ADMIN_CSS, "text/css; charset=utf-8");
        return;
      }
      if (request.method === "GET" && url.pathname === "/assets/admin.js") {
        respond(
          response,
          200,
          ADMIN_JS,
          "text/javascript; charset=utf-8",
        );
        return;
      }

      if (url.pathname.startsWith("/api/admin/")) {
        if (!application) {
          respond(response, 503, { ok: false, error: "admin unavailable" });
          return;
        }
        if (!localRequest(request)) {
          respond(response, 403, { ok: false, error: "local access only" });
          return;
        }
        if (
          request.method === "GET" &&
          url.pathname === "/api/admin/status"
        ) {
          respond(response, 200, application.status());
          return;
        }
        if (
          request.method === "GET" &&
          url.pathname === "/api/admin/settings"
        ) {
          respond(response, 200, {
            ok: true,
            settings: application.settings(),
          });
          return;
        }
        if (
          request.method === "PUT" &&
          url.pathname === "/api/admin/settings"
        ) {
          const body = JSON.parse((await readBody(request)).toString("utf8"));
          const settings = await application.updateSettings(body);
          respond(response, 200, { ok: true, settings });
          return;
        }
        if (
          request.method === "POST" &&
          url.pathname === "/api/admin/kb/sync"
        ) {
          respond(response, 200, {
            ok: true,
            knowledgeBase: await application.syncKnowledgeBase(),
          });
          return;
        }
        if (
          request.method === "GET" &&
          url.pathname === "/api/admin/agent"
        ) {
          respond(response, 200, {
            ok: true,
            document: await application.agentDocument(),
          });
          return;
        }
        if (
          request.method === "PUT" &&
          url.pathname === "/api/admin/agent"
        ) {
          const body = JSON.parse((await readBody(request)).toString("utf8"));
          respond(response, 200, {
            ok: true,
            document: await application.saveAgentDocument(
              body.content,
              String(body.baseHash || ""),
            ),
          });
          return;
        }
        if (
          request.method === "GET" &&
          url.pathname === "/api/admin/kb/documents"
        ) {
          respond(response, 200, {
            ok: true,
            documents: await application.knowledgeDocuments(),
          });
          return;
        }
        if (
          request.method === "GET" &&
          url.pathname === "/api/admin/kb/document"
        ) {
          respond(response, 200, {
            ok: true,
            document: await application.knowledgeDocument(
              String(url.searchParams.get("file") || ""),
            ),
          });
          return;
        }
        if (
          request.method === "PUT" &&
          url.pathname === "/api/admin/kb/document"
        ) {
          const body = JSON.parse((await readBody(request)).toString("utf8"));
          respond(response, 200, {
            ok: true,
            document: await application.saveKnowledgeDocument(
              body.file,
              body.content,
              String(body.baseHash || ""),
            ),
          });
          return;
        }
        if (
          request.method === "DELETE" &&
          url.pathname === "/api/admin/kb/document"
        ) {
          const body = JSON.parse((await readBody(request)).toString("utf8"));
          respond(response, 200, {
            ok: true,
            deleted: await application.deleteKnowledgeDocument(
              body.file,
              String(body.baseHash || ""),
            ),
          });
          return;
        }
        if (
          request.method === "POST" &&
          url.pathname === "/api/admin/opt/test"
        ) {
          const body = JSON.parse((await readBody(request)).toString("utf8"));
          respond(response, 200, {
            ok: true,
            source: await application.testOpt(String(body.sourceId || "")),
          });
          return;
        }
        if (
          request.method === "GET" &&
          url.pathname === "/api/admin/directory"
        ) {
          respond(response, 200, {
            ok: true,
            entries: application.directory({
              sourceId: url.searchParams.get("sourceId"),
              entityType: url.searchParams.get("type"),
              query: url.searchParams.get("query"),
              limit: url.searchParams.get("limit"),
            }),
          });
          return;
        }
        if (
          request.method === "GET" &&
          url.pathname === "/api/admin/captured"
        ) {
          respond(response, 200, {
            ok: true,
            ...application.capturedMessages({
              sourceId: url.searchParams.get("sourceId"),
              chatType: url.searchParams.get("chatType"),
              result: url.searchParams.get("result"),
              query: url.searchParams.get("query"),
              limit: url.searchParams.get("limit"),
              offset: url.searchParams.get("offset"),
            }),
          });
          return;
        }
        if (
          request.method === "POST" &&
          url.pathname === "/api/admin/directory/sync"
        ) {
          const body = JSON.parse((await readBody(request)).toString("utf8"));
          respond(response, 200, {
            ok: true,
            ...(await application.syncDirectory(String(body.sourceId || ""))),
          });
          return;
        }
        if (
          request.method === "GET" &&
          url.pathname === "/api/admin/cases"
        ) {
          const page = application.listCases({
            limit: url.searchParams.get("limit"),
            offset: url.searchParams.get("offset"),
          });
          respond(response, 200, {
            ok: true,
            ...page,
            workers: application.caseManager.status(),
          });
          return;
        }
        if (
          request.method === "GET" &&
          url.pathname === "/api/admin/case"
        ) {
          const value = application.caseDetail(
            String(url.searchParams.get("caseId") || ""),
            {
              expanded: url.searchParams.get("history") === "1",
            },
          );
          if (!value) {
            respond(response, 404, { ok: false, error: "case not found" });
            return;
          }
          respond(response, 200, { ok: true, case: value });
          return;
        }
        if (
          request.method === "POST" &&
          url.pathname === "/api/admin/case/run"
        ) {
          const body = JSON.parse((await readBody(request)).toString("utf8"));
          respond(response, 200, {
            ok: true,
            ...application.runCase(String(body.caseId || "")),
          });
          return;
        }
        if (
          request.method === "POST" &&
          url.pathname === "/api/admin/case/stop"
        ) {
          const body = JSON.parse((await readBody(request)).toString("utf8"));
          respond(response, 200, {
            ok: true,
            stopped: application.stopCase(String(body.caseId || "")),
          });
          return;
        }
        if (
          request.method === "POST" &&
          url.pathname === "/api/admin/case/session/reset"
        ) {
          const body = JSON.parse((await readBody(request)).toString("utf8"));
          respond(response, 200, {
            ok: true,
            reset: application.resetCaseSession(String(body.caseId || "")),
          });
          return;
        }
        if (
          request.method === "POST" &&
          url.pathname === "/api/admin/case/send"
        ) {
          const body = JSON.parse((await readBody(request)).toString("utf8"));
          respond(response, 200, {
            ok: true,
            outbound: await application.sendDraft(
              String(body.caseId || ""),
              Number(body.draftId || 0),
            ),
          });
          return;
        }
        if (
          request.method === "POST" &&
          url.pathname === "/api/admin/workers/pause"
        ) {
          const body = JSON.parse((await readBody(request)).toString("utf8"));
          respond(response, 200, {
            ok: true,
            paused: application.setWorkersPaused(Boolean(body.paused)),
          });
          return;
        }
        if (
          request.method === "POST" &&
          url.pathname === "/api/admin/workers/drain"
        ) {
          respond(response, 200, {
            ok: true,
            workers: application.beginWorkerDrain(),
          });
          return;
        }
        respond(response, 404, { ok: false, error: "not found" });
        return;
      }

      const routes = {
        "/webhooks/hook": {
          channel: "hook",
          secret: currentConfig.hook.callbackSecret,
          normalize(value) {
            const message = normalizeHookEvent(value);
            return message ? [message] : [];
          },
        },
      };
      const route = routes[url.pathname];
      if (request.method !== "POST" || !route) {
        respond(response, 404, { ok: false, error: "not found" });
        return;
      }
      if (!currentConfig.channels.has(route.channel)) {
        respond(response, 503, { ok: false, error: "channel disabled" });
        return;
      }

      const rawBody = await readBody(request);
      if (
        !validSignature(
          rawBody,
          request.headers["x-webot-signature"],
          route.secret,
        )
      ) {
        respond(response, 401, { ok: false, error: "invalid signature" });
        return;
      }

      const messages = route.normalize(JSON.parse(rawBody.toString("utf8")));
      const results = await Promise.all(
        messages.map((message) =>
          application
            ? application.receive(message)
            : currentRuntime.receive(message),
        ),
      );
      respond(response, 202, { ok: true, messages: messages.length, results });
    } catch (error) {
      logger.error("request failed", { error: error.message });
      respond(
        response,
        ["FILE_CONFLICT", "KB_CONFLICT"].includes(error.code) ? 409 : 400,
        {
          ok: false,
          error: error.message,
          ...(error.current ? { current: error.current } : {}),
        },
      );
    }
  });

  return {
    start() {
      return new Promise((resolve, reject) => {
        server.once("error", reject);
        const currentConfig = application?.config || config;
        server.listen(currentConfig.server.port, currentConfig.server.host, async () => {
          server.off("error", reject);
          if (application) await application.startConnectors();
          else for (const client of padClients) client.start();
          resolve(server.address());
        });
      });
    },
    async stop() {
      if (application) await application.stopConnectors();
      else for (const client of padClients) client.stop();
      if (!server.listening) return;
      await new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
    server,
  };
}
