<?php
defined('WP_UNINSTALL_PLUGIN') || exit;

$settings = (array) get_option('shortlinker_settings', array());
foreach ((array) ($settings['allowed_users'] ?? array()) as $user_id) {
    $user = get_user_by('id', (int) $user_id);
    if ($user && !user_can($user, 'manage_options')) $user->remove_cap('manage_shortlinker');
}
delete_option('shortlinker_settings');
