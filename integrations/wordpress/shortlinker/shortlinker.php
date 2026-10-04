<?php
/**
 * Plugin Name: Shortlinker
 * Plugin URI: https://shurl.be/
 * Description: Generate and monitor shurl.be shortlinks directly from WordPress.
 * Version: 1.2.0
 * Requires at least: 6.5
 * Requires PHP: 7.4
 * Author: Jessy System
 * Author URI: https://jessysystem.com/
 * License: GPL-2.0-or-later
 * License URI: https://www.gnu.org/licenses/gpl-2.0.html
 * Text Domain: shortlinker
 */

defined('ABSPATH') || exit;

final class Shortlinker_WordPress {
    const VERSION = '1.2.0';
    const OPTION = 'shortlinker_settings';
    const UPDATE_MANIFEST = 'https://shurl.be/assets/wordpress-plugin.json';
    const META_ID = '_shortlinker_id';
    const META_URL = '_shortlinker_url';
    const META_CLICKS = '_shortlinker_clicks';
    const META_SYNCED = '_shortlinker_synced_at';
    const META_STATS = '_shortlinker_stats';

    public static function boot() {
        $plugin = new self();
        register_activation_hook(__FILE__, array($plugin, 'activate'));
        register_deactivation_hook(__FILE__, array($plugin, 'deactivate'));
        add_action('init', array($plugin, 'load_textdomain'), 1);
        add_action('admin_menu', array($plugin, 'admin_menu'));
        add_action('wp_dashboard_setup', array($plugin, 'register_dashboard_widget'));
        add_action('admin_init', array($plugin, 'handle_settings'));
        add_action('init', array($plugin, 'register_list_columns'), 100);
        add_action('add_meta_boxes', array($plugin, 'add_meta_boxes'));
        add_action('admin_enqueue_scripts', array($plugin, 'enqueue_assets'));
        add_action('enqueue_block_editor_assets', array($plugin, 'enqueue_block_editor_assets'));
        add_action('wp_ajax_shortlinker_generate', array($plugin, 'ajax_generate'));
        add_action('wp_ajax_shortlinker_bulk_status', array($plugin, 'ajax_bulk_status'));
        add_action('wp_ajax_shortlinker_bulk_batch', array($plugin, 'ajax_bulk_batch'));
        add_action('admin_post_shortlinker_check_update', array($plugin, 'check_update_now'));
        add_filter('site_transient_update_plugins', array($plugin, 'plugin_updates'));
        add_filter('plugins_api', array($plugin, 'plugin_information'), 20, 3);
    }

    public function register_list_columns() {
        foreach ($this->public_post_types() as $post_type) {
            add_filter("manage_{$post_type}_posts_columns", array($this, 'add_column'));
            add_action("manage_{$post_type}_posts_custom_column", array($this, 'render_column'), 10, 2);
        }
    }

    public function load_textdomain() {
        load_plugin_textdomain('shortlinker', false, dirname(plugin_basename(__FILE__)) . '/languages');
    }

    public function activate() {
        if (!get_option(self::OPTION)) {
            add_option(self::OPTION, array(
                'api_base' => 'https://shurl.be/api/v1',
                'token' => '',
                'domain' => 'shurl.be',
                'post_types' => array('post', 'page'),
                'redirect_type' => 302,
                'tags' => 'wordpress',
                'config_users' => array(), 'config_roles' => array(),
                'stats_users' => array(), 'stats_roles' => array(),
            ), '', false);
        }
    }

    public function deactivate() {
        wp_clear_scheduled_hook('shortlinker_refresh_stats');
    }

    private function settings() {
        return wp_parse_args((array) get_option(self::OPTION, array()), array(
            'api_base' => 'https://shurl.be/api/v1', 'token' => '', 'domain' => 'shurl.be',
            'post_types' => array('post', 'page'), 'redirect_type' => 302,
            'tags' => 'wordpress', 'allowed_users' => array(),
            'config_users' => array(), 'config_roles' => array(),
            'stats_users' => array(), 'stats_roles' => array(),
        ));
    }

    private function has_delegated_access($area) {
        if (current_user_can('manage_options')) return true;
        $settings = $this->settings();
        $user = wp_get_current_user();
        $legacy = array_map('intval', (array) $settings['allowed_users']);
        $users = array_map('intval', (array) $settings[$area . '_users']);
        $roles = array_map('sanitize_key', (array) $settings[$area . '_roles']);
        return in_array((int) $user->ID, array_unique(array_merge($legacy, $users)), true) || (bool) array_intersect((array) $user->roles, $roles);
    }

    private function can_configure() {
        return $this->has_delegated_access('config');
    }

    private function can_view_stats() {
        return $this->has_delegated_access('stats');
    }

    private function selected_post_types() {
        $settings = $this->settings();
        return array_values(array_intersect($this->public_post_types(), (array) $settings['post_types']));
    }

    private function public_post_types() {
        return array_values(get_post_types(array('public' => true, 'show_ui' => true), 'names'));
    }

    public function admin_menu() {
        if ($this->can_configure()) {
            add_options_page(__('Shortlinker', 'shortlinker'), __('Shortlinker', 'shortlinker'), 'read', 'shortlinker', array($this, 'settings_page'));
        }
        if ($this->can_view_stats()) {
            add_menu_page(__('Shortlinker statistics', 'shortlinker'), __('Shortlinker Stats', 'shortlinker'), 'read', 'shortlinker-stats', array($this, 'statistics_page'), 'dashicons-chart-area', 58);
        }
    }

