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
    const [clicks, setClicks] = useState(Number(config.clicks || 0));
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
        setUrl(result.data.url); setClicks(Number(result.data.clicks || 0)); setMessage("✓");
      } catch (error) { setMessage(error.message || config.error); }
      finally { setBusy(false); }
    };

    return el(PluginDocumentSettingPanel, { name: "shortlinker", title: "Shortlinker", className: "shortlinker-editor-panel" },
      url ? el(TextControl, { label: config.shortlinkLabel, value: url, readOnly: true, onChange: () => {} }) : el("p", null, config.noShortlink),
      url ? el("p", null, el("strong", null, String(clicks)), ` ${config.clickLabel}`) : null,
      !published ? el(Notice, { status: "warning", isDismissible: false }, config.publishFirst) : null,
      el(Button, { variant: "primary", disabled: busy || !published, isBusy: busy, onClick: generate }, busy ? config.generating : (url ? config.regenerate : config.generate)),
      message ? el("p", { className: message === "✓" ? "shortlinker-editor-success" : "shortlinker-editor-error", role: "status" }, message) : null
    );
  }

  wp.plugins.registerPlugin("shortlinker-editor", { render: ShortlinkerPanel, icon: "admin-links" });
})();
