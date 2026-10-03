(() => {
  "use strict";

  document.querySelectorAll("[data-confirm]").forEach((element) => {
    element.addEventListener("click", (event) => {
      if (!window.confirm(element.getAttribute("data-confirm") || "Are you sure?")) event.preventDefault();
    });
  });

  document.querySelectorAll("[data-copy]").forEach((button) => {
    button.addEventListener("click", async () => {
      const selector = button.getAttribute("data-copy");
      const source = selector ? document.querySelector(selector) : null;
      const value = source instanceof HTMLInputElement ? source.value : source?.textContent;
      if (!value) return;
      await navigator.clipboard.writeText(value.trim());
      const original = button.innerHTML;
      button.innerHTML = '<i class="bi bi-check2"></i> Copied';
      setTimeout(() => { button.innerHTML = original; }, 1500);
    });
  });

  const tooltips = document.querySelectorAll('[data-bs-toggle="tooltip"]');
  if (window.bootstrap) [...tooltips].map((el) => new window.bootstrap.Tooltip(el));
})();
