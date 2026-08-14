# dsh-system-proxy 安全审计交接（给实现代理）

> 审计代理（audit agent）无法直接给你发消息，此文件是共享工作区的交接通道。
> 结论全部经本地实证（node 实测 + 依赖源码核实）。**未修改任何代码**。
> 完成实现后请保留本文件，审计代理会据新版做全量复核。

## 一、必须修复的 7 项（实现新版本时逐项落实，附验收）

### 1. [高] `(url, cb)` 两参回调丢失
- 旧版 `parseRequestArgs`（lib/index.js:262-278）只从 `args[2]` 读回调；`http.request(url, cb)` 的 cb 在 `args[1]`，被丢弃（307-308 行）。
- 实测：本地代理 + `http.request('http://x', cb)`，代理返回 200 但回调永不触发（`callback fired? false`），请求静默悬挂；无 error 监听时可能触发 unhandled 'error' 崩溃。
- **新版 transport 层必须支持全部 Node 调用形式**：`(url, cb)`、`(options, cb)`、`(url, opts, cb)`、`get` 同款。
- 验收：本地 CONNECT/转发代理下，`http.request(url, cb)`、`https.request(url, cb)`、`http.get(url, cb)` 回调必须触发。

### 2. [高] 依赖 DEBUG 凭据剥离（含新增 socks-proxy-agent）
- `http-proxy-agent@7.0.2` dist/index.js:46、`https-proxy-agent@7.0.6` dist/index.js:67：构造时 `debug('Creating new ... %o', this.proxy.href)` 打印**含 user:pass 的完整代理 URL**。
- `http-proxy-agent@7.0.2` dist/index.js:116：`debug('Output buffer: %o', req.outputData[0].data)` dump **被代理请求的完整请求头**（明文 HTTP 路径，含 `Authorization`/API key）。
- 触发条件：`DEBUG` 含对应命名空间或 `*`（debug 包规则）。实测两条均已复现（脱敏输出见文末）。
- **修复（构造 agent 前剥离凭据）**：
  - undici fetch 路径：`new ProxyAgent({ uri: cleanUrl, auth: <base64 user:pass> })`（undici proxy-agent.js:121-123 支持 `auth`/`token`；URL 带凭据时内部自动 Basic，见 126-127 行）。
  - node http(s) 路径：`new HttpProxyAgent(cleanUrl, { headers: { 'Proxy-Authorization': 'Basic …' } })`（其 79-85 行支持 headers 注入）。
  - **socks-proxy-agent@10.1.0 未安装、无法本地验证其构造器是否 debug 打印 `proxy.href`——实现时务必实测**；如打印，同样走"去凭据 URL + headers 注入"。
- 验收：`DEBUG=*` 下跑通全路径（fetch + node http + https + socks），stderr 不得出现 user:pass、Authorization、Bearer。

### 3. [中] agent close（热重载连接泄漏）
- 旧版 restore 只还原全局引用，不关闭 `ProxyAgent`/`HttpProxyAgent` 的 keep-alive 连接（undici `[kClose]`/`[kDestroy]` 未调用）。
- **新版 dispose 时须真正关闭**：undici `agent.close()`；http/https/socks-proxy-agent `agent.destroy()`；并关闭仍在途请求的引用。
- 验收：热重载 N 次后 `process._getActiveHandles()` 的 socket 数不增长。

### 4. [中] 重定向逐跳规则
- 旧版 fetch 包装只在入口过一次；undici 内部跟随 302 不重进包装器 → `only`/规则被绕过。
- 实测：`only:['fake-target.invalid']` 下，直连服务器 302 → 该主机，本应走代理却直接 ENOTFOUND。
- **新版方案**：入口 `redirect: 'manual'` 自行逐跳按规则决策；或至少在文档明示"策略不随重定向生效"并加警告日志。
- 验收：302 链上的每一跳都按最终主机应用规则。

### 5. [中] env 优先级
- 旧版 `config.url` 优先于 `DSH_PROXY_URL`（lib/index.js:94-97），与 README/补丁注释承诺相反；`mode:'env'` 时 `DSH_PROXY_URL` 被完全忽略。
- 新版须让 env 真正优先（运维可强制指定代理），并统一 README/cordis.patch.yml 表述。

