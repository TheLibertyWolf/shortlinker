=== Shortlinker ===
Contributors: thelibertywolf
Tags: shortlink, analytics, url shortener, shurl, api
Requires at least: 6.5
Tested up to: 6.7
Requires PHP: 7.4
Stable tag: 1.0.0
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

= 1.0.0 =
* Initial production release.
