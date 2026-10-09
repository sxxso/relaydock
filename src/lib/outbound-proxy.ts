import http from "node:http";
import https from "node:https";
import tls from "node:tls";
import { isIP, type Socket } from "node:net";
import { type Duplex } from "node:stream";
import { QueryFailure } from "./query-trace";

type Address = { address: string; family: number };
export type QueryProxy = {
  protocol: "http:" | "https:";
  hostname: string;
  port: number;
  authorization?: string;
};

// Only the deployment's explicit variable enables this transport. Never pass a
// credential-bearing URL to http.request (which would create Authorization).
export function parseQueryProxy(input: string | undefined): QueryProxy | null {
  if (input === undefined || input === "") return null;
  try {
    if (
      input.length > 4096 ||
      input.trim() !== input ||
      /[\x00-\x20\x7f\\]/.test(input) ||
      !/^https?:\/\//i.test(input)
    )
      throw new Error();
    const url = new URL(input);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.pathname !== "/" ||
      url.search ||
      url.hash ||
      // Reject even empty query/fragment delimiters and normalized dot paths.
      /[?#]/.test(input) ||
      !/^https?:\/\/[^/]+\/?$/i.test(input)
    )
      throw new Error();
    const username = decodeURIComponent(url.username);
    const password = decodeURIComponent(url.password);
    const port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
    if (
      /[\x00-\x1f\x7f]/.test(username + password) ||
      username.includes(":") ||
      (!username && password) ||
      port < 1
    )
      throw new Error();
    return {
      protocol: url.protocol as QueryProxy["protocol"],
      hostname: url.hostname
        .replace(/^\[|\]$/g, "")
        .toLowerCase()
        .replace(/\.$/, ""),
      port,
      authorization: username
        ? `Basic ${Buffer.from(`${username}:${password}`, "utf8").toString("base64")}`
        : undefined,
    };
  } catch {
    throw new QueryFailure(
      "proxy_config",
      "查询代理配置不正确；只允许显式 HTTP/HTTPS 代理地址和可选 Basic 认证，不接受路径、查询参数或 SOCKS",
    );
  }
}

// A fresh, single-use agent supplies only a CONNECT tunnel to the target GET.
// Both addresses have already been resolved and validated by outbound.ts. No
// target hostname is sent to the proxy for DNS resolution; private proxy access
// is a deployment trust decision, NOT a relaxation of target SSRF validation.
export function createProxyConnection(
  proxy: QueryProxy,
  proxyAddress: Address,
  target: URL,
  targetAddress: Address,
) {
  const secureTarget = target.protocol === "https:";
  const agent = secureTarget
    ? new https.Agent({ keepAlive: false, maxSockets: 1, maxCachedSessions: 0 })
    : new http.Agent({ keepAlive: false, maxSockets: 1 });
  let proxyRequest: http.ClientRequest | undefined;
  let proxySocket: Socket | undefined;
  let targetSocket: Duplex | undefined;
  let started = false,
    destroyed = false,
    established = false;
  let cancel: (() => void) | undefined;
  const proxyFailure = () =>
    new QueryFailure(
      "proxy_failed",
      "无法连接查询代理或建立 CONNECT 隧道；请检查部署代理 DNS、TLS 证书、网络与 CONNECT 端口策略",
    );
  agent.createConnection = (_options, callback) => {
    if (!callback) throw proxyFailure();
    if (started || destroyed) {
      callback(proxyFailure(), undefined as never);
      return;
    }
    started = true;
    let completed = false;
    const complete = (error: QueryFailure | null, socket?: Duplex) => {
      if (completed) return;
      completed = true;
      if (error) {
        proxyRequest?.destroy();
        proxySocket?.destroy();
      }
      callback(error, socket!);
    };
    cancel = () => complete(proxyFailure());
    const authority = `${targetAddress.family === 6 ? `[${targetAddress.address}]` : targetAddress.address}:${target.port || (secureTarget ? 443 : 80)}`;
    const headers: Record<string, string> = { Host: authority };
    if (proxy.authorization)
      headers["Proxy-Authorization"] = proxy.authorization;
    const transport = proxy.protocol === "https:" ? https : http;
    try {
      proxyRequest = transport.request({
        protocol: proxy.protocol,
        hostname: proxy.hostname,
        port: proxy.port,
        method: "CONNECT",
        path: authority,
        headers,
        agent: false,
        maxHeaderSize: 16384,
        // HTTPS proxy TLS verifies the proxy hostname, not its pinned IP.
        rejectUnauthorized: true,
        servername: isIP(proxy.hostname) ? undefined : proxy.hostname,
        lookup: ((_host: unknown, options: unknown, cb: Function) => {
          if ((options as { all?: boolean })?.all) cb(null, [proxyAddress]);
          else cb(null, proxyAddress.address, proxyAddress.family);
        }) as never,
      });
      proxyRequest.on("socket", (socket) => {
        proxySocket = socket;
      });
      proxyRequest.on("error", () => complete(proxyFailure()));
      proxyRequest.on("close", () => {
        if (!established) complete(proxyFailure());
      });
      proxyRequest.on("connect", (response, socket, head) => {
        proxySocket = socket;
        if (destroyed || completed) {
          socket.destroy();
          return;
        }
        if (response.statusCode !== 200 || head.length) {
          socket.destroy();
          complete(
            response.statusCode === 407
              ? new QueryFailure(
                  "proxy_auth",
                  "查询代理认证失败（HTTP 407）；请检查部署代理凭据",
                  407,
                )
              : new QueryFailure(
                  "proxy_failed",
                  "查询代理拒绝或返回无效 CONNECT 隧道；不会跟随代理重定向或直连回退",
                  response.statusCode,
                ),
          );
          return;
        }
        established = true;
        try {
          if (secureTarget) {
            const hostname = target.hostname.replace(/^\[|\]$/g, "");
            // TLS remains end-to-end even over an HTTPS (TLS-in-TLS) proxy.
            // host supplies identity checking for IP literals; DNS names also
            // use original target SNI. No certificate-check bypass is provided.
            targetSocket = tls.connect({
              socket,
              host: hostname,
              servername: isIP(hostname) ? undefined : hostname,
              rejectUnauthorized: true,
              ALPNProtocols: ["http/1.1"],
            });
          } else targetSocket = socket;
          complete(null, targetSocket);
        } catch {
          complete(proxyFailure());
        }
      });
      proxyRequest.end();
    } catch {
      complete(proxyFailure());
    }
    return undefined;
  };
  return {
    agent,
    get established() {
      return established;
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      cancel?.();
      proxyRequest?.destroy();
      targetSocket?.destroy();
      proxySocket?.destroy();
      agent.destroy();
    },
  };
}