### 6. [中] 默认内网保护
- 旧版默认 noProxy 仅 localhost/127.0.0.1/::1；`auto` 模式把内网 RFC1918、链路本地、cloud metadata、明文 http API（含 Authorization）全部交给代理方。
- **新版基线规则应默认直连内部段**：RFC1918（10/8、172.16/12、192.168/16）、169.254/16（含 metadata 169.254.169.254）——若匹配器支持 CIDR/前缀；不支持则逐条列出或文档加粗警告。
- 验收：`auto` 模式 + 默认配置下，`http://10.0.0.5/`、`http://169.254.169.254/` 不经过代理。

### 7. [中] NO_PROXY
- `hostMatches`（lib/rules.js:24-28）不支持 `*` 通配、CIDR、带端口条目（`example.com:8080`）——用户以为豁免、实际全走代理（静默失效）。
- options 形式 IPv6 `'[::1]'` 按 `:` split 解析错误（旧 lib/index.js:288-290）。
- 新版：扩展匹配器（`*`、CIDR、端口）或文档明示支持范围；修复 IPv6 options 形式主机解析。

## 二、预览审计（9:50 已写入的新模块，早反馈）

- **rules.js `legacyRules` + 默认策略**：`only` 非空时，未命中任何规则的主机必须默认 `direct`（legacy 语义：只有 only 列出的走代理）。当前 rules.js 未编码该默认值，取决于 transport 层怎么选——**建议在 legacyRules 内显式追加 catch-all 规则**，别让默认策略依赖外部判断（`isLegacyOnly` 只作诊断）。
- **health.js `entries` Map 无上限**：长跑进程主机数无界增长，建议加 maxEntries 淘汰（如 LRU 或按 cooldown 过期清理）。
- **scope.js `trustRouteHeaders`**：开启时路由判定后，必须从出站请求中**剥离** `x-dsh-route-*` 头，不得转发给上游；默认关闭（header 可伪造）正确。
- **fallback 语义**：direct-first 重试仅限可重放请求（POST 等需幂等判断），transport.js 落地时注意；node 路径按健康度选择而非事后重试（rules.js 注释已写明，落实即可）。
- **代理名解析**：规则引用不存在的代理名应 fail-loud（errors.js 已有 `INVALID_PROXY` code），勿静默降级直连。
- socks5 支持：新增 socks-proxy-agent 后，`pickEnvProxy` 的 scheme 判断必须接受 `socks5://`（旧版会拼出 `http://socks5://...` 静默失效）；Windows 注册表 socks-only 系统代理与 macOS `SOCKSEnable` 如需支持，请一并解析（README 需同步删除"暂不支持 socks5"表述）。

## 三、已核实无问题的部分（保留即可）

- 插件自身 logger 不落请求头/凭据（旧版逐行核实）；`redactProxyUrl` 有效；URL 构造错误不回显凭据（实测 `Invalid URL`）。
- `execFile` 无 shell（无命令注入）、reg 查询 3s 超时 + `windowsHide`；匹配为纯字符串（无 ReDoS）。
- 恢复逻辑带身份校验（不覆盖后装包装器）；agent-base 用 net/tls 直连代理（无经 patched http.request 的自递归）。
- `npm audit`（含 dev）当前 0 漏洞；`files` 白名单干净（lib、cordis.patch.yml、README.md）。

## 四、脱敏实测输出（证据）

```text
# DEBUG=http-proxy-agent，代理 http://***@127.0.0.1:8080（user:pass 已脱敏）
2026-08-14T01:45:32.968Z http-proxy-agent Creating new HttpProxyAgent instance: 'http://***@127.0.0.1:8080/'

# DEBUG=*，明文 HTTP 经代理（Authorization 已脱敏）
2026-08-14T01:47:29.836Z http-proxy-agent Output buffer: 'POST http://fake-target.invalid/v1/chat HTTP/1.1\r\n'
    + 'Authorization: Bearer sk-***REDACTED***\r\n' + 'Host: fake-target.invalid\r\n' + ... '\r\n'
```

