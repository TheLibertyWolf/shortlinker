(() => {
  "use strict";
  if (!window.wp || !wp.plugins || !wp.editPost || !wp.element || !wp.components || !wp.data || !window.ShortlinkerEditor) return;
  const { createElement: el, useState } = wp.element;
  const { useSelect } = wp.data;
  const { Button, Notice, TextControl } = wp.components;
  const { PluginDocumentSettingPanel } = wp.editPost;
  const config = window.ShortlinkerEditor;

  function ShortlinkerPanel() {
    const [url, setUrl] = useState(config.url || "");
    const [linkId, setLinkId] = useState(config.linkId || "");
    const [busy, setBusy] = useState(false);
    const [message, setMessage] = useState("");
    const postStatus = useSelect((select) => select("core/editor").getEditedPostAttribute("status"), []);
    const published = postStatus === "publish";

    const generate = async () => {
      const replace = Boolean(url);
      if (replace && !window.confirm(config.confirmRegenerate)) return;
      setBusy(true); setMessage("");
      try {
        const body = new URLSearchParams({ action: "shortlinker_generate", nonce: config.nonce, postId: String(config.postId), replace: replace ? "1" : "" });
        const response = await fetch(config.ajaxUrl, { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body });
        const result = await response.json();
        if (!result.success) throw new Error((result.data && result.data.message) || config.error);
        setUrl(result.data.url); setLinkId(result.data.id); setMessage("✓");
      } catch (error) { setMessage(error.message || config.error); }
      finally { setBusy(false); }
    };
    const copy = async () => {
      try {
        if (navigator.clipboard && window.isSecureContext) {
          await navigator.clipboard.writeText(url);
        } else {
          const input = document.createElement("textarea");
          input.value = url;
          input.style.position = "fixed";
          input.style.opacity = "0";
          document.body.appendChild(input);
          input.select();
          const copied = document.execCommand("copy");
          input.remove();
          if (!copied) throw new Error(config.copyError);
        }
        setMessage(config.copied);
      } catch (_) { setMessage(config.copyError); }
    };

    return el(PluginDocumentSettingPanel, { name: "shortlinker", title: "Shortlinker", className: "shortlinker-editor-panel" },
      config.autoError ? el(Notice, { status: "error", isDismissible: false }, `${config.autoErrorPrefix} ${config.autoError}`) : null,
      url ? el("div", { className: "shortlinker-editor-url" },
        el(TextControl, { label: config.shortlinkLabel, value: url, readOnly: true, onChange: () => {} }),
        el(Button, { variant: "secondary", onClick: copy }, config.copy)
      ) : el("p", null, config.noShortlink),
      url && linkId ? el("p", null, el("a", { href: `${config.analyticsUrl}/${encodeURIComponent(linkId)}`, target: "_blank", rel: "noopener" }, `${config.viewStats} ↗`)) : null,
      !published ? el(Notice, { status: "warning", isDismissible: false }, config.publishFirst) : null,
      el(Button, { variant: "primary", disabled: busy || !published, isBusy: busy, onClick: generate }, busy ? config.generating : (url ? config.regenerate : config.generate)),
      message ? el("p", { className: message === "✓" || message === config.copied ? "shortlinker-editor-success" : "shortlinker-editor-error", role: "status" }, message) : null
    );
  }

  wp.plugins.registerPlugin("shortlinker-editor", { render: ShortlinkerPanel, icon: "admin-links" });
})();
