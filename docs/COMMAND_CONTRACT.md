# Recovered native command contract

The frontend invokes the following native commands. Names and argument keys were recovered directly from the packaged JavaScript bundle. This file is the regression checklist for the reconstructed Tauri backend.

## Project and configuration

- `list_project_summaries`, `get_project_record`, `upsert_project_record`
- `rename_project_record`, `delete_project_record`, `update_project_viewport_record`
- `export_project_to_file`, `import_project_from_file`
- `get_api_key`, `set_api_key`, `get_base_url`, `set_base_url`
- `list_models`, `list_remote_models`, `register_custom_provider`, `unregister_custom_provider`

## Image and storyboard operations

- `generate_image`, `submit_generate_image_job`, `get_generate_image_job`
- `split_image_source`, `merge_storyboard_images`
- `persist_image_source`, `persist_image_binary`, `prepare_node_image_source`
- `copy_image_to_clipboard`, `copy_image_source_to_clipboard`, `save_image_to_downloads`
- `read_storyboard_image_metadata`, `embed_storyboard_image_metadata`

## Video and audio operations

- `submit_generate_video_job`, `get_generate_video_job`
- `persist_video_source`, `persist_video_binary`, `persist_audio_source`
- `compose_videos_sequential`, `extract_audio_from_video`, `get_video_duration`
- `remove_video_watermark`, `remove_video_subtitles`, `upscale_video`, `generate_tts`

## 即梦 browser workflow

- `jimeng_browser_open_login`, `jimeng_browser_generate`
- `jimeng_browser_check_env`, `jimeng_browser_install`
- `jimeng_save_sessionid`, `jimeng_check_sessionid`, `jimeng_delete_sessionid`
- `jimeng_submit_video`, `jimeng_get_video_status`, `jimeng_login_window`, `jimeng_poll_sessionid`

## Platform operations

- `get_default_save_dir`, `validate_save_dir`
- `minimize_window`, `toggle_maximize_window`, `close_window`

## Release gate

Before a public release, each command must have an automated happy-path test or an explicitly documented manual test. Tests that access paid or third-party generation services must use user-provided test credentials and must not run in CI.
