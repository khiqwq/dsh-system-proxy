# dsh-system-proxy

DeepSeek Harness（DSH）的出站网络路由插件。它在 DSH 主进程中统一接管 `fetch` 与可选的 `node:http` / `node:https` 请求，根据目标主机及显式调用上下文，在直连、HTTP(S) 代理和 SOCKS4/4a/5/5h 代理之间选择线路；支持直连优先的故障回退、逐跳重定向重新决策、每主机健康记忆，以及内网/云元数据端点的默认保护。

> 当前版本已实现下述全部能力并通过 `npm test`（81 项断言 + 真实 Cordis loader 挂载/热重载验证）。

## 目标能力

- HTTP、HTTPS、SOCKS4、SOCKS4a、SOCKS5、SOCKS5h 代理；
- 多个具名代理（named proxies）；
- 按 `host`、`provider`、`plugin` 路由；
- `direct`、`proxy`、`fallback`、`block` 四种动作；
- 直连失败或延迟过高时使用代理保底；
- 每目标 EWMA 延迟、失败冷却（cooldown）与健康记忆；
- 显式 provider/plugin 上下文，不伪造调用方身份；
- 代理凭据脱敏、安全日志和热重载恢复。

## 工作原理

插件加载后：

1. 包装 `globalThis.fetch`，按规则选择直连或代理 dispatcher；
2. `patchNodeHttp: true` 时包装 `node:http` / `node:https` 的 `request` 与 `get`；
3. 用 `AsyncLocalStorage` 传递显式 `provider` / `plugin` 信息；
4. 为 fallback 目标保存直连 EWMA 延迟及失败冷却；
5. 插件销毁或热重载时还原自己安装的包装器，并关闭代理 Agent。

这是**进程级全局补丁**。同一进程内不应同时加载多个相互竞争的传输包装插件；本插件在还原时只恢复仍指向自身包装器的全局对象，不覆盖后来安装的包装器。

## 安装

源码仓库：<https://github.com/khiqwq/dsh-system-proxy>

从源码安装：

```powershell
git clone https://github.com/khiqwq/dsh-system-proxy.git
cd dsh-system-proxy
npm install
npm test

cd "$env:DSH_HOME\profiles\<name>"
npm install <dsh-system-proxy 源码目录的绝对路径>
# 将 "dsh-system-proxy" 加入 package.json 的 dsh.profile.bundles
```

发布后可使用：

```powershell
dsh plugin --profile <name> add dsh-system-proxy
```

本包声明了 `dsh.bundle.patch`，安装为 DSH profile bundle 后会提供 `system-proxy` loader entry。

## 配置

配置位于 profile 的 `cordis.patch.yml`。以下示例与当前 package schema 一致：`proxies` 是对象，`rules` 是**数组**，默认策略位于 `default` 对象中。

```yaml
- id: system-proxy
  config:
    enabled: true
    mode: auto                 # auto | env | system | manual
    url: ''                    # 旧配置兼容：隐式 default 代理
    patchNodeHttp: true
    protectPrivate: true         # 默认直连私网、链路本地和 metadata
    healthMaxEntries: 10000      # 每主机健康表上限（LRU 淘汰）

    noProxy:
      - localhost
      - '127.0.0.1'
      - '::1'
      - api.deepseek.com
    only: []                   # 旧配置兼容：非空时只代理这里的主机

    proxies:
      clash-http: http://127.0.0.1:7890
      v2ray-socks: socks5h://127.0.0.1:10808
      legacy-socks: socks4a://127.0.0.1:1080
      os-proxy: { source: system }
      # 也可把 username/password 作为对象字段配置；password 按 secret 展示
      # authenticated: { url: http://proxy.example:8080, username: user, password: secret }

    rules:
      - host: [api.deepseek.com]
        action: direct
      - host: [api.openai.com]
        provider: [openai]
        action: proxy
        proxy: v2ray-socks
      - plugin: [some-unreachable-plugin]
        action: fallback
        proxy: clash-http
        directTimeoutMs: 2000
      - host: [api.blocked.example]
        action: block

    default:
      strategy: fallback       # direct | proxy | fallback
      proxy: clash-http
      directTimeoutMs: 3000
      latencyThresholdMs: 1500
      cooldownMs: 60000
      methods: [GET, HEAD, OPTIONS, TRACE]

    trustRouteHeaders: false
    routeHeaderPrefix: x-dsh-route
```

