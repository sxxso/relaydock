import ipaddr from "ipaddr.js";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import http from "node:http";
import https from "node:https";
import { QueryFailure, type QueryTrace } from "./query-trace";
import { createProxyConnection, parseQueryProxy } from "./outbound-proxy";
import { readResponseBody } from "./outbound-body";
import type { QueryRouteMode } from "./query-routing";
export function isPublicAddress(ip: string) {
  try {
    return ipaddr.process(ip).range() === "unicast";
  } catch {
    return false;
  }
}
export function validateTarget(input: string) {
  let u = new URL(input);
  if (!["https:", "http:"].includes(u.protocol) || u.username || u.password)
    throw new Error("查询地址只允许不带登录信息的 http(s) URL");
  return u;
}
function hostName(host: string) {
  return host
    .replace(/^\[|\]$/g, "")
    .toLowerCase()
    .replace(/\.$/, "");
}
type Address = { address: string; family: number };
export function parseDohAnswer(body: unknown, family: number): Address[] {
  const b = body as {
    Status?: unknown;
    Answer?: { type?: unknown; data?: unknown }[];
  };
  if (
    !b ||
    b.Status !== 0 ||
    (b.Answer !== undefined && !Array.isArray(b.Answer))
  )
    throw new Error("DNS-over-HTTPS 解析失败");
  return (b.Answer || [])
    .filter((a) => a.type === (family === 4 ? 1 : 28))
    .map((a) => {
      if (typeof a.data !== "string" || isIP(a.data) !== family)
        throw new Error("DNS-over-HTTPS 返回非法地址");
      return { address: a.data, family };
    });
}
async function systemLookup(
  host: string,
  deadline: number,
): Promise<Address[]> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      lookup(host, { all: true, verbatim: true }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new QueryFailure(
                "dns_timeout",
                "查询超时（DNS 解析）；请检查部署服务器 DNS",
              ),
            ),
          Math.max(1, deadline - performance.now()),
        );
      }),
    ]);
  } catch (error) {
    if (error instanceof QueryFailure) throw error;
    throw new QueryFailure(
      "dns_failed",
      "DNS 解析失败或超时；请检查部署服务器 DNS，可按部署文档显式选择 DNS-over-HTTPS",
    );
  } finally {
    if (timer) clearTimeout(timer);
  }
}
async function dohLookup(host: string, deadline: number): Promise<Address[]> {
  // Fixed resolver, not an arbitrary imported endpoint. The provider's credential
  // is never passed here. Pin and validate the resolver itself as well.
  const resolver = "cloudflare-dns.com",
    resolved = await systemLookup(resolver, deadline);
  if (!resolved.length)
    throw new QueryFailure(
      "dns_failed",
      "DNS-over-HTTPS 解析器域名没有返回地址",
    );
  try {
    validateResolved(resolver, resolved, []);
  } catch {
    throw new QueryFailure(
      "unsafe_target",
      "DNS-over-HTTPS 解析器解析到禁止地址，已拒绝连接",
    );
  }
  const pinned = resolved.find((a) => a.family === 4) || resolved[0];
  const controller = new AbortController();
  try {
    const answers = await Promise.all(
      [4, 6].map(
        (family) =>
          new Promise<Address[]>((resolve, reject) => {
            const url = new URL("https://cloudflare-dns.com/dns-query");
            url.searchParams.set("name", host);
            url.searchParams.set("type", family === 4 ? "A" : "AAAA");
            let done = false;
            const finish = (error?: Error, value?: Address[]) => {
              if (done) return;
              done = true;
              clearTimeout(timer);
              if (error) reject(error);
              else resolve(value!);
            };
            const req = https.request(
              url,
              {
                method: "GET",
                headers: { Accept: "application/dns-json" },
                agent: false,
                signal: controller.signal,
                lookup: ((
                  _host: unknown,
                  options: unknown,
                  callback: Function,
                ) => {
                  if ((options as { all?: boolean })?.all)
                    callback(null, [pinned]);
                  else callback(null, pinned.address, pinned.family);
                }) as never,
              },
              (res) => {
                if (res.statusCode !== 200) {
                  res.resume();
                  finish(
                    new QueryFailure("dns_failed", "DNS-over-HTTPS 服务不可达"),
                  );
                  req.destroy();
                  return;
                }
                let bytes = 0;
                const chunks: Buffer[] = [];
                res.on("data", (chunk: Buffer) => {
                  bytes += chunk.length;
                  if (bytes > 65536) {
                    finish(
                      new QueryFailure("dns_failed", "DNS-over-HTTPS 响应过大"),
                    );
                    req.destroy();
                    return;
                  }
                  chunks.push(chunk);
                });
                res.on("end", () => {
                  try {
                    finish(
                      undefined,
                      parseDohAnswer(
                        JSON.parse(Buffer.concat(chunks).toString("utf8")),
                        family,
                      ),
                    );
                  } catch {
                    finish(
                      new QueryFailure(
                        "dns_failed",
                        "DNS-over-HTTPS 返回无效解析结果",
                      ),
                    );
                  }
                });
                res.on("error", () =>
                  finish(
                    new QueryFailure("dns_failed", "DNS-over-HTTPS 响应中断"),
                  ),
                );
              },
            );
            const timer = setTimeout(
              () => {
                finish(
                  new QueryFailure(
                    "dns_timeout",
                    "查询超时（DNS-over-HTTPS）；请检查部署网络",
                  ),
                );
                req.destroy();
              },
              Math.max(1, deadline - performance.now()),
            );
            req.on("upgrade", (_res, socket) => {
              finish(
                new QueryFailure(
                  "dns_failed",
                  "DNS-over-HTTPS 返回不支持的协议升级，已拒绝连接",
                ),
              );
              socket.destroy();
              req.destroy();
            });
            req.on("close", () => {
              if (!done) {
                finish(
                  new QueryFailure(
                    "dns_failed",
                    "DNS-over-HTTPS 查询在完成前关闭",
                  ),
                );
                req.destroy();
              } else clearTimeout(timer);
            });
            req.on("error", () =>
              finish(
                new QueryFailure(
                  "dns_failed",
                  "DNS-over-HTTPS 无法连接；本工具不会自动使用系统代理",
                ),
              ),
            );
            req.end();
          }),
      ),
    );
    return answers.flat();
  } finally {
    controller.abort();
  }
}
export function validateResolved(
  host: string,
  addresses: { address: string; family: number }[],
  allow: string[],
) {
  if (!addresses.length) throw new Error("域名解析失败");
  let permitted = allow.map(hostName).includes(hostName(host));
  for (let item of addresses) {
    let range: string, canonical: string;
    try {
      const parsed = ipaddr.process(item.address);
      range = parsed.range();
      canonical = parsed.toString();
    } catch {
      throw new Error("非法网络地址");
    }
    // Metadata endpoints are forbidden even when private sites are allowed.
    // ipaddr.process also normalizes IPv4-mapped IPv6 and expanded IPv6.
    if (canonical === "fd00:ec2::254" || canonical === "100.100.100.200")
      throw new Error("禁止访问云元数据地址");
    if (
      range === "linkLocal" ||
      range === "unspecified" ||
      range === "multicast" ||
      range === "broadcast" ||
      range === "reserved"
    )
      throw new Error("目标为禁止访问的网络地址");
    if (!isPublicAddress(item.address) && !permitted)
      throw new Error("目标解析到私有网络；请通过部署允许列表显式配置");
  }
  return addresses;
}
// Pin the validated DNS answer into the socket lookup; never resolve again on connect.
type JsonRequestOptions = {
  timeoutSeconds?: number; authHeader?: string; trace?: QueryTrace;
  routeMode?: QueryRouteMode; requestProfile?: "atlas" | "cc-switch";
  authMode?: "credential" | "anonymous"; deadline?: number;
};
export function safeJsonRequest(input: string, token: string, userId: string, options: JsonRequestOptions = {}) {
  return jsonRequest(input, token, userId, options, false);
}
// Dedicated internal mutation: a fixed checkin endpoint and empty JSON body.
// No account/client-controlled method or arbitrary request payload is accepted.
export function safeCheckinPostRequest(input: string, token: string, userId: string, options: JsonRequestOptions = {}) {
  const url = validateTarget(input);
  if (!url.pathname.endsWith("/api/user/checkin") || url.search || url.hash || !token || options.authMode === "anonymous")
    throw new QueryFailure("invalid_config", "签到请求配置不正确");
  return jsonRequest(input, token, userId, options, true);
}
async function jsonRequest(
  input: string,
  token: string,
  userId: string,
  options: JsonRequestOptions,
  checkinPost: boolean,
) {
  const seconds = options.timeoutSeconds ?? 10,
    authHeader = options.authHeader ?? "Authorization",
    trace = options.trace,
    requestProfile = options.requestProfile ?? "atlas";
  if (
    ![10, 20, 30].includes(seconds) ||
    !["Authorization", "x-api-key", "api-key"].includes(authHeader) ||
    !["atlas", "cc-switch"].includes(requestProfile) ||
    (options.authMode !== undefined && !["credential", "anonymous"].includes(options.authMode)) ||
    (options.deadline !== undefined && !Number.isFinite(options.deadline)) ||
    (options.routeMode !== undefined &&
      !["direct", "proxy"].includes(options.routeMode))
  )
    throw new QueryFailure("invalid_config", "查询配置不正确");
  if (/\r|\n/.test(token) || /\r|\n/.test(userId))
    throw new QueryFailure("invalid_config", "查询凭据包含非法换行");
  try {
    http.validateHeaderValue(
      authHeader,
      authHeader === "Authorization" ? `Bearer ${token}` : token,
    );
    if (userId) http.validateHeaderValue("New-Api-User", userId);
  } catch {
    throw new QueryFailure(
      "invalid_config",
      "查询凭据包含 HTTP 请求头不支持的字符，请检查复制内容",
    );
  }
  let url: URL;
  try {
    url = validateTarget(input);
  } catch {
    throw new QueryFailure(
      "invalid_config",
      "查询地址只允许不带登录信息的 http(s) URL",
    );
  }
  let host = hostName(url.hostname),
    allow = (process.env.RELAYDOCK_PRIVATE_HOSTS || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  let deadline = Math.min(options.deadline ?? Infinity, performance.now() + seconds * 1000);
  const checkDeadline = () => {
    if (performance.now() >= deadline)
      throw new QueryFailure("response_timeout", "只读查询已耗尽总时限，请稍后手动重试");
  };
  checkDeadline();
  // Capture once per request; never change process.env to switch concurrent queries.
  const proxy =
    options.routeMode === "direct"
      ? null
      : parseQueryProxy(process.env.RELAYDOCK_QUERY_PROXY_URL);
  if (options.routeMode === "proxy" && !proxy)
    throw new QueryFailure("proxy_config", "所选代理线路尚未配置查询代理");
  let proxyPinned: Address | undefined;
  let addresses: { address: string; family: number }[];
  const dnsMode = process.env.RELAYDOCK_DNS_MODE || "system";
  if (!["system", "cloudflare"].includes(dnsMode))
    throw new QueryFailure(
      "invalid_config",
      "DNS 解析配置不正确，请选择 system 或 cloudflare",
    );
  if (isIP(host)) {
    if (proxy && !isIP(proxy.hostname)) trace?.begin("dns");
    else trace?.skip("dns");
    addresses = [{ address: host, family: isIP(host) }];
  } else {
    trace?.begin("dns");
    addresses =
      dnsMode === "cloudflare"
        ? await dohLookup(host, deadline)
        : await systemLookup(host, deadline);
  }
  try {
    if (!addresses.length)
      throw new QueryFailure(
        "dns_failed",
        "域名解析没有返回地址，请检查部署服务器 DNS",
      );
    validateResolved(host, addresses, allow);
  } catch (error) {
    if (error instanceof QueryFailure) throw error;
    throw new QueryFailure(
      "unsafe_target",
      "目标解析到私有或禁止访问的网络；请检查部署允许列表（云元数据始终禁止）",
    );
  }
  if (proxy) {
    let resolved: Address[];
    try {
      resolved = isIP(proxy.hostname)
        ? [{ address: proxy.hostname, family: isIP(proxy.hostname) }]
        : await systemLookup(proxy.hostname, deadline);
      if (!resolved.length)
        throw new QueryFailure(
          "proxy_failed",
          "查询代理域名没有返回地址；请检查部署代理 DNS",
        );
    } catch (error) {
      throw new QueryFailure(
        error instanceof QueryFailure && error.code === "dns_timeout"
          ? "proxy_timeout"
          : "proxy_failed",
        error instanceof QueryFailure && error.code === "dns_timeout"
          ? "查询代理 DNS 解析超时；已耗尽查询总时限"
          : "查询代理 DNS 解析失败；请检查部署代理配置与 DNS",
      );
    }
    try {
      // Explicit configuration permits private proxy IPs, but does not permit
      // metadata/link-local/unspecified/multicast/reserved endpoints.
      validateResolved(proxy.hostname, resolved, [proxy.hostname]);
    } catch {
      throw new QueryFailure(
        "proxy_config",
        "查询代理解析到禁止访问的网络地址；元数据、未指定及组播地址始终禁止",
      );
    }
    proxyPinned = resolved.find((a) => a.family === 4) || resolved[0];
  }
  trace?.end();
  checkDeadline();
  // Prefer IPv4 when both were validated. No second request or retry is made.
  let pinned = addresses.find((a) => a.family === 4) || addresses[0];
  trace?.begin("connect");
  const proxyConnection = proxy
    ? createProxyConnection(proxy, proxyPinned!, url, pinned)
    : undefined;
  return await new Promise<unknown>((resolve, reject) => {
    let done = false,
      timer: ReturnType<typeof setTimeout> | undefined;
    let response: http.IncomingMessage | undefined,
      bodyReader: ReturnType<typeof readResponseBody> | undefined,
      req: http.ClientRequest;
    const fail = (error: Error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      bodyReader?.destroy();
      response?.destroy?.();
      proxyConnection?.destroy();
      req?.destroy();
      reject(error);
    };
    let headers: Record<string, string> = {
      Accept: requestProfile === "cc-switch" ? "*/*" : "application/json",
      "Accept-Encoding": "gzip, deflate, br",
      "Content-Type": "application/json",
      "User-Agent":
        requestProfile === "cc-switch"
          ? "cc-switch/1.0"
          : "RelayDock-Atlas/1.0",
    };
    if (options.authMode !== "anonymous") {
      headers[authHeader] = authHeader === "Authorization" ? `Bearer ${token}` : token;
      if (userId) headers["New-Api-User"] = userId;
    }
    let transport = url.protocol === "https:" ? https : http;
    let phase: "建立连接" | "等待响应" | "读取响应" = "建立连接";
    req = transport.request(
      url,
      {
        method: checkinPost ? "POST" : "GET",
        headers,
        agent: proxyConnection?.agent ?? false,
        lookup: ((_hostname: unknown, options: unknown, callback: Function) => {
          if ((options as { all?: boolean })?.all) callback(null, [pinned]);
          else callback(null, pinned.address, pinned.family);
        }) as never,
      },
      (res) => {
        response = res;
        if (done) {
          res.destroy();
          return;
        }
        trace?.status(res.statusCode);
        if (res.statusCode !== 200) {
          res.resume();
          fail(
            new QueryFailure(
              res.statusCode === 401 || res.statusCode === 403
                ? "http_auth"
                : res.statusCode === 429
                  ? "http_limited"
                  : res.statusCode &&
                      res.statusCode >= 300 &&
                      res.statusCode < 400
                    ? "http_redirect"
                    : res.statusCode === 404
                      ? "http_missing"
                      : "http_error",
              res.statusCode === 401 || res.statusCode === 403
                ? "令牌无效或缺少查询权限（HTTP 401/403）；New API 账户查询需管理令牌和正确用户 ID，OpenRouter 需 Management Key"
                : res.statusCode === 429
                  ? "站点请求限流，请稍后手动重试"
                  : res.statusCode &&
                      res.statusCode >= 300 &&
                      res.statusCode < 400
                    ? "站点返回重定向，已拒绝跟随；请填写最终管理接口地址"
                    : res.statusCode === 404
                      ? "余额接口不存在（HTTP 404）；请检查平台模板与接口根地址；兼容站点可能未开放此接口"
                      : `站点查询失败（HTTP ${res.statusCode}）`,
              res.statusCode,
            ),
          );
          req.destroy();
          return;
        }
        phase = "读取响应";
        trace?.begin("read");
        bodyReader = readResponseBody(res, (info) => trace?.response(info));
        bodyReader.promise.then((data) => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          trace?.end();
          proxyConnection?.destroy();
          resolve(data);
        }, fail);
      },
    );
    req.on("socket", (socket) => {
      if (proxyConnection && url.protocol === "http:") {
        // CONNECT has already connected this HTTP socket before Agent delivery.
        if (!done) {
          phase = "等待响应";
          trace?.begin("response");
        }
        return;
      }
      socket.once(
        url.protocol === "https:" ? "secureConnect" : "connect",
        () => {
          if (done) return;
          phase = "等待响应";
          trace?.begin("response");
        },
      );
    });
    req.on("upgrade", (res, socket) => {
      // An origin 101 transfers socket ownership instead of invoking the JSON
      // response callback. Never leave that socket or the query promise alive.
      if (!done) {
        trace?.status(res.statusCode);
        fail(
          new QueryFailure(
            "http_error",
            "站点返回不支持的协议升级，已拒绝连接",
            res.statusCode,
          ),
        );
      }
      socket.destroy();
      req.destroy();
    });
    timer = setTimeout(
      () => {
        fail(
          new QueryFailure(
            proxyConnection && !proxyConnection.established
              ? "proxy_timeout"
              : phase === "建立连接"
                ? "connect_timeout"
                : phase === "等待响应"
                  ? "response_timeout"
                  : "read_timeout",
            proxyConnection && !proxyConnection.established
              ? "查询代理连接或 CONNECT 隧道建立超时；已耗尽查询总时限，余额未改变"
              : `查询超时（${phase} / ${seconds} 秒），余额未改变；可在查询配置中设为 20 或 30 秒。若仍超时，请检查部署网络、接口根地址及站点防火墙`,
          ),
        );
        req.destroy();
      },
      Math.max(1, deadline - performance.now()),
    );
    req.on("close", () => {
      // Close is not proof of success: an error/aborted/end event is not
      // guaranteed. Settle unfinished work before removing its deadline.
      if (!done) {
        // HTTP may finish before zlib drains. Keep the ORIGINAL deadline alive
        // until decoding settles, rather than misclassifying a complete body.
        if (
          phase === "读取响应" &&
          (response?.complete || bodyReader?.received)
        )
          return;
        fail(
          new QueryFailure(
            proxyConnection && !proxyConnection.established
              ? "proxy_failed"
              : phase === "读取响应"
                ? "read_failed"
                : phase === "等待响应"
                  ? "response_failed"
                  : "connect_failed",
            proxyConnection && !proxyConnection.established
              ? "查询代理连接或 CONNECT 隧道提前关闭；不会重试或回退直连"
              : phase === "读取响应"
                ? "站点响应中断"
                : "站点连接在查询完成前关闭；请检查部署网络与站点服务",
          ),
        );
        req.destroy();
      } else clearTimeout(timer);
    });
    req.on("error", (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      if (error instanceof QueryFailure) {
        fail(error);
        return;
      }
      fail(
        new QueryFailure(
          error.code?.includes("CERT") ||
            error.code === "DEPTH_ZERO_SELF_SIGNED_CERT"
            ? "tls_error"
            : phase === "读取响应"
              ? "read_failed"
              : phase === "等待响应"
                ? "response_failed"
                : "connect_failed",
          error.code?.includes("CERT") ||
            error.code === "DEPTH_ZERO_SELF_SIGNED_CERT"
            ? "站点 TLS 证书验证失败；不会跳过证书检查"
            : `无法连接站点（${phase}）；请检查部署服务器到站点的网络与端口`,
        ),
      );
    });
    req.end(checkinPost ? "{}" : undefined);
  });
}
