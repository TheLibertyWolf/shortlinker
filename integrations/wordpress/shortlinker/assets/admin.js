(() => {
  "use strict";
  const request = async (action, values = {}) => {
    const data = new URLSearchParams({ action, ...values });
    const response = await fetch(ShortlinkerAdmin.ajaxUrl, {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: data,
    });
    const result = await response.json();
    if (!response.ok || !result.success) throw new Error((result.data && result.data.message) || ShortlinkerAdmin.error);
    return result.data;
  };

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
        if (!result.success) throw new Error((result.data && result.data.message) || ShortlinkerAdmin.error);
        box.querySelector(".shortlinker-result").innerHTML = `<a class="shortlinker-url" href="${result.data.url}" target="_blank" rel="noopener">${result.data.url}</a><p><strong>0</strong> ${ShortlinkerAdmin.clickLabel}</p>`;
        button.dataset.replace = "1";
        button.textContent = ShortlinkerAdmin.regenerate;
        box.querySelector(".shortlinker-message").textContent = "✓";
      } catch (error) {
        box.querySelector(".shortlinker-message").textContent = error.message;
        button.textContent = original;
      } finally { button.disabled = false; }
    });
  });

  document.querySelectorAll("[data-shortlinker-bulk]").forEach((bulk) => {
    const type = bulk.querySelector("[data-shortlinker-bulk-type]");
    const start = bulk.querySelector("[data-shortlinker-bulk-start]");
    const stop = bulk.querySelector("[data-shortlinker-bulk-stop]");
    const status = bulk.querySelector("[data-shortlinker-bulk-status]");
    const numbers = bulk.querySelector("[data-shortlinker-bulk-numbers]");
    const progress = bulk.querySelector(".shortlinker-bulk-progress");
    const terminal = bulk.querySelector("[data-shortlinker-bulk-log]");
    let running = false;

    const timestamp = () => new Date().toLocaleTimeString();
    const log = (message, state = "info") => {
      const line = document.createElement("div");
      line.className = `is-${state}`;
      line.textContent = `[${timestamp()}] ${message}`;
      terminal.appendChild(line);
      terminal.scrollTop = terminal.scrollHeight;
    };
    const setProgress = (processed, total) => {
      const percentage = total > 0 ? Math.min(100, Math.round((processed / total) * 100)) : 100;
      progress.value = percentage;
      progress.textContent = `${percentage}%`;
      numbers.textContent = `${processed.toLocaleString()} / ${total.toLocaleString()} (${percentage}%)`;
    };
    const bulkRequest = (action, extra = {}) => request(action, {
      nonce: ShortlinkerAdmin.bulkNonce,
      postType: type.value,
      ...extra,
    });
    const refreshCount = async () => {
      status.textContent = ShortlinkerAdmin.bulkCounting;
      start.disabled = true;
      try {
        const counts = await bulkRequest("shortlinker_bulk_status");
        setProgress(counts.linked, counts.published);
        status.textContent = `${counts.missing.toLocaleString()} ${ShortlinkerAdmin.missingLabel} · ${counts.linked.toLocaleString()} ${ShortlinkerAdmin.linkedLabel}`;
        start.disabled = counts.missing === 0;
        return counts;
      } catch (error) {
        status.textContent = error.message;
        log(error.message, "error");
        return null;
      }
    };
    const setRunning = (value) => {
      running = value;
      type.disabled = value;
      start.disabled = value;
      stop.disabled = !value;
    };

    type.addEventListener("change", refreshCount);
    stop.addEventListener("click", () => {
      if (!running) return;
      running = false;
      stop.disabled = true;
      status.textContent = ShortlinkerAdmin.bulkStopping;
      log(ShortlinkerAdmin.bulkStopping, "warning");
    });
    start.addEventListener("click", async () => {
      if (running || !window.confirm(ShortlinkerAdmin.confirmBulk)) return;
      terminal.replaceChildren();
      log(ShortlinkerAdmin.bulkStarting);
      const counts = await refreshCount();
      if (!counts || counts.missing === 0) {
        if (counts) log(ShortlinkerAdmin.bulkNothing, "success");
        return;
      }
      setRunning(true);
      const total = counts.missing;
      let processed = 0;
      let created = 0;
      let failed = 0;
      let cursor = 0;
      setProgress(0, total);
      status.textContent = ShortlinkerAdmin.bulkStarting;
      try {
        while (running) {
          let batch = null;
          let attempts = 0;
          while (running && !batch) {
            try {
              batch = await bulkRequest("shortlinker_bulk_batch", { afterId: String(cursor), limit: "50" });
            } catch (error) {
              attempts += 1;
              if (attempts >= 3) throw error;
              log(`${ShortlinkerAdmin.bulkRetry} (${attempts}/3)`, "warning");
              await new Promise((resolve) => window.setTimeout(resolve, attempts * 1000));
            }
          }
          if (!batch || batch.finished) break;
          batch.items.forEach((item) => {
            if (item.status === "success") log(`[OK] #${item.id} ${item.title} → ${item.url}`, "success");
            else log(`[ERROR] #${item.id} ${item.title} — ${item.message}`, "error");
          });
          processed += Number(batch.processed || 0);
          created += Number(batch.created || 0);
          failed += Number(batch.failed || 0);
          cursor = Number(batch.cursor || cursor);
          setProgress(processed, total);
          status.textContent = `${created.toLocaleString()} ${ShortlinkerAdmin.createdLabel} · ${failed.toLocaleString()} ${ShortlinkerAdmin.failedLabel}`;
          await new Promise((resolve) => window.setTimeout(resolve, 100));
        }
        if (running) {
          setProgress(total, total);
          status.textContent = `${ShortlinkerAdmin.bulkComplete} ${created.toLocaleString()} ${ShortlinkerAdmin.createdLabel} · ${failed.toLocaleString()} ${ShortlinkerAdmin.failedLabel}`;
          log(status.textContent, failed ? "warning" : "success");
        } else {
          status.textContent = `${ShortlinkerAdmin.bulkStopped} ${created.toLocaleString()} ${ShortlinkerAdmin.createdLabel} · ${failed.toLocaleString()} ${ShortlinkerAdmin.failedLabel}`;
          log(status.textContent, "warning");
        }
      } catch (error) {
        status.textContent = error.message;
        log(error.message, "error");
      } finally {
        setRunning(false);
        const latest = await refreshCount();
        if (latest && latest.missing > 0 && failed > 0) log(`${latest.missing.toLocaleString()} ${ShortlinkerAdmin.remainingLabel}`, "warning");
      }
    });
    refreshCount();
  });
})();
