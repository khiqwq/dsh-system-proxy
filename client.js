window.__ModuleLoader__.load({
  id: "dsh-system-proxy",
  factory: (require) => {
    const module = { exports: {} };
    const exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    const React = require("react");
    const { createElement: h, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } = React;
    const NAMESPACE = "system-proxy";
    const DEFAULT_PASSWORD_REF = "DSH_PROXY_PASSWORD";
    const FIELDS = ["enabled", "mode", "url", "passwordRef", "patchNodeHttp", "protectPrivate"];
    const REF_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
    const zh = {
      title: "系统代理",
      description: "配置主机出站代理与凭据",
      loading: "正在读取 system-proxy 设置…",
      expand: "展开",
      collapse: "收起",
      unsaved: "未保存",
      enabled: "启用系统代理",
      mode: "代理来源模式",
      modeAuto: "自动按顺序查找：环境变量 → 操作系统代理 → 下方代理 URL；使用第一个可用项。",
      modeEnv: "仅使用 HTTPS_PROXY、HTTP_PROXY 或 ALL_PROXY 环境变量；下方代理 URL 不生效。",
      modeSystem: "仅读取操作系统代理：Windows WinINET 或 macOS scutil；下方代理 URL 不生效。",
      modeManual: "仅使用下方填写的代理 URL，不读取环境变量或操作系统代理。",
      proxyUrl: "代理 URL",
      passwordRef: "passwordRef",
      proxyPassword: "代理密码",
      passwordPlaceholder: "留空则保留现有密码",
      credentialChecking: "正在检查凭据…",
      credentialConfigured: "已配置",
      credentialMissing: "未配置",
      credentialWriteOnly: "只写；页面不会回显原文",
      patchNodeHttp: "接管 node:http / node:https",
      protectPrivate: "保护私有网络",
      readOnly: "当前连接中的设置为只读。",
      discard: "放弃更改",
      save: "保存并加密",
      saving: "保存中…",
      saved: "已保存。密码已加密，页面不会回显原文。",
      errorPasswordRef: "passwordRef 必须是环境变量格式的标识符（例如 DSH_PROXY_PASSWORD）。",
      errorUserinfo: "代理 URL 不得包含 userinfo（用户名或密码）；请改用 passwordRef 凭据。",
      errorCredentialReadOnly: "此凭据当前为只读，无法保存密码。",
      credentialLookupFailed: "凭据查询失败。",
      credentialSaveFailed: "凭据保存失败。"
    };
    const en = {
      title: "System Proxy",
      description: "Configure Host outbound proxy routing and credentials",
      loading: "Loading system-proxy settings…",
      expand: "Expand",
      collapse: "Collapse",
      unsaved: "Unsaved",
      enabled: "Enable system proxy",
      mode: "Proxy source mode",
      modeAuto: "Try in order: environment variables → OS proxy → Proxy URL below; use the first available source.",
      modeEnv: "Use only HTTPS_PROXY, HTTP_PROXY, or ALL_PROXY environment variables; the Proxy URL below is ignored.",
      modeSystem: "Use only the OS proxy (Windows WinINET or macOS scutil); the Proxy URL below is ignored.",
      modeManual: "Use only the Proxy URL below; ignore environment variables and the OS proxy.",
      proxyUrl: "Proxy URL",
      passwordRef: "passwordRef",
      proxyPassword: "Proxy password",
      passwordPlaceholder: "Leave blank to keep the current password",
      credentialChecking: "Checking credential…",
      credentialConfigured: "Configured",
      credentialMissing: "Not configured",
      credentialWriteOnly: "Write-only; the original value is never displayed",
      patchNodeHttp: "Patch node:http / node:https",
      protectPrivate: "Protect private networks",
      readOnly: "Settings are read-only in this connection.",
      discard: "Discard changes",
      save: "Save and encrypt",
      saving: "Saving…",
      saved: "Saved. The password is encrypted and never displayed.",
      errorPasswordRef: "passwordRef must be an environment-variable identifier (for example DSH_PROXY_PASSWORD).",
      errorUserinfo: "Proxy URL must not contain userinfo (username or password); use a passwordRef credential instead.",
      errorCredentialReadOnly: "This credential is read-only and its password cannot be saved.",
      credentialLookupFailed: "Credential lookup failed.",
      credentialSaveFailed: "Credential save failed."
    };
    const css = ".dsp-card{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);border-radius:12px;list-style:none;color:var(--dsw-alias-label-primary);transition:border-color .16s,background .16s}.dsp-card:hover{border-color:var(--dsw-alias-label-dimmed)}.dsp-card[data-open=true]{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-label-dimmed)}.dsp-header{appearance:none;width:100%;font:inherit;color:inherit;text-align:left;cursor:pointer;background:transparent;border:0;border-radius:12px;display:flex;align-items:center;gap:12px;padding:14px 16px}.dsp-header:focus-visible,.dsp-control:focus-visible,.dsp-button:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}.dsp-head{display:flex;flex:1;min-width:0;flex-direction:column;gap:4px}.dsp-title{font-size:15px;font-weight:600;line-height:1.4}.dsp-description{color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:1.5}.dsp-chevron{color:var(--dsw-alias-label-tertiary);font-size:14px;transition:transform .16s}.dsp-card[data-open=true] .dsp-chevron{transform:rotate(180deg)}.dsp-badge{white-space:nowrap;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary);border-radius:999px;padding:1px 8px;font-size:11px;font-weight:500;line-height:17px}.dsp-body{border-top:1px solid var(--dsw-alias-border-l2);margin:0 16px;padding:12px 0 8px}.dsp-grid{display:grid;grid-template-columns:minmax(150px,1fr) minmax(190px,1.7fr);gap:9px 14px;align-items:center}.dsp-label{color:var(--dsw-alias-label-secondary);font-size:13px}.dsp-hint{margin:5px 2px 0;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:1.45}.dsp-control{box-sizing:border-box;width:100%;min-height:32px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:5px 9px;font:inherit;font-size:13px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-3);transition:border-color .16s,background .16s}.dsp-control:hover:not(:disabled){border-color:var(--dsw-alias-label-dimmed)}.dsp-check{justify-self:start;accent-color:var(--dsw-alias-brand-primary)}.dsp-status{grid-column:2;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:1.5;margin:-4px 0 2px}.dsp-readonly,.dsp-message{font-size:12px;line-height:1.5;margin:10px 0 0}.dsp-readonly{color:var(--dsw-alias-label-tertiary)}.dsp-message{color:var(--dsw-alias-label-error);flex:1}.dsp-message[data-kind=success]{color:var(--dsw-alias-label-success,var(--dsw-alias-label-secondary))}.dsp-footer{border-top:1px solid var(--dsw-alias-border-l2);display:flex;justify-content:flex-end;align-items:center;gap:8px;margin-top:12px;padding:12px 0 4px}.dsp-button{appearance:none;font:inherit;cursor:pointer;border:1px solid transparent;border-radius:8px;padding:5px 14px;font-size:13px;line-height:1.5}.dsp-secondary{border-color:var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);background:transparent}.dsp-secondary:hover:not(:disabled){background:var(--dsw-alias-bg-layer-3)}.dsp-primary{background:var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-on-brand,#fff)}.dsp-primary:hover:not(:disabled){background:var(--dsw-alias-brand-hover,var(--dsw-alias-brand-primary))}.dsp-button:disabled,.dsp-control:disabled{cursor:not-allowed;opacity:.5}@media(max-width:620px){.dsp-grid{grid-template-columns:1fr}.dsp-status{grid-column:1}.dsp-footer{flex-wrap:wrap}}";
    if (typeof document !== "undefined" && !document.querySelector('style[data-plugin-css="dsh-system-proxy/client"]')) {
      const tag = document.createElement("style");
      tag.dataset.plugin = "dsh-system-proxy";
      tag.dataset.pluginCss = "dsh-system-proxy/client";
      tag.textContent = css;
      document.head.appendChild(tag);
    }
    const normalize = (value) => ({ enabled: value?.enabled !== false, mode: typeof value?.mode === "string" ? value.mode : "auto", proxyUrl: typeof value?.url === "string" ? value.url : "", passwordRef: typeof value?.passwordRef === "string" && value.passwordRef.length > 0 ? value.passwordRef : DEFAULT_PASSWORD_REF, patchNodeHttp: value?.patchNodeHttp !== false, protectPrivate: value?.protectPrivate !== false });
    const effectiveRef = (value) => value.trim() || DEFAULT_PASSWORD_REF;
    const hasUserinfo = (value) => { const text = value.trim(); if (!text) return false; try { const parsed = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `http://${text}`); return parsed.username !== "" || parsed.password !== ""; } catch { return false; } };
    const rpcValue = (response, operation) => { if (response?.result?.ok) return response.result.value; const failure = response?.result?.error; throw new Error(failure?.message || failure?.code || operation); };

    function SystemProxySettingsCard({ scope, api, locale, t }) {
      useSyncExternalStore(locale.subscribe.bind(locale), locale.getSnapshot.bind(locale), locale.getSnapshot.bind(locale));
      const snapshot = useSyncExternalStore(scope.subscribe.bind(scope), scope.getSnapshot.bind(scope), scope.getSnapshot.bind(scope));
      const current = useMemo(() => normalize(snapshot.value), [snapshot.value]);
      const [open, setOpen] = useState(false);
      const [draft, setDraft] = useState(current);
      const [password, setPassword] = useState("");
      const [dirty, setDirty] = useState(false);
      const [saving, setSaving] = useState(false);
      const [message, setMessage] = useState({ kind: "", text: "" });
      const [credential, setCredential] = useState({ ref: "", configured: false, writable: true, loading: true });
      const credentialRead = useRef(0);
      const passwordRef = effectiveRef(draft.passwordRef);
      useEffect(() => { if (!dirty) setDraft(current); }, [current, dirty]);
      const describeCredential = useCallback(async (ref) => { const request = ++credentialRead.current; setCredential((old) => ({ ...old, ref, configured: old.ref === ref && old.configured, writable: old.ref === ref ? old.writable : true, loading: true })); try { const value = rpcValue(await api.credentials.describe({ refs: [ref] }), t("credentialLookupFailed")); if (request !== credentialRead.current) return; const view = value.credentials[ref]; setCredential({ ref, configured: view?.configured ?? false, writable: view?.writable ?? true, loading: false }); } catch { if (request === credentialRead.current) setCredential((old) => ({ ...old, ref, loading: false })); } }, [api, t]);
      useEffect(() => { describeCredential(passwordRef); }, [describeCredential, passwordRef]);
      const edit = useCallback((field, value) => { setDraft((old) => ({ ...old, [field]: value })); setDirty(true); setMessage({ kind: "", text: "" }); }, []);
      const editPassword = useCallback((value) => { setPassword(value); setDirty(true); setMessage({ kind: "", text: "" }); }, []);
      const reset = useCallback(() => { setDraft(current); setPassword(""); setDirty(false); setMessage({ kind: "", text: "" }); }, [current]);
      const save = useCallback(async () => { setMessage({ kind: "", text: "" }); if (!REF_PATTERN.test(passwordRef)) return setMessage({ kind: "error", text: t("errorPasswordRef") }); if (hasUserinfo(draft.proxyUrl)) return setMessage({ kind: "error", text: t("errorUserinfo") }); if (password !== "" && !credential.writable) return setMessage({ kind: "error", text: t("errorCredentialReadOnly") }); setSaving(true); try { if (password !== "") rpcValue(await api.credentials.set({ ref: passwordRef, value: password }), t("credentialSaveFailed")); const values = { ...draft, url: draft.proxyUrl, passwordRef }; delete values.proxyUrl; for (const field of FIELDS) { const changed = !Object.is(values[field], current[field === "url" ? "proxyUrl" : field]); if (changed || (field === "passwordRef" && password !== "")) await scope.set(field, values[field]); } setPassword(""); setDirty(false); await describeCredential(passwordRef); setMessage({ kind: "success", text: t("saved") }); } catch (cause) { setMessage({ kind: "error", text: cause instanceof Error ? cause.message : String(cause) }); } finally { setSaving(false); } }, [scope, api, draft, current, password, passwordRef, credential.writable, describeCredential, t]);
      if (snapshot.status === "unavailable") return null;
      const disabled = saving || !snapshot.writable;
      const checkbox = (field, key) => [h("span", { className: "dsp-label", key: field + "-label" }, t(key)), h("input", { className: "dsp-check", key: field, type: "checkbox", checked: draft[field], disabled, onChange: (event) => edit(field, event.target.checked) })];
      return h("li", { className: "dsp-card", "data-open": open, "data-settings-namespace": NAMESPACE },
        h("button", { type: "button", className: "dsp-header", "aria-expanded": open, "aria-label": `${t(open ? "collapse" : "expand")}: ${t("title")}`, onClick: () => setOpen(!open) }, h("span", { className: "dsp-head" }, h("span", { className: "dsp-title" }, t("title")), h("span", { className: "dsp-description" }, snapshot.status === "loading" ? t("loading") : t("description"))), dirty && h("span", { className: "dsp-badge" }, t("unsaved")), h("span", { className: "dsp-chevron", "aria-hidden": true }, "⌄")),
        open && snapshot.status !== "loading" && h("form", { className: "dsp-body", onSubmit: (event) => { event.preventDefault(); if (!disabled && dirty) save(); } },
          h("div", { className: "dsp-grid" },
            ...checkbox("enabled", "enabled"),
            h("label", { className: "dsp-label", htmlFor: "dsp-mode" }, t("mode")), h("div", null, h("select", { id: "dsp-mode", className: "dsp-control", value: draft.mode, disabled, onChange: (event) => edit("mode", event.target.value), "aria-describedby": "dsp-mode-hint" }, ["auto", "env", "system", "manual"].map((mode) => h("option", { value: mode, key: mode }, mode))), h("p", { id: "dsp-mode-hint", className: "dsp-hint" }, t("mode" + draft.mode[0].toUpperCase() + draft.mode.slice(1)))),
            h("label", { className: "dsp-label", htmlFor: "dsp-url" }, t("proxyUrl")), h("input", { id: "dsp-url", className: "dsp-control", type: "text", value: draft.proxyUrl, disabled, placeholder: "http://127.0.0.1:7890", onChange: (event) => edit("proxyUrl", event.target.value) }),
            h("label", { className: "dsp-label", htmlFor: "dsp-ref" }, t("passwordRef")), h("input", { id: "dsp-ref", className: "dsp-control", type: "text", value: draft.passwordRef, disabled, placeholder: DEFAULT_PASSWORD_REF, onChange: (event) => edit("passwordRef", event.target.value) }),
            h("label", { className: "dsp-label", htmlFor: "dsp-password" }, t("proxyPassword")), h("input", { id: "dsp-password", className: "dsp-control", type: "password", autoComplete: "new-password", value: password, disabled: disabled || !credential.writable, placeholder: t("passwordPlaceholder"), onChange: (event) => editPassword(event.target.value) }),
            h("span", { className: "dsp-status", role: "status" }, credential.loading ? t("credentialChecking") : `${t(credential.configured ? "credentialConfigured" : "credentialMissing")} · ${t("credentialWriteOnly")}`),
            ...checkbox("patchNodeHttp", "patchNodeHttp"), ...checkbox("protectPrivate", "protectPrivate")
          ),
          !snapshot.writable && h("p", { className: "dsp-readonly", role: "status" }, t("readOnly")),
          h("div", { className: "dsp-footer" }, message.text && h("p", { className: "dsp-message", "data-kind": message.kind, role: message.kind === "error" ? "alert" : "status" }, message.text), h("button", { type: "button", className: "dsp-button dsp-secondary", disabled: saving || !dirty, onClick: reset }, t("discard")), h("button", { type: "submit", className: "dsp-button dsp-primary", disabled: disabled || !dirty }, t(saving ? "saving" : "save")))
        )
      );
    }

    const inject = ["settingsScope", "slots", "connection", "remote", "locale"];
    function apply(ctx) {
      const scope = ctx.settingsScope.bind({ namespace: NAMESPACE });
      const { api } = ctx.get("connection");
      const locale = ctx.get("locale");
      ctx.effect(() => locale.register(NAMESPACE, { zh, en }), "system-proxy: dictionaries");
      const t = locale.bind(NAMESPACE);
      ctx.slots.inject("settings.plugin.item", () => ctx.slots.register({ name: "settings.plugin.item", id: "system-proxy", order: 30, locale: NAMESPACE }, () => h(SystemProxySettingsCard, { scope, api, locale, t })));
    }
    exports.apply = apply;
    exports.inject = inject;
    exports.SystemProxySettingsCard = SystemProxySettingsCard;
    return module.exports;
  }
});