    public function enqueue_assets($hook) {
        $screen = get_current_screen();
        $selected = $this->selected_post_types();
        $plugin_screen = in_array($hook, array('settings_page_shortlinker', 'toplevel_page_shortlinker-stats'), true);
        $content_screen = $screen && in_array($screen->post_type, $selected, true);
        $dashboard = $hook === 'index.php' && $this->can_view_stats();
        if (!$plugin_screen && !$content_screen && !$dashboard) return;
        wp_enqueue_style('shortlinker-admin', plugins_url('assets/admin.css', __FILE__), array(), self::VERSION);
        wp_enqueue_script('shortlinker-admin', plugins_url('assets/admin.js', __FILE__), array(), self::VERSION, true);
        wp_localize_script('shortlinker-admin', 'ShortlinkerAdmin', array(
            'ajaxUrl' => admin_url('admin-ajax.php'),
            'nonce' => wp_create_nonce('shortlinker_editor'),
            'bulkNonce' => wp_create_nonce('shortlinker_bulk'),
            'generating' => __('Generating…', 'shortlinker'),
            'regenerate' => __('Regenerate', 'shortlinker'),
            'clickLabel' => __('clicks', 'shortlinker'),
            'confirmRegenerate' => __('The current shortlink will stop working. Regenerate it?', 'shortlinker'),
            'confirmBulk' => __('Generate every missing shortlink for this content type?', 'shortlinker'),
            'bulkReady' => __('Ready.', 'shortlinker'),
            'bulkCounting' => __('Counting eligible content…', 'shortlinker'),
            'bulkStarting' => __('Starting bulk generation…', 'shortlinker'),
            'bulkStopping' => __('Stopping after the current batch…', 'shortlinker'),
            'bulkStopped' => __('Stopped by the operator.', 'shortlinker'),
            'bulkComplete' => __('Bulk generation complete.', 'shortlinker'),
            'bulkNothing' => __('No missing shortlinks for this content type.', 'shortlinker'),
            'bulkRetry' => __('Request failed; retrying…', 'shortlinker'),
            'missingLabel' => __('missing', 'shortlinker'),
            'linkedLabel' => __('linked', 'shortlinker'),
            'createdLabel' => __('created', 'shortlinker'),
            'failedLabel' => __('failed', 'shortlinker'),
            'remainingLabel' => __('items remain and can be retried.', 'shortlinker'),
            'error' => __('The operation failed.', 'shortlinker'),
        ));
    }

    public function enqueue_block_editor_assets() {
        if (!$this->can_configure()) return;
        $screen = get_current_screen();
        if (!$screen || !in_array($screen->post_type, $this->selected_post_types(), true)) return;
        global $post;
        $post_id = $post instanceof WP_Post ? $post->ID : get_the_ID();
        if (!$post_id) return;
        wp_enqueue_script('shortlinker-block-editor', plugins_url('assets/editor.js', __FILE__), array('wp-plugins', 'wp-edit-post', 'wp-element', 'wp-components', 'wp-data'), self::VERSION, true);
        wp_localize_script('shortlinker-block-editor', 'ShortlinkerEditor', array(
            'ajaxUrl' => admin_url('admin-ajax.php'), 'nonce' => wp_create_nonce('shortlinker_editor'),
            'postId' => (int) $post_id,
            'url' => (string) get_post_meta($post_id, self::META_URL, true),
            'clicks' => (int) get_post_meta($post_id, self::META_CLICKS, true),
            'generating' => __('Generating…', 'shortlinker'), 'generate' => __('Generate shortlink', 'shortlinker'),
            'regenerate' => __('Regenerate', 'shortlinker'), 'clickLabel' => __('clicks', 'shortlinker'),
            'shortlinkLabel' => __('Shortlink', 'shortlinker'), 'noShortlink' => __('No shortlink yet.', 'shortlinker'),
            'publishFirst' => __('Publish this content first.', 'shortlinker'),
            'confirmRegenerate' => __('The current shortlink will stop working. Regenerate it?', 'shortlinker'),
            'error' => __('The operation failed.', 'shortlinker'),
        ));
    }

    public function handle_settings() {
        if (empty($_POST['shortlinker_action'])) return;
        if (!$this->can_configure()) wp_die(esc_html__('Permission denied.', 'shortlinker'), '', array('response' => 403));
        check_admin_referer('shortlinker_settings');
        $action = sanitize_key(wp_unslash($_POST['shortlinker_action']));
        if ($action === 'access' && !current_user_can('manage_options')) wp_die(esc_html__('Administrators only.', 'shortlinker'), '', array('response' => 403));
        $settings = $this->settings();

        if ($action === 'connection') {
            $raw = trim(wp_unslash(isset($_POST['connection_json']) ? $_POST['connection_json'] : ''));
            $config = json_decode($raw, true);
            if (!is_array($config) || empty($config['apiBase']) || empty($config['token']) || empty($config['domain'])) {
                $this->redirect_notice('error', __('Invalid connection block. Copy it again from Shortlinker > API clients.', 'shortlinker'), 'connection');
            }
            $api_base = untrailingslashit(esc_url_raw($config['apiBase']));
            if (strpos($api_base, 'https://') !== 0 || strpos($api_base, '/api/v1') === false) {
                $this->redirect_notice('error', __('The API URL must use HTTPS and target /api/v1.', 'shortlinker'), 'connection');
            }
            $settings['api_base'] = $api_base;
            $settings['token'] = sanitize_text_field($config['token']);
            $settings['domain'] = sanitize_text_field($config['domain']);
            if (!empty($config['defaultRedirectType'])) $settings['redirect_type'] = (int) $config['defaultRedirectType'];
            if (!empty($config['defaultTags']) && is_array($config['defaultTags'])) $settings['tags'] = implode(',', array_map('sanitize_text_field', $config['defaultTags']));
        } elseif ($action === 'content') {
            $allowed_types = $this->public_post_types();
            $requested = array_map('sanitize_key', isset($_POST['post_types']) ? (array) $_POST['post_types'] : array());
            $settings['post_types'] = array_values(array_intersect($allowed_types, $requested));
            $redirect = isset($_POST['redirect_type']) ? (int) $_POST['redirect_type'] : 302;
            $settings['redirect_type'] = in_array($redirect, array(301, 302, 307, 308), true) ? $redirect : 302;
            $settings['tags'] = implode(',', array_slice(array_filter(array_map('sanitize_text_field', explode(',', wp_unslash($_POST['tags'] ?? '')))), 0, 20));
        } elseif ($action === 'access') {
            $valid_roles = array_keys(wp_roles()->roles);
            foreach (array('config', 'stats') as $area) {
                $settings[$area . '_users'] = array_values(array_unique(array_map('intval', isset($_POST[$area . '_users']) ? (array) $_POST[$area . '_users'] : array())));
                $requested_roles = array_map('sanitize_key', isset($_POST[$area . '_roles']) ? (array) $_POST[$area . '_roles'] : array());
                $settings[$area . '_roles'] = array_values(array_intersect($valid_roles, $requested_roles));
            }
            $settings['allowed_users'] = array();
        }

        update_option(self::OPTION, $settings, false);
        $this->redirect_notice('updated', __('Settings saved.', 'shortlinker'), $action === 'content' ? 'content' : ($action === 'access' ? 'access' : 'connection'));
    }

    private function redirect_notice($type, $message, $tab = 'connection') {
        wp_safe_redirect(add_query_arg(array('page' => 'shortlinker', 'tab' => $tab, 'sl_notice' => $type, 'sl_message' => $message), admin_url('options-general.php')));
        exit;
    }