### Loader 配置是整体替换

Cordis loader 只在 EntryOptions 顶层合并。`config` 一旦出现在后续 patch 中，就会**整体替换**原 config；`rules` 或 `proxies` 使用数组/对象不会产生跨层深合并。

因此，在 profile patch 中增加一条规则时，必须重述要保留的完整 `config`，包括全部 `proxies`、`rules`、`default` 和兼容键。只写增量字段会丢失其他配置。

## 代理来源和环境变量

| `mode` | 来源 |
| --- | --- |
| `auto` | 代理环境变量 → OS 系统代理 → 显式 `url` |
| `env` | `HTTPS_PROXY` / `HTTP_PROXY` / `ALL_PROXY`（含小写） |
| `system` | Windows WinINET / macOS `scutil` |
| `manual` | 仅显式 `url` |

专用环境变量：

- `DSH_PROXY_URL`：运维级代理 URL 覆盖；
- `DSH_PROXY_MODE`：覆盖 `mode`；
- `DSH_PROXY_DISABLE`：任意非空值禁用插件；
- `NO_PROXY` / `no_proxy`：追加直连规则。

显式 URL 支持 `http://`、`https://`、`socks4://`、`socks4a://`、`socks5://`、`socks5h://`（SOCKS 默认端口 1080；`socks4a` 与 `socks5h` 由代理端解析域名，`socks4` 与 `socks5` 本地解析）。

### SOCKS 实现说明（fetch 路径）