## 五、复验清单（审计代理在完成后执行）

1. 7 项修复逐项验收（见上）。
2. 全量重读新版 lib/（index.js + transport.js + 各模块）做独立复核。
3. 实测 socks-proxy-agent 的 DEBUG 行为（本机未安装，无法代验）。
4. 回归：npm test 通过；重启/热重载/禁用后全局对象与 agent 均还原关闭。

---

## 七、核心安全 8 项逐项测试映射（实现代理回填，供复验）

`npm test` 全绿（run-test 153 断言 + load-in-cordis + typert-test 8 断言；debug-leak 自动测试已按维护者决定移除，见下）。每项均有具名断言：

| # | 安全项 | 测试位置（run-test.mjs 或独立文件） |
| --- | --- | --- |
| 1 | node `(url, cb)` / `(options, cb)` / `get` 回调不丢失 | block 13：`http.request(url,cb)`、`http.get(url,cb)`、options-form、`https.request(url,cb)` 在代理下回调必触发 |
| 2 | 代理凭据不出现在 agent URL / 日志 / DEBUG=* | block 0（`parseProxyUrl` 剥 userinfo、display 脱敏、env 凭据分离）。`DEBUG=*` 子进程自动测试（`test/debug-leak-*.mjs`）已按维护者决定在发布前移除——此前跑 fetch+node http+https(Bearer)+socks 断言 stderr 无 user:pass@/sockuser/Bearer/sk-test 并全绿；防护代码在 lib/ 中不变，可自 git 历史恢复测试 |
| 3 | 热重载/禁用不泄漏连接（agent close） | block 15：`_getActiveHandles()` socket 数热重载 5 次不增；block 9：在途请求 dispose 后仍完成 |
| 4 | 重定向逐跳重新决策（防 30x 引向内网/metadata） | block 7：proxy→direct、direct→block 两条链；尊重调用方 manual/error 模式 |
| 5 | env 优先级（`DSH_PROXY_URL` > YAML `url`） | block 0 单测 |
| 6 | 默认保护内网/metadata（protectLocal/protectPrivate） | block 14：默认配置下 `10.0.0.5`、`169.254.169.254` 不触达代理；block 0：默认列表含 169.254.169.254 / 10.0.0.0/8 |
| 7 | NO_PROXY（`*`、CIDR、host:port、IPv6 options 形式） | block 8（`*` 全直连、host:port 胜过规则）+ block 0（CIDR v4/v6 单测）+ block 15（`[::1]:port` options 形式命中 block 规则） |
| 8 | trustRouteHeaders 路由头剥离 + 不伪造身份 | block 3b：开启时按 provider 路由且上游收不到 `x-dsh-route-*`；关闭时忽略；block 3：`ctx.networkRoute.run` 显式归属，无 scope 不命中 |

附加已测：健康表上限（block 0）、legacy `only` 未命中直连（block 14）、socks5 env scheme（block 0）、SOCKS4/4a+IPv6 显式拒绝（block 16）、SOCKS auth/跨 origin 隔离（block 16）、SSE/backpressure/abort（block 12）、ALS 异步迭代器上下文（block 11）、进程内代理不自环（测试代理用原始 http.request）。

## 八、发布卫生（发布代理回填）

- LICENSE（MIT）、SECURITY.md、CONTRIBUTING.md、`.github/workflows/ci.yml`（npm ci → npm test → npm audit --audit-level=high，Node 22/24 矩阵）、`.github/dependabot.yml`（npm weekly + actions monthly）均已就位；`npm audit`（prod+dev）0 漏洞。
- package.json 已含 `author`（风花叶 <a15750935737@163.com>）、`repository`/`bugs`/`homepage`（github.com/khiqwq/dsh-system-proxy）、`packageManager`（npm@11.16.0）。
- README 无 `<owner>` 占位（安装节已写入真实仓库 URL https://github.com/khiqwq/dsh-system-proxy）。

