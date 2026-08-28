const ALLOWED_ORIGINS = new Set([
  "https://angrytracker.com",
  "https://www.angrytracker.com"
]);

function corsHeaders(request) {
  const origin = request.headers.get("Origin") || "";
  const allowOrigin = ALLOWED_ORIGINS.has(origin)
    ? origin
    : "https://angrytracker.com";

  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
    "X-Content-Type-Options": "nosniff"
  };
}

function jsonResponse(request, data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...corsHeaders(request),
      "Content-Type": "application/json"
    }
  });
}

async function forwardToPinata(request, env, endpoint, contentType) {
  if (!env.PINATA_JWT) {
    return jsonResponse(request, {
      ok: false,
      error: "PINATA_JWT is not configured"
    }, 500);
  }

  const headers = {
    "Authorization": "Bearer " + env.PINATA_JWT
  };

  if (contentType) {
    headers["Content-Type"] = contentType;
  }

  try {
    const upstream = await fetch(endpoint, {
      method: "POST",
      headers,
      body: request.body
    });

    const body = await upstream.arrayBuffer();

    const responseHeaders = {
      ...corsHeaders(request)
    };

    const upstreamType = upstream.headers.get("Content-Type");
    if (upstreamType) {
      responseHeaders["Content-Type"] = upstreamType;
    }

    return new Response(body, {
      status: upstream.status,
      headers: responseHeaders
    });

  } catch (error) {
    return jsonResponse(request, {
      ok: false,
      error: error?.message || String(error)
    }, 502);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders(request)
      });
    }

    if (
      request.method === "GET" &&
      (url.pathname === "/" || url.pathname === "/health")
    ) {
      return jsonResponse(request, {
        ok: true,
        service: "ANGRY NFT Storage",
        pinataConfigured: Boolean(env.PINATA_JWT)
      });
    }

    if (
      request.method === "POST" &&
      url.pathname === "/pinFileToIPFS"
    ) {
      const contentType =
        request.headers.get("Content-Type") || "";

      if (!contentType.includes("multipart/form-data")) {
        return jsonResponse(request, {
          ok: false,
          error: "Expected multipart/form-data"
        }, 400);
      }

      return forwardToPinata(
        request,
        env,
        "https://api.pinata.cloud/pinning/pinFileToIPFS",
        contentType
      );
    }

    if (
      request.method === "POST" &&
      url.pathname === "/pinJSONToIPFS"
    ) {
      return forwardToPinata(
        request,
        env,
        "https://api.pinata.cloud/pinning/pinJSONToIPFS",
        "application/json"
      );
    }

    return jsonResponse(request, {
      ok: false,
      error: "Not found"
    }, 404);
  }
};