    private function api($method, $path, $body = null, $idempotency_key = '') {
        $settings = $this->settings();
        if (empty($settings['token'])) return new WP_Error('not_connected', __('Shortlinker is not connected.', 'shortlinker'));
        $args = array(
            'method' => $method, 'timeout' => 15,
            'headers' => array('Authorization' => 'Bearer ' . $settings['token'], 'Accept' => 'application/json'),
        );
        if ($body !== null) {
            $args['headers']['Content-Type'] = 'application/json';
            $args['headers']['Idempotency-Key'] = $idempotency_key ?: wp_generate_uuid4();
            $args['body'] = wp_json_encode($body);
        }
        $response = wp_remote_request(untrailingslashit($settings['api_base']) . '/' . ltrim($path, '/'), $args);
        if (is_wp_error($response)) return $response;
        $code = wp_remote_retrieve_response_code($response);
        $decoded = json_decode(wp_remote_retrieve_body($response), true);
        if ($code < 200 || $code >= 300) {
            $message = isset($decoded['error']['message']) ? $decoded['error']['message'] : sprintf(__('API error (%d).', 'shortlinker'), $code);
            return new WP_Error('shortlinker_api', $message, array('status' => $code));
        }
        return is_array($decoded) ? $decoded : array();
    }

    private function generate_for_post($post_id, $replace = false) {
        $post = get_post($post_id);
        if (!$post || !in_array($post->post_type, $this->selected_post_types(), true)) return new WP_Error('post_type', __('This content type is not enabled.', 'shortlinker'));
        if ($post->post_status !== 'publish') return new WP_Error('not_published', __('Publish the content before generating its shortlink.', 'shortlinker'));
        if (!current_user_can('edit_post', $post_id) || !$this->can_configure()) return new WP_Error('forbidden', __('Permission denied.', 'shortlinker'));
        $existing = get_post_meta($post_id, self::META_ID, true);
        if ($existing && !$replace) return array('id' => $existing, 'shortUrl' => get_post_meta($post_id, self::META_URL, true));
        if ($existing && $replace) {
            $deleted = $this->api('DELETE', 'links/' . rawurlencode($existing));
            $delete_error = is_wp_error($deleted) ? (array) $deleted->get_error_data() : array();
            if (is_wp_error($deleted) && (int) ($delete_error['status'] ?? 0) !== 404) return $deleted;
        }
        $settings = $this->settings();
        $tags = array_values(array_filter(array_map('trim', explode(',', $settings['tags']))));
        $tags[] = 'wp:' . $post->post_type;
        $response = $this->api('POST', 'links', array(
            'domain' => $settings['domain'],
            'destination' => get_permalink($post),
            'redirectType' => (int) $settings['redirect_type'],
            'tags' => array_values(array_unique($tags)),
        ));
        if (is_wp_error($response)) return $response;
        $data = isset($response['data']) ? $response['data'] : array();
        if (empty($data['id']) || empty($data['shortUrl'])) return new WP_Error('bad_response', __('Incomplete API response.', 'shortlinker'));
        update_post_meta($post_id, self::META_ID, sanitize_text_field($data['id']));
        update_post_meta($post_id, self::META_URL, esc_url_raw($data['shortUrl']));
        update_post_meta($post_id, self::META_CLICKS, 0);
        update_post_meta($post_id, self::META_STATS, array('clicks' => 0, 'unique_visitors' => 0, 'humans' => 0, 'robots' => 0, 'countries' => array(), 'timeline' => array(), 'browsers' => array(), 'devices' => array(), 'referrers' => array()));
        update_post_meta($post_id, self::META_SYNCED, time());
        return $data;
    }

    public function add_meta_boxes() {
        if (!$this->can_configure()) return;
        foreach ($this->selected_post_types() as $post_type) {
            if (function_exists('use_block_editor_for_post_type') && use_block_editor_for_post_type($post_type)) continue;
            add_meta_box('shortlinker', __('Shortlinker', 'shortlinker'), array($this, 'meta_box'), $post_type, 'side', 'high', array('__block_editor_compatible_meta_box' => true));
        }
    }

    public function meta_box($post) {
        $url = get_post_meta($post->ID, self::META_URL, true);
        $clicks = (int) get_post_meta($post->ID, self::META_CLICKS, true);
        echo '<div class="shortlinker-box" data-shortlinker-post="' . esc_attr($post->ID) . '">';
        echo '<div class="shortlinker-result">';
        if ($url) echo '<a class="shortlinker-url" href="' . esc_url($url) . '" target="_blank" rel="noopener">' . esc_html($url) . '</a><p><strong>' . esc_html(number_format_i18n($clicks)) . '</strong> ' . esc_html__('clicks', 'shortlinker') . '</p>';
        else echo '<p>' . esc_html__('No shortlink yet.', 'shortlinker') . '</p>';
        echo '</div><button type="button" class="button button-primary shortlinker-generate" data-replace="' . ($url ? '1' : '0') . '"' . ($post->post_status !== 'publish' ? ' disabled' : '') . '>';
        echo $url ? esc_html__('Regenerate', 'shortlinker') : esc_html__('Generate shortlink', 'shortlinker');
        echo '</button>';
        if ($post->post_status !== 'publish') echo '<p class="description">' . esc_html__('Publish this content first.', 'shortlinker') . '</p>';
        echo '<div class="shortlinker-message" role="status"></div></div>';
    }

    public function ajax_generate() {
        check_ajax_referer('shortlinker_editor', 'nonce');
        $post_id = isset($_POST['postId']) ? absint($_POST['postId']) : 0;
        $replace = !empty($_POST['replace']);
        $result = $this->generate_for_post($post_id, $replace);
        if (is_wp_error($result)) wp_send_json_error(array('message' => $result->get_error_message()), 400);
        wp_send_json_success(array('url' => $result['shortUrl'], 'clicks' => 0));
    }

    public function add_column($columns) {
        if (!$this->can_configure()) return $columns;
        $columns['shortlinker'] = __('Shortlink', 'shortlinker');
        return $columns;
    }

    public function render_column($column, $post_id) {
        if ($column !== 'shortlinker') return;
        $url = get_post_meta($post_id, self::META_URL, true);
        if (!$url) { echo '<span aria-hidden="true">—</span>'; return; }
        $clicks = (int) get_post_meta($post_id, self::META_CLICKS, true);
        echo '<a href="' . esc_url($url) . '" target="_blank" rel="noopener"><code>' . esc_html(wp_parse_url($url, PHP_URL_PATH)) . '</code></a><br><strong>' . esc_html(number_format_i18n($clicks)) . '</strong> ' . esc_html__('clicks', 'shortlinker');
    }

