<?php
/**
 * Plugin Name: Shortlinker
 * Plugin URI: https://shurl.be/
 * Description: Generate and monitor shurl.be shortlinks directly from WordPress.
 * Version: 1.0.0
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
    const VERSION = '1.0.0';
    const OPTION = 'shortlinker_settings';
    const CAPABILITY = 'manage_shortlinker';
    const META_ID = '_shortlinker_id';
    const META_URL = '_shortlinker_url';
    const META_CLICKS = '_shortlinker_clicks';
    const META_SYNCED = '_shortlinker_synced_at';
    const META_STATS = '_shortlinker_stats';

    public static function boot() {
        $plugin = new self();
        register_activation_hook(__FILE__, array($plugin, 'activate'));
        register_deactivation_hook(__FILE__, array($plugin, 'deactivate'));
        add_action('admin_menu', array($plugin, 'admin_menu'));
        add_action('admin_init', array($plugin, 'handle_settings'));
        add_action('init', array($plugin, 'register_list_columns'), 100);
        add_action('add_meta_boxes', array($plugin, 'add_meta_boxes'));
        add_action('admin_enqueue_scripts', array($plugin, 'enqueue_assets'));
        add_action('wp_ajax_shortlinker_generate', array($plugin, 'ajax_generate'));
        add_action('admin_post_shortlinker_bulk_generate', array($plugin, 'bulk_generate'));
    }

    public function register_list_columns() {
        foreach ($this->public_post_types() as $post_type) {
            add_filter("manage_{$post_type}_posts_columns", array($this, 'add_column'));
            add_action("manage_{$post_type}_posts_custom_column", array($this, 'render_column'), 10, 2);
        }
    }

    public function activate() {
        foreach (get_users(array('role__in' => array('administrator'))) as $user) {
            $user->add_cap(self::CAPABILITY);
        }
        if (!get_option(self::OPTION)) {
            add_option(self::OPTION, array(
                'api_base' => 'https://shurl.be/api/v1',
                'token' => '',
                'domain' => 'shurl.be',
                'post_types' => array('post', 'page'),
                'redirect_type' => 302,
                'tags' => 'wordpress',
                'allowed_users' => array(),
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
        ));
    }

    private function can_use() {
        return current_user_can('manage_options') || current_user_can(self::CAPABILITY);
    }

    private function selected_post_types() {
        $settings = $this->settings();
        return array_values(array_intersect($this->public_post_types(), (array) $settings['post_types']));
    }

    private function public_post_types() {
        return array_values(get_post_types(array('public' => true, 'show_ui' => true), 'names'));
    }

    public function admin_menu() {
        if (!$this->can_use()) return;
        if (current_user_can('manage_options') && !current_user_can(self::CAPABILITY)) {
            wp_get_current_user()->add_cap(self::CAPABILITY);
        }
        add_options_page(
            __('Shortlinker', 'shortlinker'),
            __('Shortlinker', 'shortlinker'),
            self::CAPABILITY,
            'shortlinker',
            array($this, 'settings_page')
        );
    }

    public function enqueue_assets($hook) {
        $screen = get_current_screen();
        $selected = $this->selected_post_types();
        if ($hook !== 'settings_page_shortlinker' && (!$screen || !in_array($screen->post_type, $selected, true))) return;
        wp_enqueue_style('shortlinker-admin', plugins_url('assets/admin.css', __FILE__), array(), self::VERSION);
        wp_enqueue_script('shortlinker-admin', plugins_url('assets/admin.js', __FILE__), array(), self::VERSION, true);
        wp_localize_script('shortlinker-admin', 'ShortlinkerAdmin', array(
            'ajaxUrl' => admin_url('admin-ajax.php'),
            'nonce' => wp_create_nonce('shortlinker_editor'),
            'generating' => __('Generating…', 'shortlinker'),
            'confirmRegenerate' => __('The current shortlink will stop working. Regenerate it?', 'shortlinker'),
            'error' => __('The operation failed.', 'shortlinker'),
        ));
    }

    public function handle_settings() {
        if (empty($_POST['shortlinker_action'])) return;
        if (!$this->can_use()) wp_die(esc_html__('Permission denied.', 'shortlinker'), 403);
        check_admin_referer('shortlinker_settings');
        $action = sanitize_key(wp_unslash($_POST['shortlinker_action']));
        if ($action !== 'content' && !current_user_can('manage_options')) wp_die(esc_html__('Administrators only.', 'shortlinker'), 403);
        $settings = $this->settings();

        if ($action === 'connection') {
            $raw = trim(wp_unslash(isset($_POST['connection_json']) ? $_POST['connection_json'] : ''));
            $config = json_decode($raw, true);
            if (!is_array($config) || empty($config['apiBase']) || empty($config['token']) || empty($config['domain'])) {
                $this->redirect_notice('error', __('Invalid connection block. Copy it again from Shortlinker > API clients.', 'shortlinker'));
            }
            $api_base = untrailingslashit(esc_url_raw($config['apiBase']));
            if (strpos($api_base, 'https://') !== 0 || strpos($api_base, '/api/v1') === false) {
                $this->redirect_notice('error', __('The API URL must use HTTPS and target /api/v1.', 'shortlinker'));
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
            $old_ids = array_map('intval', (array) $settings['allowed_users']);
            $new_ids = array_values(array_unique(array_map('intval', isset($_POST['allowed_users']) ? (array) $_POST['allowed_users'] : array())));
            foreach (array_unique(array_merge($old_ids, $new_ids)) as $user_id) {
                $user = get_user_by('id', $user_id);
                if (!$user || user_can($user, 'manage_options')) continue;
                if (in_array($user_id, $new_ids, true)) $user->add_cap(self::CAPABILITY);
                else $user->remove_cap(self::CAPABILITY);
            }
            $settings['allowed_users'] = $new_ids;
        }

        update_option(self::OPTION, $settings, false);
        $this->redirect_notice('updated', __('Settings saved.', 'shortlinker'));
    }

    private function redirect_notice($type, $message) {
        wp_safe_redirect(add_query_arg(array('page' => 'shortlinker', 'sl_notice' => $type, 'sl_message' => $message), admin_url('options-general.php')));
        exit;
    }

    private function api($method, $path, $body = null) {
        $settings = $this->settings();
        if (empty($settings['token'])) return new WP_Error('not_connected', __('Shortlinker is not connected.', 'shortlinker'));
        $args = array(
            'method' => $method, 'timeout' => 15,
            'headers' => array('Authorization' => 'Bearer ' . $settings['token'], 'Accept' => 'application/json'),
        );
        if ($body !== null) {
            $args['headers']['Content-Type'] = 'application/json';
            $args['headers']['Idempotency-Key'] = wp_generate_uuid4();
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
        if (!current_user_can('edit_post', $post_id) || !$this->can_use()) return new WP_Error('forbidden', __('Permission denied.', 'shortlinker'));
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
        if (!$this->can_use()) return;
        foreach ($this->selected_post_types() as $post_type) {
            add_meta_box('shortlinker', __('Shortlinker', 'shortlinker'), array($this, 'meta_box'), $post_type, 'side', 'high');
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
        if (!$this->can_use()) return $columns;
        $columns['shortlinker'] = __('Shortlink', 'shortlinker');
        return $columns;
    }

    public function render_column($column, $post_id) {
        if ($column !== 'shortlinker') return;
        $url = get_post_meta($post_id, self::META_URL, true);
        if (!$url) { echo '<span aria-hidden="true">—</span>'; return; }
        $this->refresh_post_stats($post_id);
        $clicks = (int) get_post_meta($post_id, self::META_CLICKS, true);
        echo '<a href="' . esc_url($url) . '" target="_blank" rel="noopener"><code>' . esc_html(wp_parse_url($url, PHP_URL_PATH)) . '</code></a><br><strong>' . esc_html(number_format_i18n($clicks)) . '</strong> ' . esc_html__('clicks', 'shortlinker');
    }

    private function refresh_post_stats($post_id, $force = false) {
        $id = get_post_meta($post_id, self::META_ID, true);
        $synced = (int) get_post_meta($post_id, self::META_SYNCED, true);
        if (!$id) return null;
        if (!$force && $synced > time() - 300) return (array) get_post_meta($post_id, self::META_STATS, true);
        $response = $this->api('GET', 'links/' . rawurlencode($id) . '/stats');
        if (is_wp_error($response)) return $response;
        $data = $response['data'] ?? array();
        update_post_meta($post_id, self::META_CLICKS, (int) ($data['clicks'] ?? 0));
        update_post_meta($post_id, self::META_STATS, $data);
        update_post_meta($post_id, self::META_SYNCED, time());
        return $data;
    }

    public function bulk_generate() {
        if (!current_user_can('manage_options')) wp_die(esc_html__('Administrators only.', 'shortlinker'), 403);
        check_admin_referer('shortlinker_bulk_generate');
        $post_type = sanitize_key(wp_unslash($_POST['post_type'] ?? 'post'));
        if (!in_array($post_type, $this->selected_post_types(), true)) $this->redirect_notice('error', __('Invalid content type.', 'shortlinker'));
        $query = new WP_Query(array(
            'post_type' => $post_type, 'post_status' => 'publish', 'posts_per_page' => 50, 'fields' => 'ids',
            'meta_query' => array(array('key' => self::META_ID, 'compare' => 'NOT EXISTS')),
            'orderby' => 'ID', 'order' => 'ASC', 'no_found_rows' => true,
        ));
        $created = 0; $failed = 0;
        foreach ($query->posts as $post_id) {
            $result = $this->generate_for_post($post_id, false);
            is_wp_error($result) ? $failed++ : $created++;
        }
        $this->redirect_notice($failed ? 'error' : 'updated', sprintf(__('Batch complete: %1$d created, %2$d failed. Run it again for the next 50.', 'shortlinker'), $created, $failed));
    }

    public function settings_page() {
        if (!$this->can_use()) wp_die(esc_html__('Permission denied.', 'shortlinker'), 403);
        $tab = sanitize_key($_GET['tab'] ?? 'connection');
        if (!current_user_can('manage_options') && in_array($tab, array('connection', 'access'), true)) $tab = 'statistics';
        $settings = $this->settings();
        echo '<div class="wrap shortlinker-admin"><div class="shortlinker-hero"><div><span>SHURL.BE / WORDPRESS</span><h1>' . esc_html__('Shortlinker', 'shortlinker') . '</h1><p>' . esc_html__('Create, distribute and understand every shortlink without leaving WordPress.', 'shortlinker') . '</p></div><div class="shortlinker-bolt">↗</div></div>';
        $this->notice();
        $tabs = array('connection' => __('Connection', 'shortlinker'), 'content' => __('Content & defaults', 'shortlinker'), 'statistics' => __('Statistics', 'shortlinker'));
        if (current_user_can('manage_options')) $tabs['access'] = __('Access', 'shortlinker');
        echo '<nav class="nav-tab-wrapper">';
        foreach ($tabs as $key => $label) echo '<a class="nav-tab ' . ($tab === $key ? 'nav-tab-active' : '') . '" href="' . esc_url(add_query_arg(array('page' => 'shortlinker', 'tab' => $key), admin_url('options-general.php'))) . '">' . esc_html($label) . '</a>';
        echo '</nav><div class="shortlinker-panel">';
        if ($tab === 'connection') $this->connection_tab($settings);
        elseif ($tab === 'content') $this->content_tab($settings);
        elseif ($tab === 'access') $this->access_tab($settings);
        else $this->statistics_tab();
        echo '</div></div>';
    }

    private function notice() {
        if (empty($_GET['sl_message'])) return;
        $class = ($_GET['sl_notice'] ?? '') === 'error' ? 'notice-error' : 'notice-success';
        echo '<div class="notice ' . esc_attr($class) . ' is-dismissible"><p>' . esc_html(wp_unslash($_GET['sl_message'])) . '</p></div>';
    }

    private function connection_tab($settings) {
        $status = $this->api('GET', 'domains');
        echo '<h2>' . esc_html__('API connection', 'shortlinker') . '</h2><p>' . esc_html__('Create a dedicated client in shurl.be > API clients, copy its WordPress connection block and paste it below.', 'shortlinker') . '</p>';
        if (!empty($settings['token']) && !is_wp_error($status)) echo '<div class="shortlinker-status is-up">● ' . esc_html(sprintf(__('Connected to %s', 'shortlinker'), $settings['domain'])) . '</div>';
        elseif (!empty($settings['token'])) echo '<div class="shortlinker-status is-down">● ' . esc_html($status->get_error_message()) . '</div>';
        else echo '<div class="shortlinker-status">○ ' . esc_html__('Not configured', 'shortlinker') . '</div>';
        echo '<form method="post">'; wp_nonce_field('shortlinker_settings');
        echo '<input type="hidden" name="shortlinker_action" value="connection"><label for="connection_json"><strong>' . esc_html__('Connection block', 'shortlinker') . '</strong></label><textarea class="large-text code" rows="9" id="connection_json" name="connection_json" placeholder=\'{"version":1,"apiBase":"https://shurl.be/api/v1","token":"…","domain":"shurl.be"}\'></textarea>';
        submit_button(__('Save and test connection', 'shortlinker'));
        echo '</form>';
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
        echo '</select><p class="description">302 is recommended for editable content.</p></td></tr><tr><th><label for="tags">' . esc_html__('Default tags', 'shortlinker') . '</label></th><td><input class="regular-text" id="tags" name="tags" value="' . esc_attr($settings['tags']) . '"><p class="description">' . esc_html__('Comma-separated; a wp:post-type tag is added automatically.', 'shortlinker') . '</p></td></tr></table>';
        submit_button(__('Save defaults', 'shortlinker')); echo '</form>';
        if (current_user_can('manage_options')) {
            echo '<div class="shortlinker-danger"><h2>' . esc_html__('Danger zone: bulk generation', 'shortlinker') . '</h2><p>' . esc_html__('Creates up to 50 missing shortlinks per run. This consumes API quota and cannot be undone as a batch.', 'shortlinker') . '</p><form method="post" action="' . esc_url(admin_url('admin-post.php')) . '" data-shortlinker-confirm="' . esc_attr__('Generate links for the next 50 published items?', 'shortlinker') . '">';
            wp_nonce_field('shortlinker_bulk_generate'); echo '<input type="hidden" name="action" value="shortlinker_bulk_generate"><select name="post_type">';
            foreach ($this->selected_post_types() as $type) { $object = get_post_type_object($type); echo '<option value="' . esc_attr($type) . '">' . esc_html($object->labels->name) . '</option>'; }
            echo '</select> <button class="button button-danger">' . esc_html__('Generate missing shortlinks', 'shortlinker') . '</button></form></div>';
        }
    }

    private function access_tab($settings) {
        if (!current_user_can('manage_options')) return;
        $users = get_users(array('orderby' => 'display_name', 'exclude' => array(get_current_user_id())));
        echo '<h2>' . esc_html__('Delegated access', 'shortlinker') . '</h2><p>' . esc_html__('Only administrators can change connection, access and bulk-generation settings. Selected users can use the editor tools, lists and statistics.', 'shortlinker') . '</p><form method="post">'; wp_nonce_field('shortlinker_settings');
        echo '<input type="hidden" name="shortlinker_action" value="access"><div class="shortlinker-user-grid">';
        foreach ($users as $user) {
            if (user_can($user, 'manage_options')) continue;
            echo '<label class="shortlinker-check"><input type="checkbox" name="allowed_users[]" value="' . esc_attr($user->ID) . '" ' . checked(in_array((int) $user->ID, array_map('intval', (array) $settings['allowed_users']), true), true, false) . '> <span><strong>' . esc_html($user->display_name) . '</strong><small>' . esc_html($user->user_email) . '</small></span></label>';
        }
        echo '</div>'; submit_button(__('Save access', 'shortlinker')); echo '</form>';
    }

    private function statistics_tab() {
        $query = new WP_Query(array('post_type' => $this->selected_post_types(), 'post_status' => 'publish', 'posts_per_page' => 100, 'meta_key' => self::META_ID, 'orderby' => 'meta_value', 'no_found_rows' => true));
        $rows = array(); $total = $humans = $robots = 0; $countries = $timeline = $browsers = $devices = $referrers = array();
        foreach ($query->posts as $post) {
            $data = $this->refresh_post_stats($post->ID);
            if (is_wp_error($data) || $data === null) $data = array('clicks' => get_post_meta($post->ID, self::META_CLICKS, true));
            $clicks = (int) ($data['clicks'] ?? 0); $total += $clicks; $humans += (int) ($data['humans'] ?? 0); $robots += (int) ($data['robots'] ?? 0);
            foreach ((array) ($data['countries'] ?? array()) as $country) { $code = $country['country_code'] ?: '—'; $countries[$code] = ($countries[$code] ?? 0) + (int) $country['clicks']; }
            foreach ((array) ($data['timeline'] ?? array()) as $point) { $timeline[$point['day']] = ($timeline[$point['day']] ?? 0) + (int) $point['clicks']; }
            foreach (array('browsers' => &$browsers, 'devices' => &$devices, 'referrers' => &$referrers) as $key => &$bucket) {
                foreach ((array) ($data[$key] ?? array()) as $item) { $name = $item['name'] ?: __('Unknown', 'shortlinker'); $bucket[$name] = ($bucket[$name] ?? 0) + (int) $item['clicks']; }
            }
            unset($bucket);
            $rows[] = array($post, get_post_meta($post->ID, self::META_URL, true), $clicks, (int) ($data['unique_visitors'] ?? 0), (int) ($data['humans'] ?? 0), (int) ($data['robots'] ?? 0));
        }
        arsort($countries); arsort($browsers); arsort($devices); arsort($referrers); ksort($timeline);
        echo '<div class="shortlinker-metrics"><div><span>' . esc_html__('Shortlinks', 'shortlinker') . '</span><strong>' . esc_html(count($rows)) . '</strong></div><div><span>' . esc_html__('Clicks', 'shortlinker') . '</span><strong>' . esc_html(number_format_i18n($total)) . '</strong></div><div><span>' . esc_html__('Humans', 'shortlinker') . '</span><strong>' . esc_html(number_format_i18n($humans)) . '</strong></div><div><span>' . esc_html__('Robots', 'shortlinker') . '</span><strong>' . esc_html(number_format_i18n($robots)) . '</strong></div></div>';
        $maximum = max(array_merge(array(1), array_values($timeline)));
        echo '<section class="shortlinker-timeline"><div><h2>' . esc_html__('Last 30 days', 'shortlinker') . '</h2><p>' . esc_html__('Daily clicks aggregated across connected content.', 'shortlinker') . '</p></div><div class="shortlinker-chart" aria-label="' . esc_attr__('Daily click chart', 'shortlinker') . '">';
        foreach ($timeline as $day => $clicks) echo '<span style="height:' . esc_attr(max(5, round(($clicks / $maximum) * 100))) . '%" title="' . esc_attr($day . ': ' . $clicks) . '"></span>';
        if (!$timeline) echo '<em>' . esc_html__('No temporal data yet.', 'shortlinker') . '</em>';
        echo '</div></section><div class="shortlinker-stats-grid"><div><h2>' . esc_html__('Shortlink performance', 'shortlinker') . '</h2><div class="shortlinker-table-wrap"><table class="widefat striped"><thead><tr><th>' . esc_html__('Content', 'shortlinker') . '</th><th>' . esc_html__('Shortlink', 'shortlinker') . '</th><th>' . esc_html__('Clicks', 'shortlinker') . '</th><th>' . esc_html__('Unique', 'shortlinker') . '</th><th>' . esc_html__('Human / robot', 'shortlinker') . '</th></tr></thead><tbody>';
        foreach ($rows as $row) echo '<tr><td><a href="' . esc_url(get_edit_post_link($row[0]->ID)) . '">' . esc_html(get_the_title($row[0])) . '</a><br><small>' . esc_html($row[0]->post_type) . '</small></td><td><a href="' . esc_url($row[1]) . '" target="_blank" rel="noopener"><code>' . esc_html($row[1]) . '</code></a></td><td><strong>' . esc_html(number_format_i18n($row[2])) . '</strong></td><td>' . esc_html(number_format_i18n($row[3])) . '</td><td>' . esc_html(number_format_i18n($row[4])) . ' / ' . esc_html(number_format_i18n($row[5])) . '</td></tr>';
        if (!$rows) echo '<tr><td colspan="5">' . esc_html__('No shortlinks have been generated yet.', 'shortlinker') . '</td></tr>';
        echo '</tbody></table></div></div><aside>';
        $this->ranked_list(__('Top countries', 'shortlinker'), $countries, __('No geographic data yet.', 'shortlinker'));
        $this->ranked_list(__('Browsers', 'shortlinker'), $browsers, __('No browser data yet.', 'shortlinker'));
        $this->ranked_list(__('Devices', 'shortlinker'), $devices, __('No device data yet.', 'shortlinker'));
        $this->ranked_list(__('Referrers', 'shortlinker'), $referrers, __('No referrer data yet.', 'shortlinker'));
        echo '</aside></div>';
    }

    private function ranked_list($title, $values, $empty) {
        echo '<h2>' . esc_html($title) . '</h2><ol class="shortlinker-countries">';
        foreach (array_slice($values, 0, 10, true) as $name => $clicks) echo '<li><span title="' . esc_attr($name) . '">' . esc_html($name) . '</span><strong>' . esc_html(number_format_i18n($clicks)) . '</strong></li>';
        if (!$values) echo '<li>' . esc_html($empty) . '</li>';
        echo '</ol>';
    }
}

Shortlinker_WordPress::boot();
