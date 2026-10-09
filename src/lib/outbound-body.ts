import type { IncomingMessage } from "node:http";
import type { Transform } from "node:stream";
import { TextDecoder } from "node:util";
import zlib from "node:zlib";
import { QueryFailure } from "./query-trace";
import type { QueryResponseInfo } from "./query-diagnostics";

const MAX_BYTES = 1048576;

// Only bounded enums and counters leave this module, never headers or body text.
export function readResponseBody(
  res: IncomingMessage,
  report?: (info: QueryResponseInfo) => void,
) {
  const mime = (res.headers?.["content-type"] || "")
    .split(";", 1)[0]
    .trim()
    .toLowerCase();
  const encoding = (res.headers?.["content-encoding"] ?? "identity")
    .trim()
    .toLowerCase();
  const info: QueryResponseInfo = {
    mediaType: !mime
      ? "missing"
      : /^application\/(?:json|[^\s/;]+\+json)$/.test(mime)
        ? "json"
        : mime === "text/html" || mime === "application/xhtml+xml"
          ? "html"
          : mime.startsWith("text/")
            ? "text"
            : "other",
    encoding: ["identity", "gzip", "deflate", "br"].includes(encoding)
      ? (encoding as QueryResponseInfo["encoding"])
      : "unsupported",
    bodyKind: "unknown",
    wireBytes: 0,
    decodedBytes: 0,
  };
  let decoder: Transform | undefined,
    settled = false,
    received = false;
  const chunks: Buffer[] = [];
  let resolve: (data: unknown) => void, reject: (error: QueryFailure) => void;
  const promise = new Promise<unknown>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  const publish = () => report?.({ ...info });
  const finish = (error?: QueryFailure, data?: unknown) => {
    if (settled) return;
    settled = true;
    res.removeListener("data", onWire);
    const source = decoder || res;
    source.removeListener("data", onDecoded);
    source.removeListener("end", onEnd);
    if (decoder) {
      res.unpipe(decoder);
      decoder.destroy();
    }
    chunks.length = 0;
    publish();
    if (error) reject(error);
    else resolve(data);
  };
  const onWire = (chunk: Buffer) => {
    if (settled) return;
    info.wireBytes += chunk.length;
    publish();
    if (info.wireBytes > MAX_BYTES)
      finish(
        new QueryFailure("response_too_large", "站点传输响应超过 1 MiB 限制"),
      );
  };
  const onDecoded = (chunk: Buffer) => {
    if (settled) return;
    info.decodedBytes += chunk.length;
    publish();
    if (info.decodedBytes > MAX_BYTES) {
      finish(
        new QueryFailure("response_too_large", "站点解码响应超过 1 MiB 限制"),
      );
      return;
    }
    chunks.push(chunk);
  };
  const onEnd = () => {
    if (settled) return;
    let text: string;
    try {
      // Fatal UTF-8 validation; TextDecoder also removes a leading UTF-8 BOM.
      text = new TextDecoder("utf-8", { fatal: true }).decode(
        Buffer.concat(chunks),
      );
    } catch {
      finish(
        new QueryFailure(
          "response_text_encoding",
          "站点响应不是有效 UTF-8 文本",
        ),
      );
      return;
    }
    if (!text.trim()) {
      info.bodyKind = "empty";
      finish(
        new QueryFailure(
          "response_empty",
          "站点返回空响应（HTTP 200），没有可解析的 JSON",
        ),
      );
      return;
    }
    // JSON wins over MIME and page-like strings inside a valid JSON value.
    try {
      const data: unknown = JSON.parse(text);
      info.bodyKind = "json";
      finish(undefined, data);
      return;
    } catch {
      /* Classify only after parsing actually failed. */
    }
    const html =
      info.mediaType === "html" ||
      /^\s*(?:<!doctype\s+html\b|<html\b|<head\b|<body\b)/i.test(text);
    if (html) {
      const challenge =
        /\/cdn-cgi\/challenge-platform\b|\b_cf_chl_opt\b|<title[^>]*>\s*Just a moment(?:\.{3}|…)?\s*<\/title>/i.test(
          text,
        );
      info.bodyKind = challenge ? "challenge" : "html";
      finish(
        new QueryFailure(
          challenge ? "response_challenge" : "response_html",
          challenge
            ? "站点返回疑似防护验证页面，尚未收到 JSON"
            : "站点返回 HTML 页面，尚未收到 JSON",
        ),
      );
      return;
    }
    info.bodyKind = "non-json";
    finish(new QueryFailure("invalid_json", "站点返回的内容不是有效 JSON"));
  };
  publish();
  // Track receipt separately from decoder completion (and minimal HTTP mocks).
  res.once("end", () => {
    received = true;
  });
  res.on("error", () =>
    finish(new QueryFailure("read_failed", "站点响应中断")),
  );
  res.on("aborted", () =>
    finish(new QueryFailure("read_failed", "站点响应中断")),
  );
  res.on("close", () => {
    if (!received && !res.complete)
      finish(new QueryFailure("read_failed", "站点响应中断"));
  });
  if (info.encoding === "unsupported") {
    finish(
      new QueryFailure("response_encoding", "站点响应使用不支持的内容编码"),
    );
  } else {
    decoder =
      info.encoding === "gzip"
        ? zlib.createGunzip()
        : info.encoding === "deflate"
          ? zlib.createInflate()
          : info.encoding === "br"
            ? zlib.createBrotliDecompress()
            : undefined;
    res.on("data", onWire);
    const source = decoder || res;
    source.on("data", onDecoded);
    source.once("end", onEnd);
    if (decoder) {
      decoder.on("error", () =>
        finish(new QueryFailure("response_encoding", "站点压缩响应无法解码")),
      );
      decoder.on("close", () =>
        finish(new QueryFailure("response_encoding", "站点压缩响应提前关闭")),
      );
      res.pipe(decoder);
    }
  }
  return {
    promise,
    get received() {
      return received;
    },
    destroy() {
      finish(new QueryFailure("read_failed", "站点响应读取已取消"));
    },
  };
}