    private function refresh_stats_batch($post_ids) {
        $link_to_post = array();
        foreach ($post_ids as $post_id) {
            $link_id = (string) get_post_meta($post_id, self::META_ID, true);
            if ($link_id) $link_to_post[$link_id] = (int) $post_id;
        }
        if (!$link_to_post) return array('links' => array(), 'countries' => array(), 'timeline' => array(), 'browsers' => array(), 'devices' => array(), 'referrers' => array());
        $cache_key = 'shortlinker_stats_' . md5(implode('|', array_keys($link_to_post)));
        $cached = get_transient($cache_key);
        if (is_array($cached)) return $cached;
        $response = $this->api('POST', 'stats/batch', array('ids' => array_keys($link_to_post)));
        if (is_wp_error($response)) return $response;
        $data = isset($response['data']) && is_array($response['data']) ? $response['data'] : array();
        foreach ((array) ($data['links'] ?? array()) as $stats) {
            $link_id = (string) ($stats['id'] ?? '');
            if (!$link_id || !isset($link_to_post[$link_id])) continue;
            $post_id = $link_to_post[$link_id];
            update_post_meta($post_id, self::META_CLICKS, (int) ($stats['clicks'] ?? 0));
            update_post_meta($post_id, self::META_STATS, $stats);
            update_post_meta($post_id, self::META_SYNCED, time());
        }
        set_transient($cache_key, $data, 5 * MINUTE_IN_SECONDS);
        return $data;
    }

    private function bulk_post_type() {
        $post_type = sanitize_key(wp_unslash($_POST['postType'] ?? 'post'));
        return in_array($post_type, $this->selected_post_types(), true) ? $post_type : '';
    }

    private function missing_shortlink_count($post_type) {
        global $wpdb;
        return (int) $wpdb->get_var($wpdb->prepare(
            "SELECT COUNT(*) FROM {$wpdb->posts} p
             WHERE p.post_type = %s AND p.post_status = 'publish'
             AND NOT EXISTS (
                SELECT 1 FROM {$wpdb->postmeta} pm WHERE pm.post_id = p.ID AND pm.meta_key = %s
             )",
            $post_type,
            self::META_ID
        ));
    }

    public function ajax_bulk_status() {
        if (!current_user_can('manage_options')) wp_send_json_error(array('message' => __('Administrators only.', 'shortlinker')), 403);
        check_ajax_referer('shortlinker_bulk', 'nonce');
        $post_type = $this->bulk_post_type();
        if (!$post_type) wp_send_json_error(array('message' => __('Invalid content type.', 'shortlinker')), 400);
        $counts = wp_count_posts($post_type);
        $published = isset($counts->publish) ? (int) $counts->publish : 0;
        $missing = $this->missing_shortlink_count($post_type);
        wp_send_json_success(array('published' => $published, 'missing' => $missing, 'linked' => max(0, $published - $missing)));
    }

    public function ajax_bulk_batch() {
        if (!current_user_can('manage_options')) wp_send_json_error(array('message' => __('Administrators only.', 'shortlinker')), 403);
        check_ajax_referer('shortlinker_bulk', 'nonce');
        $post_type = $this->bulk_post_type();
        if (!$post_type) wp_send_json_error(array('message' => __('Invalid content type.', 'shortlinker')), 400);
        $after_id = isset($_POST['afterId']) ? absint($_POST['afterId']) : 0;
        $limit = isset($_POST['limit']) ? min(50, max(1, absint($_POST['limit']))) : 50;
        global $wpdb;
        $post_ids = $wpdb->get_col($wpdb->prepare(
            "SELECT p.ID FROM {$wpdb->posts} p
             WHERE p.post_type = %s AND p.post_status = 'publish' AND p.ID > %d
             AND NOT EXISTS (
                SELECT 1 FROM {$wpdb->postmeta} pm WHERE pm.post_id = p.ID AND pm.meta_key = %s
             )
             ORDER BY p.ID ASC LIMIT %d",
            $post_type,
            $after_id,
            self::META_ID,
            $limit
        ));
        $items = array(); $created = 0; $failed = 0; $cursor = $after_id; $payload = array(); $post_map = array();
        $settings = $this->settings();
        $tags = array_values(array_filter(array_map('trim', explode(',', $settings['tags']))));
        foreach ($post_ids as $raw_post_id) {
            $post_id = (int) $raw_post_id;
            $cursor = max($cursor, $post_id);
            $title = get_the_title($post_id);
            if (!current_user_can('edit_post', $post_id)) {
                $failed++;
                $items[] = array('status' => 'error', 'id' => $post_id, 'title' => $title, 'message' => __('Permission denied.', 'shortlinker'));
                continue;
            }
            $reference = (string) $post_id;
            $post_map[$reference] = array('id' => $post_id, 'title' => $title);
            $payload[] = array(
                'reference' => $reference, 'domain' => $settings['domain'], 'destination' => get_permalink($post_id),
                'redirectType' => (int) $settings['redirect_type'],
                'tags' => array_values(array_unique(array_merge($tags, array('wp:' . $post_type)))),
            );
        }
        if ($payload) {
            $idempotency_key = 'wp-bulk-' . hash('sha256', wp_json_encode($payload));
            $response = $this->api('POST', 'links/batch', array('links' => $payload), $idempotency_key);
            if (is_wp_error($response)) wp_send_json_error(array('message' => $response->get_error_message()), 502);
            $results = (array) ($response['data']['items'] ?? array());
            foreach ($results as $result) {
                $reference = (string) ($result['reference'] ?? '');
                if (!isset($post_map[$reference])) continue;
                $post = $post_map[$reference];
                unset($post_map[$reference]);
                if (($result['status'] ?? '') !== 'success' || empty($result['data']['id']) || empty($result['data']['shortUrl'])) {
                    $failed++;
                    $items[] = array('status' => 'error', 'id' => $post['id'], 'title' => $post['title'], 'message' => (string) ($result['message'] ?? __('Incomplete API response.', 'shortlinker')));
                    continue;
                }
                $data = $result['data'];
                update_post_meta($post['id'], self::META_ID, sanitize_text_field($data['id']));
                update_post_meta($post['id'], self::META_URL, esc_url_raw($data['shortUrl']));
                update_post_meta($post['id'], self::META_CLICKS, 0);
                update_post_meta($post['id'], self::META_STATS, array('clicks' => 0, 'unique_visitors' => 0, 'humans' => 0, 'robots' => 0));
                update_post_meta($post['id'], self::META_SYNCED, time());
                $created++;
                $items[] = array('status' => 'success', 'id' => $post['id'], 'title' => $post['title'], 'url' => $data['shortUrl']);
            }
            foreach ($post_map as $post) {
                $failed++;
                $items[] = array('status' => 'error', 'id' => $post['id'], 'title' => $post['title'], 'message' => __('Incomplete API response.', 'shortlinker'));
            }
        }
        wp_send_json_success(array(
            'items' => $items, 'processed' => count($post_ids), 'created' => $created,
            'failed' => $failed, 'cursor' => $cursor, 'finished' => count($post_ids) === 0,
        ));
    }

