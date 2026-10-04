=== Shortlinker ===
Contributors: thelibertywolf
Tags: shortlink, analytics, url shortener, shurl, api
Requires at least: 6.5
Tested up to: 6.7
Requires PHP: 7.4
Stable tag: 1.2.0
License: GPLv2 or later
License URI: https://www.gnu.org/licenses/gpl-2.0.html

Create and monitor shurl.be shortlinks from the WordPress editor.

== Description ==

Shortlinker connects WordPress to a dedicated, IP-restricted Shortlinker API client.
It supports posts, pages and public custom post types, editor generation and regeneration,
click columns, delegated access, safe batch generation and an aggregate analytics panel.

== Installation ==

1. Upload and activate the plugin.
2. In shurl.be, create a dedicated API client with links read/write/delete, stats read and domains read scopes.
3. Copy the WordPress connection block shown immediately after creation.
4. Open Settings > Shortlinker > Connection and paste the block.
5. Select the enabled content types and defaults.

== Security ==

Connection, delegation and batch generation remain restricted to WordPress administrators.
Every state-changing action uses WordPress capabilities and nonces. Protect WordPress backups
and database access because the API token is stored in the WordPress options table.

== Changelog ==

= 1.2.0 =
* Added a compact Shortlinker statistics widget to the WordPress dashboard.
* Rebuilt bulk generation as an unlimited AJAX queue with live progress, safe stop, retries and a terminal-style activity log.
* Optimized dashboard metrics to use local WordPress data without triggering API calls on page load.
* Batched statistics refreshes into one cached API request for up to 100 displayed links.
* Added complete French translations with English as the default language.
* Moved country, browser, device and referrer summaries above the detailed performance table.

= 1.1.1 =
* Added a native Gutenberg Document sidebar panel for generating, displaying and regenerating shortlinks.
* Kept the side meta box for the Classic Editor.

= 1.1.0 =
* Added a full-width top-level statistics page.
* Added separate role and user access rules for configuration and statistics.
* Added a dedicated danger tab with optional looped generation.
* Added secure update checks against the shurl.be plugin manifest.
* Preserved the active settings tab after saving.

= 1.0.0 =
* Initial production release.
