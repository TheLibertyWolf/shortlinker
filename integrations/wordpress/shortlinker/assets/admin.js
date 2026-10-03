(() => {
  "use strict";
  document.querySelectorAll("[data-shortlinker-confirm]").forEach((form) => {
    form.addEventListener("submit", (event) => {
      if (!window.confirm(form.dataset.shortlinkerConfirm)) event.preventDefault();
    });
  });
  document.querySelectorAll(".shortlinker-generate").forEach((button) => {
    button.addEventListener("click", async () => {
      const box = button.closest("[data-shortlinker-post]");
      const replace = button.dataset.replace === "1";
      if (replace && !window.confirm(ShortlinkerAdmin.confirmRegenerate)) return;
      const original = button.textContent;
      button.disabled = true;
      button.textContent = ShortlinkerAdmin.generating;
      const data = new URLSearchParams({ action: "shortlinker_generate", nonce: ShortlinkerAdmin.nonce, postId: box.dataset.shortlinkerPost, replace: replace ? "1" : "" });
      try {
        const response = await fetch(ShortlinkerAdmin.ajaxUrl, { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: data });
        const result = await response.json();
        if (!result.success) throw new Error(result.data?.message || ShortlinkerAdmin.error);
        box.querySelector(".shortlinker-result").innerHTML = `<a class="shortlinker-url" href="${result.data.url}" target="_blank" rel="noopener">${result.data.url}</a><p><strong>0</strong> clicks</p>`;
        button.dataset.replace = "1";
        button.textContent = "Regenerate";
        box.querySelector(".shortlinker-message").textContent = "✓";
      } catch (error) {
        box.querySelector(".shortlinker-message").textContent = error.message;
        button.textContent = original;
      } finally { button.disabled = false; }
    });
  });
})();
