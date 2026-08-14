window.__ModuleLoader__.load({
  id: "dsh-system-proxy",
  factory: (require) => {
    const module = { exports: {} };
    const exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    const React = require("react");
    const { createElement: h, useCallback, useEffect, useMemo, useState, useSyncExternalStore } = React;
    const NAMESPACE = "system-proxy";
    const FIELDS = ["enabled", "mode", "url", "patchNodeHttp", "protectPrivate"];
    const styles = {
      card: { border: "1px solid var(--dsw-alias-border-l2)", borderRadius: 12, padding: 16, background: "var(--dsw-alias-bg-layer-2)", color: "var(--dsw-alias-label-primary)" },
      title: { margin: "0 0 4px", fontSize: 16 }, hint: { margin: "0 0 14px", color: "var(--dsw-alias-label-secondary)", fontSize: 13 },
      row: { display: "grid", gridTemplateColumns: "minmax(130px, 1fr) minmax(180px, 2fr)", alignItems: "center", gap: 12, margin: "10px 0" },
      control: { boxSizing: "border-box", width: "100%", minHeight: 34, border: "1px solid var(--dsw-alias-border-l2)", borderRadius: 8, padding: "6px 10px", color: "inherit", background: "var(--dsw-alias-bg-layer-3)" },
      actions: { display: "flex", gap: 8, marginTop: 16 }, button: { border: "1px solid var(--dsw-alias-border-l2)", borderRadius: 8, padding: "7px 14px", cursor: "pointer" },
      error: { margin: "12px 0 0", color: "var(--dsw-alias-label-error)", fontSize: 13 }
    };
    const normalize = (value) => ({
      enabled: value?.enabled !== false,
      mode: typeof value?.mode === "string" ? value.mode : "auto",
      url: typeof value?.url === "string" ? value.url : "",
      patchNodeHttp: value?.patchNodeHttp !== false,
      protectPrivate: value?.protectPrivate !== false
    });

    function SystemProxySettingsCard({ scope }) {
      const snapshot = useSyncExternalStore(scope.subscribe.bind(scope), scope.getSnapshot.bind(scope), scope.getSnapshot.bind(scope));
      const current = useMemo(() => normalize(snapshot.value), [snapshot.value]);
      const [draft, setDraft] = useState(current);
      const [dirty, setDirty] = useState(false);
      const [saving, setSaving] = useState(false);
      const [error, setError] = useState("");
      useEffect(() => { if (!dirty) setDraft(current); }, [current, dirty]);
      const edit = useCallback((field, value) => { setDraft((old) => ({ ...old, [field]: value })); setDirty(true); setError(""); }, []);
      const reset = useCallback(() => { setDraft(current); setDirty(false); setError(""); }, [current]);
      const save = useCallback(async () => {
        setSaving(true); setError("");
        try {
          for (const field of FIELDS) if (!Object.is(draft[field], current[field])) await scope.set(field, draft[field]);
          setDirty(false);
        } catch (cause) {
          setError(cause instanceof Error ? cause.message : String(cause));
        } finally { setSaving(false); }
      }, [scope, draft, current]);
      if (snapshot.status === "unavailable") return null;
      if (snapshot.status === "loading") return h("section", { style: styles.card }, h("h3", { style: styles.title }, "System Proxy"), h("p", { style: styles.hint }, "Loading system-proxy settings…"));
      const disabled = saving || !snapshot.writable;
      const checkbox = (field, label) => h("label", { style: styles.row, key: field }, h("span", null, label), h("input", { type: "checkbox", checked: draft[field], disabled, onChange: (event) => edit(field, event.target.checked) }));
      return h("section", { style: styles.card, "data-settings-namespace": NAMESPACE },
        h("h3", { style: styles.title }, "System Proxy"),
        h("p", { style: styles.hint }, "Outbound proxy routing. Changes remain staged until Save."),
        checkbox("enabled", "Enabled"),
        h("label", { style: styles.row }, h("span", null, "Mode"), h("select", { style: styles.control, value: draft.mode, disabled, onChange: (event) => edit("mode", event.target.value) }, ["auto", "env", "system", "manual"].map((mode) => h("option", { value: mode, key: mode }, mode)))),
        h("label", { style: styles.row }, h("span", null, "Proxy URL"), h("input", { style: styles.control, type: "password", autoComplete: "new-password", value: draft.url, disabled, placeholder: "Proxy URL (hidden)", onChange: (event) => edit("url", event.target.value) })),
        checkbox("patchNodeHttp", "Patch node:http / node:https"),
        checkbox("protectPrivate", "Protect private networks"),
        !snapshot.writable && h("p", { style: styles.error, role: "alert" }, "Settings are read-only in this connection."),
        error && h("p", { style: styles.error, role: "alert" }, error),
        h("div", { style: styles.actions },
          h("button", { type: "button", style: styles.button, disabled: disabled || !dirty, onClick: save }, saving ? "Saving…" : "Save"),
          h("button", { type: "button", style: styles.button, disabled: saving || !dirty, onClick: reset }, "Reset"))
      );
    }

    const inject = ["settingsScope", "slots"];
    function apply(ctx) {
      const scope = ctx.settingsScope.bind({ namespace: NAMESPACE });
      ctx.slots.inject("settings.plugin.item", () => ctx.slots.register({
        name: "settings.plugin.item", id: "system-proxy", order: 30
      }, () => h(SystemProxySettingsCard, { scope })));
    }
    exports.apply = apply;
    exports.inject = inject;
    exports.SystemProxySettingsCard = SystemProxySettingsCard;
    return module.exports;
  }
});
