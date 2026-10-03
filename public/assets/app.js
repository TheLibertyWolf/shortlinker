(() => {
  "use strict";

  const sidebar = document.querySelector("#adminSidebar");
  const sidebarToggle = document.querySelector("[data-sidebar-toggle]");
  if (sidebar && sidebarToggle) {
    const isFrench = document.documentElement.lang === "fr";
    const labels = {
      collapse: isFrench ? "Rétracter la barre latérale" : "Collapse sidebar",
      expand: isFrench ? "Déplier la barre latérale" : "Expand sidebar"
    };
    const applySidebarState = (collapsed) => {
      sidebar.classList.toggle("is-collapsed", collapsed);
      sidebarToggle.setAttribute("aria-expanded", String(!collapsed));
      sidebarToggle.setAttribute("aria-label", collapsed ? labels.expand : labels.collapse);
      sidebarToggle.setAttribute("title", collapsed ? labels.expand : labels.collapse);
      sidebarToggle.innerHTML = collapsed
        ? '<i class="bi bi-layout-sidebar-inset-reverse"></i>'
        : '<i class="bi bi-layout-sidebar-inset"></i>';
    };
    applySidebarState(window.localStorage.getItem("shortlinker.sidebar") === "collapsed");
    sidebarToggle.addEventListener("click", () => {
      const collapsed = !sidebar.classList.contains("is-collapsed");
      applySidebarState(collapsed);
      window.localStorage.setItem("shortlinker.sidebar", collapsed ? "collapsed" : "expanded");
    });
  }

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