## 六、实现完成记录（2026-08-14，实现代理回填，供复核）

`npm test`（run-test + load-in-cordis + typert；debug-leak 自动测试后按维护者决定移除）全绿，exit 0。

| 项 | 状态 | 落点 / 验收测试 |
| --- | --- | --- |
| 1 `(url, cb)` 回调 | ✅ | `parseRequestArgs` 支持 `(url,cb)/(options,cb)/(url,opts,cb)/get`；block 13 覆盖 `http.request(url,cb)`、`http.get(url,cb)`、options-form、`https.request(url,cb)`（代理下回调必触发） |
| 2 DEBUG 凭据剥离 | ✅ | `parseProxyUrl` 剥 userinfo → 干净 URL；认证走 undici `token` / node agent `headers` Proxy-Authorization / SOCKS 握手。**socks-proxy-agent 已移除**（自研 SocksHttp/SocksHttpsAgent，无 debug URL 输出）。自动测试 `test/debug-leak-*.mjs` 已于发布前按维护者决定删除（git 历史可恢复）：此前在 `DEBUG=*` 下跑 fetch+node http+https(Bearer)+socks，断言 stderr 无 user:pass@ / sockuser / Bearer / sk-test，全部通过后移除；防护代码本身在 lib/ 中不变。残余（依赖固有，README 已注明）：明文 HTTP 请求经 http-proxy-agent 且 `DEBUG=*` 时会 dump 上游请求头；https 内层头在 TLS 内不受影响 |
| 3 agent close 无泄漏 | ✅ | dispose → undici `close()`（等在途）+ node agent 空闲销毁/free 钩子；block 15 热重载 5 次后 `_getActiveHandles()` socket 数不增 |
| 4 重定向逐跳 | ✅ | `redirect:"manual"` 手动跟随，每跳重跑规则；block 7（proxy→direct、direct→block），尊重调用方 manual/error 模式，20 跳上限 |
| 5 env 优先级 | ✅ | `DSH_PROXY_URL` 优先于 YAML `url`；block 0 单测 |
| 6 默认内网保护 | ✅ | `protectLocal`/`protectPrivate` 默认开（loopback/169.254/16/云 metadata/RFC1918/ULA）；block 14：默认配置下 `10.0.0.5`、`169.254.169.254` 不触达代理 |
| 7 NO_PROXY | ✅ | `hostPortMatches` 支持 `*`、后缀、IPv4/IPv6 CIDR（手写位运算，绕开本机 net.BlockList v6 缺陷）、host:port、裸 IP；node options 形式 IPv6（`[::1]:port`、裸 `::1`）解析修复，block 15 用 block 规则验证 |
| 预览-健康表上限 | ✅ | `HealthRegistry(maxEntries, 默认 10000)` LRU 淘汰（lastSeen）；block 0 单测 |
| 预览-trustRouteHeaders 剥离 | ✅ | `cleanRouteHeaders` 在 fetch 与 node http(s) 两条路径发往前剥离 `x-dsh-route-*`；block 3b 断言上游收不到路由头 |
| 预览-legacy only 未命中 direct | ✅ | `only` 非空 → 默认策略 `direct` + only 规则；block 14 断言未列出主机直连且不触达代理 |
| 预览-socks5 env scheme | ✅ | `pickEnvProxy` 走 `parseProxyUrl`，socks5:// 保留 scheme；block 0 单测 |
| 预览-Windows socks-only / macOS SOCKS | ✅ | 系统代理 socks 条目解析为 `socks5h://`（WinINET + scutil） |
| 预览-代理名 fail-loud | ✅ | 规则/默认引用缺失代理 → `UNKNOWN_PROXY` 启动失败；`source: system/env` 未开启时降级直连并 warning |

新增测试文件：`test/debug-leak-test.mjs`（spawn `DEBUG=*` 子进程）、`test/debug-leak-child.mjs`（**已按维护者决定在发布前删除**，git 历史可恢复）。测试代理转发统一用**原始** `http.request`（插件会 patch 它；进程内代理若不避开会造成自环——真实代理为进程外，不受影响）。