    public function register_dashboard_widget() {
        if (!$this->can_view_stats()) return;
        wp_add_dashboard_widget('shortlinker_dashboard', __('Shortlinker overview', 'shortlinker'), array($this, 'dashboard_widget'));
    }

    public function dashboard_widget() {
        global $wpdb;
        $post_types = $this->selected_post_types();
        if (!$post_types) {
            echo '<p>' . esc_html__('No content type is enabled in Shortlinker settings.', 'shortlinker') . '</p>';
            return;
        }
        $placeholders = implode(',', array_fill(0, count($post_types), '%s'));
        $summary_sql = "SELECT COUNT(DISTINCT p.ID) AS shortlinks,
            COALESCE(SUM(CAST(clicks.meta_value AS UNSIGNED)), 0) AS clicks,
            MAX(CAST(synced.meta_value AS UNSIGNED)) AS last_sync
            FROM {$wpdb->posts} p
            INNER JOIN {$wpdb->postmeta} ids ON ids.post_id = p.ID AND ids.meta_key = %s
            LEFT JOIN {$wpdb->postmeta} clicks ON clicks.post_id = p.ID AND clicks.meta_key = %s
            LEFT JOIN {$wpdb->postmeta} synced ON synced.post_id = p.ID AND synced.meta_key = %s
            WHERE p.post_status = 'publish' AND p.post_type IN ({$placeholders})";
        $summary_args = array_merge(array(self::META_ID, self::META_CLICKS, self::META_SYNCED), $post_types);
        $summary = $wpdb->get_row($wpdb->prepare($summary_sql, $summary_args));
        $top_sql = "SELECT p.ID, p.post_title, url.meta_value AS short_url, CAST(clicks.meta_value AS UNSIGNED) AS clicks
            FROM {$wpdb->posts} p
            INNER JOIN {$wpdb->postmeta} ids ON ids.post_id = p.ID AND ids.meta_key = %s
            INNER JOIN {$wpdb->postmeta} url ON url.post_id = p.ID AND url.meta_key = %s
            LEFT JOIN {$wpdb->postmeta} clicks ON clicks.post_id = p.ID AND clicks.meta_key = %s
            WHERE p.post_status = 'publish' AND p.post_type IN ({$placeholders})
            ORDER BY CAST(clicks.meta_value AS UNSIGNED) DESC, p.ID DESC LIMIT 5";
        $top_args = array_merge(array(self::META_ID, self::META_URL, self::META_CLICKS), $post_types);
        $top = $wpdb->get_results($wpdb->prepare($top_sql, $top_args));
        $last_sync = !empty($summary->last_sync) ? sprintf(__('%s ago', 'shortlinker'), human_time_diff((int) $summary->last_sync, time())) : __('Never', 'shortlinker');
        echo '<div class="shortlinker-dashboard-metrics"><div><strong>' . esc_html(number_format_i18n((int) ($summary->shortlinks ?? 0))) . '</strong><span>' . esc_html__('Shortlinks', 'shortlinker') . '</span></div><div><strong>' . esc_html(number_format_i18n((int) ($summary->clicks ?? 0))) . '</strong><span>' . esc_html__('Clicks', 'shortlinker') . '</span></div><div><strong>' . esc_html($last_sync) . '</strong><span>' . esc_html__('Last statistics sync', 'shortlinker') . '</span></div></div>';
        echo '<h3>' . esc_html__('Top content', 'shortlinker') . '</h3><ol class="shortlinker-dashboard-top">';
        foreach ($top as $item) echo '<li><a href="' . esc_url(get_edit_post_link($item->ID)) . '">' . esc_html($item->post_title ?: __('Untitled', 'shortlinker')) . '</a><strong>' . esc_html(number_format_i18n((int) $item->clicks)) . '</strong></li>';
        if (!$top) echo '<li>' . esc_html__('No shortlink generated yet.', 'shortlinker') . '</li>';
        echo '</ol><p><a class="button button-primary" href="' . esc_url(admin_url('admin.php?page=shortlinker-stats')) . '">' . esc_html__('View full statistics', 'shortlinker') . '</a></p>';
    }

    public function settings_page() {
        if (!$this->can_configure()) wp_die(esc_html__('Permission denied.', 'shortlinker'), '', array('response' => 403));
        $tab = sanitize_key($_GET['tab'] ?? 'connection');
        if (!current_user_can('manage_options') && in_array($tab, array('access', 'danger'), true)) $tab = 'connection';
        $settings = $this->settings();
        echo '<div class="wrap shortlinker-admin"><div class="shortlinker-hero"><div><span>SHURL.BE / WORDPRESS</span><h1>' . esc_html__('Shortlinker', 'shortlinker') . '</h1><p>' . esc_html__('Create, distribute and understand every shortlink without leaving WordPress.', 'shortlinker') . '</p></div><div class="shortlinker-bolt">↗</div></div>';
        $this->notice();
        $tabs = array('connection' => __('Connection', 'shortlinker'), 'content' => __('Content & defaults', 'shortlinker'));
        if (current_user_can('manage_options')) { $tabs['access'] = __('Access', 'shortlinker'); $tabs['danger'] = __('Danger zone', 'shortlinker'); }
        echo '<nav class="nav-tab-wrapper">';
        foreach ($tabs as $key => $label) echo '<a class="nav-tab ' . ($tab === $key ? 'nav-tab-active' : '') . '" href="' . esc_url(add_query_arg(array('page' => 'shortlinker', 'tab' => $key), admin_url('options-general.php'))) . '">' . esc_html($label) . '</a>';
        echo '</nav><div class="shortlinker-panel">';
        if ($tab === 'connection') $this->connection_tab($settings);
        elseif ($tab === 'content') $this->content_tab($settings);
        elseif ($tab === 'access') $this->access_tab($settings);
        elseif ($tab === 'danger') $this->danger_tab();
        echo '</div></div>';
    }

