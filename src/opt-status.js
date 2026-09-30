function apiBase(source) {
  return String(source.apiUrl || "").replace(/\/+$/, "");
}

function serviceOrigin(source) {
  const url = new URL(apiBase(source));
  url.pathname = url.pathname.replace(/\/api\/?$/, "") || "/";
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/+$/, "");
}

async function request(source, route, method = "GET") {
  const response = await fetch(`${apiBase(source)}${route}`, {
    method,
    headers: {
      "X-Access-Token": source.accessToken,
      ...(method === "POST" ? { "Content-Type": "application/json" } : {}),
    },
    ...(method === "POST" ? { body: "{}" } : {}),
    signal: AbortSignal.timeout(15_000),
  });
  const body = await response.json().catch(() => ({}));
  if (
    !response.ok ||
    body.Success === false ||
    body.success === false ||
    Number(body.Code ?? body.code ?? 0) !== 0
  ) {
    const error = new Error(
      String(body.Message || body.message || `HTTP ${response.status}`).slice(
        0,
        300,
      ),
    );
    error.status = response.status;
    throw error;
  }
  return body;
}

async function health(source) {
  const response = await fetch(`${serviceOrigin(source)}/health`, {
    headers: {
      "X-Access-Token": source.accessToken,
    },
    signal: AbortSignal.timeout(15_000),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.ok === false) {
    throw new Error(
      String(body.message || `HTTP ${response.status}`).slice(0, 300),
    );
  }
  return body;
}

export async function probeOptSource(source) {
  const checkedAt = new Date().toISOString();
  if (!source.enabled) {
    return {
      id: source.id,
      displayName: source.displayName,
      enabled: false,
      ready: false,
      state: "disabled",
      checkedAt,
    };
  }
  if (!source.apiUrl || !source.wsUrl || !source.accessToken) {
    return {
      id: source.id,
      displayName: source.displayName,
      enabled: true,
      ready: false,
      state: "configuration-incomplete",
      checkedAt,
    };
  }
  try {
    let data;
    let online = null;
    try {
      // Aggregate /health can be degraded by an unrelated installed account.
      const body = await request(source, "/v1/session/connection-status", "POST");
      data = body.Data ?? body.data ?? {};
    } catch (error) {
      if (![404, 405].includes(error.status)) throw error;
      try {
        data = await health(source);
      } catch {
        const body = await request(source, "/Login/LongLinkStatus");
        data = body.Data ?? body.data ?? {};
        try {
          const onlineBody = await request(source, "/User/GetOnlineInfo");
          online = Boolean((onlineBody.Data ?? onlineBody.data ?? {}).online);
        } catch {
          // OnlineInfo is optional on legacy gateways.
        }
      }
    }
    const state = String(data.stage || "unknown");
    const longLinkReady = Boolean(
      data.longLinkReady ?? data.long_link_ready,
    );
    return {
      id: source.id,
      displayName: source.displayName,
      runtimeKind: "opt",
      enabled: true,
      ready:
        longLinkReady &&
        state.toLowerCase() === "ready" &&
        online !== false,
      online,
      state,
      loginState: state,
      buildRevision: String(
        data.buildRevision || data.build_revision || "",
      ),
      checkedAt,
      lastError: "",
    };
  } catch (error) {
    return {
      id: source.id,
      displayName: source.displayName,
      runtimeKind: "opt",
      enabled: true,
      ready: false,
      state: "error",
      checkedAt,
      lastError: String(error.message || error).slice(0, 500),
    };
  }
}
