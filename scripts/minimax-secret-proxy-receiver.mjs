#!/usr/bin/env node

import { createServer } from "node:http";

const HOST = process.env.HOST ?? "127.0.0.1";
const PORT = Number.parseInt(process.env.PORT ?? "18790", 10);

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function safeParseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function decodeProxyBody(body) {
  if (!Array.isArray(body)) {
    return { text: undefined, json: undefined };
  }
  const bytes = Uint8Array.from(body);
  const decodedText = new TextDecoder().decode(bytes);
  return {
    text: decodedText,
    json: safeParseJson(decodedText),
  };
}

const server = createServer(async (req, res) => {
  const now = new Date().toISOString();
  const rawBody = await readRequestBody(req); // HTTP 请求的 body
  const bodyText = rawBody.toString("utf8");
  const parsed = safeParseJson(bodyText);

  // HTTP 请求体（raw HTTP body）解析出来的 JSON 对象里的 body 字段，也就是 SecretProxyRequest.body
  // SecretProxyRequest.body 中是 "真正的 minimax/Anthropic 请求 payload"
  const decoded = decodeProxyBody(parsed?.body);
  const decodedJson = decoded.json && typeof decoded.json === "object" ? decoded.json : undefined;
  const requestedModel =
    decodedJson && "model" in decodedJson && typeof decodedJson.model === "string"
      ? decodedJson.model
      : "unknown";

  // Keep console output compact but complete enough for manual verification.
  console.log("\n================ MiniMax Secret Proxy Request ================");
  console.log(`[${now}] ${req.method} ${req.url}`);
  console.log("headers:", req.headers);
  // console.log("rawBody:", bodyText);
  if (parsed) {
    console.log("proxy fields:", {
      key_id: parsed.key_id,
      endpoint_url: parsed.endpoint_url,
      method: parsed.method,
      headers: parsed.headers,
      body_length: Array.isArray(parsed.body) ? parsed.body.length : undefined,
    });
  } else {
    console.log("proxy fields: body is not valid JSON");
  }

  // decoded.text 和 decoded.json 是同一份数据（SecretProxyRequest.body）的不同展示形式.
  // decoded.text 是 UTF-8 字符串，decoded.json 是 JSON 对象.
  // if (decoded.text) {
  //   console.log("decoded minimax payload text:", decoded.text);
  // }
  if (decoded.json) {
    console.log("decoded minimax payload json:", decoded.json);
  }
  console.log("=============================================================\n");

  // Respond with Anthropic-style SSE events so that the upstream Anthropic JS client
  // (used by pi-ai's streaming provider) sees a normal streaming response.
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  res.flushHeaders?.();

  const messageId = `msg_${Date.now()}`;
  const contentText = "ok (captured by local secret proxy receiver)";

  console.log("responding with anthropic-style SSE events");

  const writeEvent = (eventName, obj) => {
    res.write(`event: ${eventName}\n`);
    res.write(`data: ${JSON.stringify(obj)}\n\n`);
  };

  // Minimal Anthropic SSE message lifecycle.
  writeEvent("message_start", {
    type: "message_start",
    message: {
      id: messageId,
      type: "message",
      role: "assistant",
      model: requestedModel,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    },
  });
  writeEvent("content_block_start", {
    type: "content_block_start",
    index: 0,
    content_block: { type: "text", text: "" },
  });
  writeEvent("content_block_delta", {
    type: "content_block_delta",
    index: 0,
    delta: { type: "text_delta", text: contentText },
  });
  writeEvent("content_block_stop", { type: "content_block_stop", index: 0 });
  writeEvent("message_delta", {
    type: "message_delta",
    delta: { stop_reason: "end_turn", stop_sequence: null },
    usage: { output_tokens: 0 },
  });
  writeEvent("message_stop", { type: "message_stop" });
  res.end();
});

server.listen(PORT, HOST, () => {
  console.log(`MiniMax secret proxy receiver is listening on http://${HOST}:${PORT}`);
  console.log("Press Ctrl+C to stop.");
});