    public function statistics_page() {
        if (!$this->can_view_stats()) wp_die(esc_html__('Permission denied.', 'shortlinker'), '', array('response' => 403));
        echo '<div class="wrap shortlinker-admin shortlinker-stats-page"><div class="shortlinker-hero"><div><span>SHURL.BE / ANALYTICS</span><h1>' . esc_html__('Shortlinker Stats', 'shortlinker') . '</h1><p>' . esc_html__('Full-width performance intelligence for connected WordPress content.', 'shortlinker') . '</p></div><div class="shortlinker-bolt">↗</div></div>';
        $this->notice();
        $this->statistics_tab();
        echo '</div>';
    }

    private function notice() {
        if (empty($_GET['sl_message'])) return;
        $class = ($_GET['sl_notice'] ?? '') === 'error' ? 'notice-error' : 'notice-success';
        echo '<div class="notice ' . esc_attr($class) . ' is-dismissible"><p>' . esc_html(wp_unslash($_GET['sl_message'])) . '</p></div>';
    }

    private function connection_tab($settings) {
        $status = $this->api('GET', 'domains');
        $update = $this->update_manifest();
        echo '<h2>' . esc_html__('API connection', 'shortlinker') . '</h2><p>' . esc_html__('Create a dedicated client in shurl.be > API clients, copy its WordPress connection block and paste it below.', 'shortlinker') . '</p>';
        if (!empty($settings['token']) && !is_wp_error($status)) echo '<div class="shortlinker-status is-up">● ' . esc_html(sprintf(__('Connected to %s', 'shortlinker'), $settings['domain'])) . '</div>';
        elseif (!empty($settings['token'])) echo '<div class="shortlinker-status is-down">● ' . esc_html($status->get_error_message()) . '</div>';
        else echo '<div class="shortlinker-status">○ ' . esc_html__('Not configured', 'shortlinker') . '</div>';
        echo '<form method="post">'; wp_nonce_field('shortlinker_settings');
        echo '<input type="hidden" name="shortlinker_action" value="connection"><label for="connection_json"><strong>' . esc_html__('Connection block', 'shortlinker') . '</strong></label><textarea class="large-text code" rows="9" id="connection_json" name="connection_json" placeholder=\'{"version":1,"apiBase":"https://shurl.be/api/v1","token":"…","domain":"shurl.be"}\'></textarea>';
        submit_button(__('Save and test connection', 'shortlinker'));
        echo '</form>';
        echo '<hr><h2>' . esc_html__('Plugin updates', 'shortlinker') . '</h2><p><strong>' . esc_html(sprintf(__('Installed: %s', 'shortlinker'), self::VERSION)) . '</strong>';
        if (!is_wp_error($update) && !empty($update['version'])) echo ' · ' . esc_html(sprintf(__('Latest: %s', 'shortlinker'), $update['version']));
        echo '</p>';
        if (!is_wp_error($update) && version_compare(self::VERSION, $update['version'], '<')) echo '<div class="shortlinker-status is-down">' . esc_html__('An update is available from the WordPress Plugins page.', 'shortlinker') . '</div>';
        elseif (!is_wp_error($update)) echo '<div class="shortlinker-status is-up">' . esc_html__('The plugin is up to date.', 'shortlinker') . '</div>';
        else echo '<div class="shortlinker-status is-down">' . esc_html($update->get_error_message()) . '</div>';
        echo '<form method="post" action="' . esc_url(admin_url('admin-post.php')) . '">'; wp_nonce_field('shortlinker_check_update');
        echo '<input type="hidden" name="action" value="shortlinker_check_update"><button class="button">' . esc_html__('Check for updates now', 'shortlinker') . '</button></form>';
    }

    private function content_tab($settings) {
        echo '<h2>' . esc_html__('Content types and defaults', 'shortlinker') . '</h2><form method="post">'; wp_nonce_field('shortlinker_settings');
        echo '<input type="hidden" name="shortlinker_action" value="content"><fieldset><legend class="screen-reader-text">' . esc_html__('Content types', 'shortlinker') . '</legend>';
        foreach ($this->public_post_types() as $type) {
            $object = get_post_type_object($type);
            echo '<label class="shortlinker-check"><input type="checkbox" name="post_types[]" value="' . esc_attr($type) . '" ' . checked(in_array($type, (array) $settings['post_types'], true), true, false) . '> <strong>' . esc_html($object->labels->name) . '</strong> <code>' . esc_html($type) . '</code></label>';
        }
        echo '</fieldset><table class="form-table"><tr><th><label for="redirect_type">' . esc_html__('Default redirect', 'shortlinker') . '</label></th><td><select id="redirect_type" name="redirect_type">';
        foreach (array(302, 307, 301, 308) as $code) echo '<option value="' . esc_attr($code) . '" ' . selected((int) $settings['redirect_type'], $code, false) . '>' . esc_html($code) . '</option>';
        echo '</select><p class="description">' . esc_html__('302 is recommended for editable content.', 'shortlinker') . '</p></td></tr><tr><th><label for="tags">' . esc_html__('Default tags', 'shortlinker') . '</label></th><td><input class="regular-text" id="tags" name="tags" value="' . esc_attr($settings['tags']) . '"><p class="description">' . esc_html__('Comma-separated; a wp:post-type tag is added automatically.', 'shortlinker') . '</p></td></tr></table>';
        submit_button(__('Save defaults', 'shortlinker')); echo '</form>';
    }