fetch 路径对**所有** socks 协议统一使用**自定义无状态 connector + undici `Agent`**（connector 模式借鉴 [@undicijs/proxy](https://jsr.io/@undicijs/proxy) 的 `buildSocksProxyConnector`，MIT，已在 `lib/socks.js` 顶部署名）：

- 每个连接都是独立的 SOCKS 握手（无状态，无跨请求隧道复用）；undici `Agent` 按 origin 池隔离——**闭合了 GHSA-hm92-r4w5-c3mj 那类 socks 隧道跨 origin 复用串线问题**（不使用 undici 内置 Socks5ProxyAgent）。
- **HTTPS 目标**：SOCKS 建连后把原始 socket 以 `httpSocket` 交给 undici 自己的 `buildConnector` 完成 TLS（ALPN/会话复用与 undici 一致）；**HTTP 目标**直接返回原始 socket。
- **SOCKS4/4a + IPv6 目标**（协议限制）在握手前显式抛错 `SOCKS4_IPV6_UNSUPPORTED`，绝不静默直连。
- 认证凭据通过 SOCKS 握手（`userId`/`password`）传递，可来自 URL `user:pass@` 或 `username`/`password` 字段；密码错误会明确失败。
- node `http(s)` 路径由 `SocksHttpAgent`/`SocksHttpsAgent`（同一隧道原语）覆盖。

## 规则语义

规则按数组顺序匹配，首条命中的规则生效：

- **任一指定字段命中即命中**（字段之间是 OR，字段数组内部也是 OR）。想表达 AND，就把需要同时满足的条件拆成"先命中则生效"的先后规则，或用 `host:port` 等更精确的模式缩小范围。

例如 provider 为 `openai`，或 host 为两个候选之一，都命中这条规则：

```yaml
- host: [api.openai.com, gateway.example.com]
  provider: [openai]
  action: proxy
  proxy: v2ray-socks
```

| 动作 | 含义 |
| --- | --- |
| `direct` | 只直连，不使用代理 |
| `proxy` | 强制使用指定具名代理 |
| `fallback` | 先直连；满足安全条件时在连接前失败或健康记忆触发后改用代理 |
| `block` | 本地拒绝请求（`NETWORK_BLOCKED`） |

引用不存在的代理名会在启动时 fail loud（`UNKNOWN_PROXY`）；`source: system|env` 的代理在当前未开启时会跳过并在运行期以 warning 降级为直连。

## Provider / plugin 上下文

全局 fetch 只能可靠看到目标 URL，无法自动判断任意请求来自哪个 Cordis 插件。调用方必须显式使用插件服务：

```js
await ctx.networkRoute.run(
  { provider: 'openai', plugin: 'my-plugin' },
  () => fetch('https://api.openai.com/v1/models'),
)
```

**流式响应（SSE）的归属**：`als.run(meta, () => iterable)` 不会让后续迭代保留上下文——`next()` 在调用方自己的异步上下文里执行，`currentRoute()` 会丢。对惰性消费的流，用 `ctx.networkRoute.iterable(route, stream)` 包装：`next` / `return` / `throw` 每次都会在 `als.run(route, ...)` 内调用，`abort`（`return`）与异常（`throw`）同样保留归属：

```js
const attributed = ctx.networkRoute.iterable(
  { provider: 'openai' },
  response.body, // 或任意 async iterable（含 llm/stream 适配器的异步迭代器）
)
for await (const chunk of attributed) { /* currentRoute() 可见 */ }
```

DSH `llm/stream` 集成应包装异步迭代器的 `next` / `return` / `throw` 生命周期，使惰性 SSE 消费期间仍保留 provider/model 上下文。

`trustRouteHeaders` 默认关闭。若开启，可读取 `x-dsh-route-provider` 与 `x-dsh-route-plugin`；这些内部路由头在策略判定后、**发出请求前会被自动剥离**，不会发给 API 上游（fetch 与 node http(s) 两条路径都已处理）。

## Fallback 安全模型

自动回退不是普通重试。为避免重复创建 LLM 请求或重复计费：

- 默认只允许 `GET`、`HEAD`、`OPTIONS`、`TRACE` 自动换路；
- `POST` 默认不重放；
- 流式上传、FormData 和超出缓冲上限的 body 不重放；
- 用户主动 abort 不重试；
- 收到响应头或 SSE 字节后不重试；
- 只有能够证明请求字节尚未写出的连接前失败才安全换路；
- `onConnect` 已发生后的 socket 错误属于不确定状态，默认不重试。

延迟阈值使用到响应头的观测值记录 EWMA；连接失败进入有上限的 cooldown。主动健康探测默认关闭，避免插件启动时自行访问外网。

## NO_PROXY 与内网安全

安全默认（`protectLocal` / `protectPrivate`，均可关闭）让 localhost、loopback、`169.254.0.0/16`、云 metadata 端点、RFC1918 内网和 IPv6 ULA（`fc00::/7`、`fe80::/10`）一律直连，所以"全部走代理"的配置也不会把内网/metadata 流量交给外部代理。

`noProxy` 与 `NO_PROXY` / `no_proxy` 支持：

- `*`：全部直连；
- `example.com` / `.example.com` / `*.example.com`：精确或后缀；
- `10.0.0.0/8`、`fc00::/7`：IPv4/IPv6 CIDR；
- `127.0.0.1:8080`、`example.com:443`：host:port（端口必须一致才命中）；
- 裸 IP。

不要把内网、metadata 或带明文凭据的 HTTP API 交给不受信任的代理。

## 凭据与日志安全

代理 URL 可以包含凭据，但日志只能显示 `http://***@proxy.example:8080`。插件不得记录 API `Authorization`、请求 body 或代理密码。

实现上，URL 里的凭据（或 `username`/`password` 字段）会在解析时**剥离**：交给 undici ProxyAgent / http(s)-proxy-agent 的 URL 不再含用户信息，认证改由 `Proxy-Authorization`（undici `token`、node agent `headers` 选项）或 SOCKS 握手（`userId`/`password`）注入。SOCKS 路径使用插件自研 agent，不做任何 URL 调试输出。`npm test` 含 `DEBUG=*` 泄漏测试：stderr 不得出现代理凭据、URL 形式或上游 Bearer token。

> 残余（依赖固有）：**明文 HTTP** 请求经 `http-proxy-agent` 且进程开启 `DEBUG=*` 时，依赖会把该请求的完整请求头（含上游 `Authorization`）dump 到 stderr；https 请求的内层头在 TLS 内不受影响。仍建议不要在包含真实 key 的生产进程里开启通配 `DEBUG=*`。

## 重定向安全

路由策略对重定向链的**每一跳重新计算**（`redirect: "manual"` + 手动跟随）：代理请求被 30x 引向内网或 metadata 地址时，下一跳会按规则命中 `direct`/`block`，不会继续走外部代理。调用方显式请求 `redirect: "manual"` 时原样返回 3xx；`redirect: "error"` 时抛出。默认最多跟随 20 跳。

## 可观测性（无裸 /status）

插件不暴露任何裸 HTTP 状态端点。状态通过两个受控表面提供，返回的都是**纯 JSON、只含脱敏信息**（代理 URL 用 `***` 掩码、健康表按上限采样、无凭据/请求数据/句柄）：

- **Cordis Service `systemProxyStatus`**（总是可用）：其他宿主插件可 `ctx.get("systemProxyStatus").status()`。
- **Typert Remote**（部署挂载 typert 时自动生效）：严格手写 manifest（无装饰器），namespace `systemProxyStatus` / method `status`，由 DSH 的 typert 网关作为 Remote 服务。manifest 的 disposer 绑定在插件自身的 fiber 上——热重载时先撤销旧注册再注册，避免重复端点。

```jsonc
{
  "plugin": "dsh-system-proxy",
  "version": "0.2.0",
  "enabled": true,
  "patchNodeHttp": true,
  "proxies": [{ "name": "default", "scheme": "http", "url": "http://***@127.0.0.1:7890" }],
  "strategy": "fallback",
  "fallback": { "directTimeoutMs": 3000, "latencyThresholdMs": 1500, "cooldownMs": 60000, "methods": ["GET","HEAD","OPTIONS","TRACE"] },
  "health": { "api.openai.com": { "ewmaMs": 820.4, "proxyEwmaMs": null, "failures": 0, "coolingDown": false } }
}
```

## 当前限制

- SOCKS4/4a 无法寻址 IPv6 目标（协议限制），此类组合会明确报错，绝不静默直连。
- `fallback` 的"延迟阈值"基于到响应头的观测 EWMA 决定**后续请求**选路；不会在 SSE 已开始后中断线路。
- 主动健康探测默认关闭（避免启动时自行访问外网）；每主机健康表默认上限 10000 条（`healthMaxEntries` 可调，LRU 淘汰）。
- 同一进程内不应同时加载多个相互竞争的传输包装插件。
- 明文 HTTP 请求 + `DEBUG=*` 时，http-proxy-agent 依赖会 dump 上游请求头（见"凭据与日志安全"）。

## 测试

```powershell
npm install
npm test
```

覆盖：规则/配置/健康单元测试（含 CIDR、`*`、host:port、IPv6、健康表上限）、旧版兼容、多代理路由、provider 作用域、路由头剥离、block、fallback 安全重放（GET 重放 / POST 不重放）、socks4/4a/5/5h 在 fetch 与 node http 双路径（含 DNS 语义与 SSE/backpressure/abort）、逐跳重定向、内网与 metadata 默认保护、node `(url,cb)/(options,cb)/get` 全调用形式、热重载无连接泄漏、dispose 不打断在途请求、ALS 异步迭代器上下文、真实 Cordis loader 挂载与热重载、`DEBUG=*` 凭据泄漏测试。测试使用本地直连服务器、HTTP CONNECT 代理和 SOCKS 测试服务，不需要访问外部 API。

## 社区参考

以下项目已核验真实存在，但解决的是观测、诊断、端点修复或模型层 fallback，不等同于本插件的传输层网络路由：

- [liaohch3/claude-tap](https://github.com/liaohch3/claude-tap)
- [TYEclipse/dsh-netdoctor](https://github.com/TYEclipse/dsh-netdoctor)
- [kanghelyu/dsh-search-endpoint-guard](https://github.com/kanghelyu/dsh-search-endpoint-guard)
- [btspoony/dsh-llm-fallbacks](https://github.com/btspoony/dsh-llm-fallbacks)

不引用无法公开验证的 `dsh-external/*` 地址。

## License

MIT
