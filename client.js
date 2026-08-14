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
    const styles = {
      card: { border: "1px solid var(--dsw-alias-border-l2)", borderRadius: 12, padding: 16, background: "var(--dsw-alias-bg-layer-2)", color: "var(--dsw-alias-label-primary)" },
      title: { margin: "0 0 4px", fontSize: 16 }, hint: { margin: "0 0 14px", color: "var(--dsw-alias-label-secondary)", fontSize: 13 },
      row: { display: "grid", gridTemplateColumns: "minmax(130px, 1fr) minmax(180px, 2fr)", alignItems: "center", gap: 12, margin: "10px 0" },
      control: { boxSizing: "border-box", width: "100%", minHeight: 34, border: "1px solid var(--dsw-alias-border-l2)", borderRadius: 8, padding: "6px 10px", color: "inherit", background: "var(--dsw-alias-bg-layer-3)" },
      actions: { display: "flex", gap: 8, marginTop: 16 }, button: { border: "1px solid var(--dsw-alias-border-l2)", borderRadius: 8, padding: "7px 14px", cursor: "pointer" },
      status: { margin: "-4px 0 10px", color: "var(--dsw-alias-label-secondary)", fontSize: 12 },
      error: { margin: "12px 0 0", color: "var(--dsw-alias-label-error)", fontSize: 13 }
    };
    const normalize = (value) => ({
      enabled: value?.enabled !== false,
      mode: typeof value?.mode === "string" ? value.mode : "auto",
      proxyUrl: typeof value?.url === "string" ? value.url : "",
      passwordRef: typeof value?.passwordRef === "string" && value.passwordRef.length > 0 ? value.passwordRef : DEFAULT_PASSWORD_REF,
      patchNodeHttp: value?.patchNodeHttp !== false,
      protectPrivate: value?.protectPrivate !== false
    });
    const effectiveRef = (value) => value.trim() || DEFAULT_PASSWORD_REF;
    const hasUserinfo = (value) => {
      const text = value.trim();
      if (!text) return false;
      try {
        const parsed = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `http://${text}`);
        return parsed.username !== "" || parsed.password !== "";
      } catch { return false; }
    };
    const rpcValue = (response, operation) => {
      if (response?.result?.ok) return response.result.value;
      const failure = response?.result?.error;
      throw new Error(failure?.message || failure?.code || `${operation} failed`);
    };

    function SystemProxySettingsCard({ scope, api }) {
      const snapshot = useSyncExternalStore(scope.subscribe.bind(scope), scope.getSnapshot.bind(scope), scope.getSnapshot.bind(scope));
      const current = useMemo(() => normalize(snapshot.value), [snapshot.value]);
      const [draft, setDraft] = useState(current);
      const [password, setPassword] = useState("");
      const [dirty, setDirty] = useState(false);
      const [saving, setSaving] = useState(false);
      const [error, setError] = useState("");
      const [credential, setCredential] = useState({ ref: "", configured: false, writable: true, loading: true });
      const credentialRead = useRef(0);
      const passwordRef = effectiveRef(draft.passwordRef);

      useEffect(() => { if (!dirty) setDraft(current); }, [current, dirty]);
      const describeCredential = useCallback(async (ref) => {
        const request = ++credentialRead.current;
        setCredential((old) => ({ ...old, ref, configured: old.ref === ref && old.configured, writable: old.ref === ref ? old.writable : true, loading: true }));
        try {
          const value = rpcValue(await api.credentials.describe({ refs: [ref] }), "Credential lookup");
          if (request !== credentialRead.current) return;
          const view = value.credentials[ref];
          setCredential({ ref, configured: view?.configured ?? false, writable: view?.writable ?? true, loading: false });
        } catch {
          if (request === credentialRead.current) setCredential((old) => ({ ...old, ref, loading: false }));
        }
      }, [api]);
      useEffect(() => { describeCredential(passwordRef); }, [describeCredential, passwordRef]);

      const edit = useCallback((field, value) => { setDraft((old) => ({ ...old, [field]: value })); setDirty(true); setError(""); }, []);
      const editPassword = useCallback((value) => { setPassword(value); setDirty(true); setError(""); }, []);
      const reset = useCallback(() => { setDraft(current); setPassword(""); setDirty(false); setError(""); }, [current]);
      const save = useCallback(async () => {
        setError("");
        if (!REF_PATTERN.test(passwordRef)) { setError("passwordRef 必须是环境变量格式的标识符（例如 DSH_PROXY_PASSWORD）。"); return; }
        if (hasUserinfo(draft.proxyUrl)) { setError("Proxy URL 不得包含 userinfo（用户名或密码）；请改用 passwordRef credential。"); return; }
        if (password !== "" && !credential.writable) { setError("此 credential 当前为只读，无法保存密码。"); return; }
        setSaving(true);
        try {
          if (password !== "") rpcValue(await api.credentials.set({ ref: passwordRef, value: password }), "Credential save");
          const values = { ...draft, url: draft.proxyUrl, passwordRef };
          delete values.proxyUrl;
          for (const field of FIELDS) {
            const changed = !Object.is(values[field], current[field === "url" ? "proxyUrl" : field]);
            // The normalized default is intentionally not written during unrelated
            // edits, but a newly staged password must persist the reference that
            // the Host will resolve after this credential-first save.
            if (changed || (field === "passwordRef" && password !== "")) await scope.set(field, values[field]);
          }
          setPassword("");
          setDirty(false);
           await describeCredential(passwordRef);
          setError("已保存。密码已加密，页面不会回显原文。");
        } catch (cause) {
          setError(cause instanceof Error ? cause.message : String(cause));
        } finally { setSaving(false); }
      }, [scope, api, draft, current, password, passwordRef, credential.writable, describeCredential]);
      if (snapshot.status === "unavailable") return null;
      if (snapshot.status === "loading") return h("section", { style: styles.card }, h("h3", { style: styles.title }, "System Proxy"), h("p", { style: styles.hint }, "Loading system-proxy settings…"));
      const disabled = saving || !snapshot.writable;
      const checkbox = (field, label) => h("label", { style: styles.row, key: field }, h("span", null, label), h("input", { type: "checkbox", checked: draft[field], disabled, onChange: (event) => edit(field, event.target.checked) }));
      const passwordDisabled = disabled || !credential.writable;
      return h("form", { style: styles.card, "data-settings-namespace": NAMESPACE, onSubmit: (event) => { event.preventDefault(); if (!disabled && dirty) save(); } },
        h("h3", { style: styles.title }, "系统代理"),
        h("p", { style: styles.hint }, "密码是只写字段：回车或保存后由系统凭据后端加密，只显示配置状态。"),
        checkbox("enabled", "Enabled"),
        h("label", { style: styles.row }, h("span", null, "Mode"), h("select", { style: styles.control, value: draft.mode, disabled, onChange: (event) => edit("mode", event.target.value) }, ["auto", "env", "system", "manual"].map((mode) => h("option", { value: mode, key: mode }, mode)))),
        h("label", { style: styles.row }, h("span", null, "Proxy URL"), h("input", { style: styles.control, type: "text", value: draft.proxyUrl, disabled, placeholder: "http://127.0.0.1:7890", onChange: (event) => edit("proxyUrl", event.target.value) })),
        h("label", { style: styles.row }, h("span", null, "passwordRef"), h("input", { style: styles.control, type: "text", value: draft.passwordRef, disabled, placeholder: DEFAULT_PASSWORD_REF, onChange: (event) => edit("passwordRef", event.target.value) })),
        h("label", { style: styles.row }, h("span", null, "Proxy password"), h("input", { style: styles.control, type: "password", autoComplete: "new-password", value: password, disabled: passwordDisabled, placeholder: "留空则保留现有密码", onChange: (event) => editPassword(event.target.value) })),
        h("p", { style: styles.status }, credential.loading ? "正在检查 credential…" : credential.configured ? "已配置；页面不会回显原文。" : "未配置；页面不会回显原文。"),
        checkbox("patchNodeHttp", "Patch node:http / node:https"),
        checkbox("protectPrivate", "Protect private networks"),
        !snapshot.writable && h("p", { style: styles.error, role: "alert" }, "Settings are read-only in this connection."),
        error && h("p", { style: styles.error, role: "alert" }, error),
        h("div", { style: styles.actions },
          h("button", { type: "submit", style: styles.button, disabled: disabled || !dirty }, saving ? "保存中…" : "保存并加密"),
          h("button", { type: "button", style: styles.button, disabled: saving || !dirty, onClick: reset }, "放弃更改"))
      );
    }

    const inject = ["settingsScope", "slots", "connection"];
    function apply(ctx) {
      const scope = ctx.settingsScope.bind({ namespace: NAMESPACE });
      const { api } = ctx.get("connection");
      ctx.slots.inject("settings.plugin.item", () => ctx.slots.register({
        name: "settings.plugin.item", id: "system-proxy", order: 30
      }, () => h(SystemProxySettingsCard, { scope, api })));
    }
    exports.apply = apply;
    exports.inject = inject;
    exports.SystemProxySettingsCard = SystemProxySettingsCard;
    return module.exports;
  }
});