    private function danger_tab() {
        if (!current_user_can('manage_options')) return;
        echo '<div class="shortlinker-danger" data-shortlinker-bulk><h2>' . esc_html__('Bulk generation', 'shortlinker') . '</h2><p>' . esc_html__('Processes every published item without a shortlink in small background requests. Keep this page open while it runs. You can stop safely after the current batch and restart later.', 'shortlinker') . '</p><div class="shortlinker-bulk-controls"><label><strong>' . esc_html__('Content type', 'shortlinker') . '</strong> <select data-shortlinker-bulk-type>';
        foreach ($this->selected_post_types() as $type) { $object = get_post_type_object($type); echo '<option value="' . esc_attr($type) . '">' . esc_html($object->labels->name) . '</option>'; }
        echo '</select></label><button type="button" class="button button-danger" data-shortlinker-bulk-start>' . esc_html__('Generate all missing shortlinks', 'shortlinker') . '</button><button type="button" class="button" data-shortlinker-bulk-stop disabled>' . esc_html__('Stop', 'shortlinker') . '</button></div>';
        echo '<div class="shortlinker-bulk-summary"><strong data-shortlinker-bulk-status>' . esc_html__('Counting eligible content…', 'shortlinker') . '</strong><span data-shortlinker-bulk-numbers>0 / 0</span></div><progress class="shortlinker-bulk-progress" value="0" max="100">0%</progress>';
        echo '<div class="shortlinker-terminal" data-shortlinker-bulk-log role="log" aria-live="polite"><div>[Shortlinker] ' . esc_html__('Ready.', 'shortlinker') . '</div></div></div>';
    }

    private function access_tab($settings) {
        if (!current_user_can('manage_options')) return;
        $users = get_users(array('orderby' => 'display_name', 'exclude' => array(get_current_user_id())));
        $roles = wp_roles()->roles;
        echo '<h2>' . esc_html__('Delegated access', 'shortlinker') . '</h2><p>' . esc_html__('Grant configuration/editor access and statistics access independently, by WordPress role or individual user. Administrators always retain both.', 'shortlinker') . '</p><form method="post">'; wp_nonce_field('shortlinker_settings');
        echo '<input type="hidden" name="shortlinker_action" value="access"><div class="shortlinker-access-grid">';
        foreach (array('config' => __('Configuration and editor', 'shortlinker'), 'stats' => __('Statistics page', 'shortlinker')) as $area => $title) {
            echo '<section><h3>' . esc_html($title) . '</h3><h4>' . esc_html__('Roles', 'shortlinker') . '</h4>';
            foreach ($roles as $role_key => $role) {
                if ($role_key === 'administrator') continue;
                echo '<label class="shortlinker-check"><input type="checkbox" name="' . esc_attr($area) . '_roles[]" value="' . esc_attr($role_key) . '" ' . checked(in_array($role_key, (array) $settings[$area . '_roles'], true), true, false) . '> <span><strong>' . esc_html(translate_user_role($role['name'])) . '</strong><small>' . esc_html($role_key) . '</small></span></label>';
            }
            echo '<h4>' . esc_html__('Individual users', 'shortlinker') . '</h4>';
            foreach ($users as $user) {
                if (user_can($user, 'manage_options')) continue;
                echo '<label class="shortlinker-check"><input type="checkbox" name="' . esc_attr($area) . '_users[]" value="' . esc_attr($user->ID) . '" ' . checked(in_array((int) $user->ID, array_map('intval', (array) $settings[$area . '_users']), true), true, false) . '> <span><strong>' . esc_html($user->display_name) . '</strong><small>' . esc_html($user->user_email) . '</small></span></label>';
            }
            echo '</section>';
        }
        echo '</div>'; submit_button(__('Save access', 'shortlinker')); echo '</form>';
    }

    private function statistics_tab() {
        $query = new WP_Query(array('post_type' => $this->selected_post_types(), 'post_status' => 'publish', 'posts_per_page' => 100, 'meta_key' => self::META_ID, 'orderby' => 'meta_value', 'no_found_rows' => true));
        $rows = array(); $total = $humans = $robots = 0; $countries = $timeline = $browsers = $devices = $referrers = array();
        $batch = $this->refresh_stats_batch(wp_list_pluck($query->posts, 'ID'));
        $sync_error = is_wp_error($batch) ? $batch->get_error_message() : '';
        if (is_wp_error($batch)) $batch = array();
        $stats_by_id = array();
        foreach ((array) ($batch['links'] ?? array()) as $stats) if (!empty($stats['id'])) $stats_by_id[(string) $stats['id']] = $stats;
        foreach ((array) ($batch['countries'] ?? array()) as $item) { $name = $item['country_code'] ?: '—'; $countries[$name] = (int) $item['clicks']; }
        foreach ((array) ($batch['timeline'] ?? array()) as $item) $timeline[$item['day']] = (int) $item['clicks'];
        foreach (array('browsers' => &$browsers, 'devices' => &$devices, 'referrers' => &$referrers) as $key => &$bucket) {
            foreach ((array) ($batch[$key] ?? array()) as $item) {
                $name = $item['name'] ?: __('Unknown', 'shortlinker');
                if ($name === 'Unknown') $name = __('Unknown', 'shortlinker');
                elseif ($name === 'Direct') $name = __('Direct', 'shortlinker');
                $bucket[$name] = (int) $item['clicks'];
            }
        }
        unset($bucket);
        foreach ($query->posts as $post) {
            $link_id = (string) get_post_meta($post->ID, self::META_ID, true);
            $data = $stats_by_id[$link_id] ?? (array) get_post_meta($post->ID, self::META_STATS, true);
            if (!$data) $data = array('clicks' => get_post_meta($post->ID, self::META_CLICKS, true));
            $clicks = (int) ($data['clicks'] ?? 0); $total += $clicks; $humans += (int) ($data['humans'] ?? 0); $robots += (int) ($data['robots'] ?? 0);
            $rows[] = array($post, get_post_meta($post->ID, self::META_URL, true), $clicks, (int) ($data['unique_visitors'] ?? 0), (int) ($data['humans'] ?? 0), (int) ($data['robots'] ?? 0));
        }
        arsort($countries); arsort($browsers); arsort($devices); arsort($referrers); ksort($timeline);
        if ($sync_error) echo '<div class="notice notice-warning inline"><p>' . esc_html(sprintf(__('Live statistics could not be refreshed: %s. Cached data is displayed.', 'shortlinker'), $sync_error)) . '</p></div>';
        echo '<div class="shortlinker-metrics"><div><span>' . esc_html__('Shortlinks', 'shortlinker') . '</span><strong>' . esc_html(count($rows)) . '</strong></div><div><span>' . esc_html__('Clicks', 'shortlinker') . '</span><strong>' . esc_html(number_format_i18n($total)) . '</strong></div><div><span>' . esc_html__('Humans', 'shortlinker') . '</span><strong>' . esc_html(number_format_i18n($humans)) . '</strong></div><div><span>' . esc_html__('Robots', 'shortlinker') . '</span><strong>' . esc_html(number_format_i18n($robots)) . '</strong></div></div>';
        $maximum = max(array_merge(array(1), array_values($timeline)));
        echo '<section class="shortlinker-timeline"><div><h2>' . esc_html__('Last 30 days', 'shortlinker') . '</h2><p>' . esc_html__('Daily clicks aggregated across connected content.', 'shortlinker') . '</p></div><div class="shortlinker-chart" aria-label="' . esc_attr__('Daily click chart', 'shortlinker') . '">';
        foreach ($timeline as $day => $clicks) echo '<span style="height:' . esc_attr(max(5, round(($clicks / $maximum) * 100))) . '%" title="' . esc_attr($day . ': ' . $clicks) . '"></span>';
        if (!$timeline) echo '<em>' . esc_html__('No temporal data yet.', 'shortlinker') . '</em>';
        echo '</div></section><div class="shortlinker-breakdowns">';
        $this->ranked_list(__('Top countries', 'shortlinker'), $countries, __('No geographic data yet.', 'shortlinker'));
        $this->ranked_list(__('Browsers', 'shortlinker'), $browsers, __('No browser data yet.', 'shortlinker'));
        $this->ranked_list(__('Devices', 'shortlinker'), $devices, __('No device data yet.', 'shortlinker'));
        $this->ranked_list(__('Referrers', 'shortlinker'), $referrers, __('No referrer data yet.', 'shortlinker'));
        echo '</div><section class="shortlinker-performance"><h2>' . esc_html__('Shortlink performance', 'shortlinker') . '</h2><div class="shortlinker-table-wrap"><table class="widefat striped"><thead><tr><th>' . esc_html__('Content', 'shortlinker') . '</th><th>' . esc_html__('Shortlink', 'shortlinker') . '</th><th>' . esc_html__('Clicks', 'shortlinker') . '</th><th>' . esc_html__('Unique', 'shortlinker') . '</th><th>' . esc_html__('Human / robot', 'shortlinker') . '</th></tr></thead><tbody>';
        foreach ($rows as $row) echo '<tr><td><a href="' . esc_url(get_edit_post_link($row[0]->ID)) . '">' . esc_html(get_the_title($row[0])) . '</a><br><small>' . esc_html($row[0]->post_type) . '</small></td><td><a href="' . esc_url($row[1]) . '" target="_blank" rel="noopener"><code>' . esc_html($row[1]) . '</code></a></td><td><strong>' . esc_html(number_format_i18n($row[2])) . '</strong></td><td>' . esc_html(number_format_i18n($row[3])) . '</td><td>' . esc_html(number_format_i18n($row[4])) . ' / ' . esc_html(number_format_i18n($row[5])) . '</td></tr>';
        if (!$rows) echo '<tr><td colspan="5">' . esc_html__('No shortlinks have been generated yet.', 'shortlinker') . '</td></tr>';
        echo '</tbody></table></div></section>';
    }

