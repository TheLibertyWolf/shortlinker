import { cp, mkdir } from "node:fs/promises";

await mkdir("public/assets/vendor/bootstrap", { recursive: true });
await mkdir("public/assets/vendor/bootstrap-icons/fonts", { recursive: true });
await cp("node_modules/bootstrap/dist/css/bootstrap.min.css", "public/assets/vendor/bootstrap/bootstrap.min.css");
await cp("node_modules/bootstrap/dist/js/bootstrap.bundle.min.js", "public/assets/vendor/bootstrap/bootstrap.bundle.min.js");
await cp("node_modules/bootstrap-icons/font/bootstrap-icons.min.css", "public/assets/vendor/bootstrap-icons/bootstrap-icons.min.css");
await cp("node_modules/bootstrap-icons/font/fonts", "public/assets/vendor/bootstrap-icons/fonts", { recursive: true, force: true });