    private function ranked_list($title, $values, $empty) {
        echo '<section><h2>' . esc_html($title) . '</h2><ol class="shortlinker-countries">';
        foreach (array_slice($values, 0, 10, true) as $name => $clicks) echo '<li><span title="' . esc_attr($name) . '">' . esc_html($name) . '</span><strong>' . esc_html(number_format_i18n($clicks)) . '</strong></li>';
        if (!$values) echo '<li>' . esc_html($empty) . '</li>';
        echo '</ol></section>';
    }

    private function update_manifest($force = false) {
        $cache_key = 'shortlinker_wordpress_update_manifest';
        if (!$force) {
            $cached = get_site_transient($cache_key);
            if (is_array($cached)) return $cached;
        }
        $response = wp_remote_get(self::UPDATE_MANIFEST, array('timeout' => 10, 'headers' => array('Accept' => 'application/json')));
        if (is_wp_error($response)) return $response;
        if (wp_remote_retrieve_response_code($response) !== 200) return new WP_Error('update_http', __('Unable to retrieve Shortlinker update information.', 'shortlinker'));
        $manifest = json_decode(wp_remote_retrieve_body($response), true);
        if (!is_array($manifest) || empty($manifest['version']) || empty($manifest['download_url'])) return new WP_Error('update_manifest', __('Invalid Shortlinker update information.', 'shortlinker'));
        set_site_transient($cache_key, $manifest, 12 * HOUR_IN_SECONDS);
        return $manifest;
    }

    public function plugin_updates($transient) {
        if (!is_object($transient) || empty($transient->checked)) return $transient;
        $manifest = $this->update_manifest();
        if (is_wp_error($manifest) || version_compare(self::VERSION, $manifest['version'], '>=')) return $transient;
        $plugin = plugin_basename(__FILE__);
        $transient->response[$plugin] = (object) array(
            'slug' => 'shortlinker', 'plugin' => $plugin, 'new_version' => $manifest['version'],
            'url' => $manifest['homepage'], 'package' => $manifest['download_url'],
            'tested' => $manifest['tested'] ?? '', 'requires_php' => $manifest['requires_php'] ?? '7.4',
        );
        return $transient;
    }

    public function plugin_information($result, $action, $args) {
        if ($action !== 'plugin_information' || empty($args->slug) || $args->slug !== 'shortlinker') return $result;
        $manifest = $this->update_manifest();
        if (is_wp_error($manifest)) return $result;
        return (object) array(
            'name' => 'Shortlinker', 'slug' => 'shortlinker', 'version' => $manifest['version'],
            'author' => '<a href="https://jessysystem.com/">Jessy System</a>',
            'homepage' => $manifest['homepage'], 'download_link' => $manifest['download_url'],
            'requires' => $manifest['requires'] ?? '6.5', 'requires_php' => $manifest['requires_php'] ?? '7.4',
            'tested' => $manifest['tested'] ?? '',
            'sections' => array('description' => $manifest['description'] ?? '', 'changelog' => $manifest['changelog'] ?? ''),
        );
    }

    public function check_update_now() {
        if (!$this->can_configure()) wp_die(esc_html__('Permission denied.', 'shortlinker'), '', array('response' => 403));
        check_admin_referer('shortlinker_check_update');
        delete_site_transient('shortlinker_wordpress_update_manifest');
        delete_site_transient('update_plugins');
        $manifest = $this->update_manifest(true);
        $message = is_wp_error($manifest) ? $manifest->get_error_message() : (version_compare(self::VERSION, $manifest['version'], '<') ? sprintf(__('Version %s is available.', 'shortlinker'), $manifest['version']) : __('The plugin is up to date.', 'shortlinker'));
        $this->redirect_notice(is_wp_error($manifest) ? 'error' : 'updated', $message, 'connection');
    }
}

Shortlinker_WordPress::boot();
