#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use base64::{engine::general_purpose::STANDARD, Engine as _};
use chrono::Utc;
use image::{imageops::FilterType, DynamicImage, GenericImageView, RgbaImage};
use reqwest::{Client, Url};
use rusqlite::{params, Connection, OpenFlags, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    fs,
    io::Write,
    path::PathBuf,
    process::{Command, Stdio},
    sync::Mutex,
};
use tauri::{AppHandle, Manager, State, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use tauri_plugin_updater::UpdaterExt;
use uuid::Uuid;

const PROJECT_HOMEPAGE: &str = "https://github.com/xy2446522127-code/storyboard-copilot";

#[derive(Default)]
struct StoreLock(Mutex<()>);

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProjectRecord {
    id: String,
    name: String,
    nodes_json: String,
    edges_json: String,
    viewport_json: String,
    history_json: String,
    image_pool_json: String,
    node_count: u32,
    created_at: String,
    updated_at: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn agent_preview_rejects_commands_outside_the_whitelist() {
        assert!(
            validate_agent_actions(r#"[{"type":"deleteNodes","params":{"ids":["a"]}}]"#).is_ok()
        );
        assert!(
            validate_agent_actions(r#"[{"type":"runShell","params":{"command":"whoami"}}]"#)
                .is_err()
        );
    }

    #[test]
    fn canvas_node_classifier_uses_type_and_data() {
        let image =
            serde_json::json!({"id":"image-1","type":"image","data":{"imageUrl":"file.png"}});
        let video =
            serde_json::json!({"id":"video-1","type":"video","data":{"videoMode":"image2video"}});
        assert!(node_is_kind(&image, "image"));
        assert!(node_is_kind(&video, "video"));
        assert!(!node_is_kind(&image, "video"));
    }

    #[test]
    fn raw_media_is_not_allowed_in_default_chat_context() {
        assert!(sanitize_chat_context(Some(
            r#"{"selectedNodes":[{"id":"1","text":"hello"}]}"#.to_string()
        ))
        .is_ok());
        assert!(sanitize_chat_context(Some(
            r#"{"image":"data:image/png;base64,AAAA"}"#.to_string()
        ))
        .is_err());
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AssetRecord {
    id: String,
    name: String,
    category: String,
    tags: String,
    file_path: String,
    source_type: String,
    source_node_id: Option<String>,
    created_at: String,
    updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GenerationJob {
    job_id: String,
    provider_id: String,
    kind: String,
    status: String,
    progress: u8,
    result: Option<String>,
    error: Option<String>,
    remote_job_id: Option<String>,
    updated_at: String,
}

/// A chat thread is deliberately kept separate from a project export.  This keeps a
/// shared `.storyboard` file portable and makes it impossible for an export to include
/// the local API settings that are used to talk to a model.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ChatSession {
    id: String,
    project_id: Option<String>,
    title: String,
    model: String,
    created_at: String,
    updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ChatMessage {
    id: String,
    session_id: String,
    role: String,
    content: String,
    context_json: String,
    created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AgentPreview {
    id: String,
    session_id: String,
    project_id: Option<String>,
    actions_json: String,
    status: String,
    created_at: String,
    confirmed_at: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AgentExecution {
    preview: AgentPreview,
    project: ProjectRecord,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct CanvasVideoTarget {
    id: String,
    name: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct CanvasBatchPreview {
    project_id: String,
    image_node_ids: Vec<String>,
    video_targets: Vec<CanvasVideoTarget>,
    can_create_video_node: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct UpdateInfo {
    current_version: String,
    version: String,
    date: Option<String>,
    notes: Option<String>,
}

#[derive(Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AuthSession {
    #[serde(default)]
    token: String,
    #[serde(default)]
    user: Option<serde_json::Value>,
}

fn models_endpoint(base_url: &str) -> Result<Url, String> {
    let base = Url::parse(base_url.trim()).map_err(|error| format!("invalid base URL: {error}"))?;
    if !matches!(base.scheme(), "http" | "https") {
        return Err("base URL must use HTTP or HTTPS".to_string());
    }
    let mut normalized = base.to_string().trim_end_matches('/').to_string();
    if !normalized.ends_with("/v1")
        && !normalized.ends_with("/v2")
        && !normalized.ends_with("/v3")
        && !normalized.ends_with("/api/v3")
    {
        normalized.push_str("/v1");
    }
    Url::parse(&format!("{normalized}/models")).map_err(|error| error.to_string())
}

fn provider_endpoint(base_url: &str, path: &str) -> Result<Url, String> {
    let base = Url::parse(base_url.trim()).map_err(|error| format!("invalid base URL: {error}"))?;
    if !matches!(base.scheme(), "http" | "https") {
        return Err("base URL must use HTTP or HTTPS".to_string());
    }
    let mut normalized = base.to_string().trim_end_matches('/').to_string();
    if !normalized.ends_with("/v1")
        && !normalized.ends_with("/v2")
        && !normalized.ends_with("/v3")
        && !normalized.ends_with("/api/v3")
    {
        normalized.push_str("/v1");
    }
    Url::parse(&format!("{normalized}/{path}")).map_err(|error| error.to_string())
}

fn service_endpoint(app: &AppHandle, path: &str) -> Result<Url, String> {
    let settings: Settings = read_json(settings_path(app)?)?;
    let base_url = settings
        .service_base_url
        .or_else(|| settings.base_urls.get("huahai_service").cloned())
        .filter(|value| !value.trim().is_empty())
        .ok_or("The Huahai service address is not configured. Configure it in API settings before using accounts or credits.".to_string())?;
    let base = Url::parse(base_url.trim()).map_err(|error| format!("invalid service endpoint: {error}"))?;
    if !matches!(base.scheme(), "http" | "https") {
        return Err("service base URL must use HTTP or HTTPS".to_string());
    }
    let normalized = base.to_string().trim_end_matches('/').to_string();
    Url::parse(&format!("{normalized}{path}"))
        .map_err(|error| format!("invalid service endpoint: {error}"))
}

fn auth_session_from_response(value: &serde_json::Value) -> AuthSession {
    let data = value.get("data").unwrap_or(value);
    let token = data
        .get("token")
        .or_else(|| data.get("access_token"))
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default()
        .to_string();
    let user = data
        .get("user")
        .cloned()
        .or_else(|| data.get("profile").cloned());
    AuthSession { token, user }
}

async fn service_json_request(
    request: reqwest::RequestBuilder,
    action: &str,
) -> Result<serde_json::Value, String> {
    let response = request
        .send()
        .await
        .map_err(|error| format!("{action} 请求失败: {error}"))?;
    let status = response.status();
    let body = response
        .text()
        .await
        .map_err(|error| format!("{action} 响应读取失败: {error}"))?;
    if !status.is_success() {
        return Err(format!("{action} 失败 ({status}): {body}"));
    }
    serde_json::from_str(&body).map_err(|error| format!("{action} 响应不是 JSON: {error}"))
}

fn image_result_from_response(value: &serde_json::Value) -> Option<String> {
    let item = value
        .get("data")
        .and_then(serde_json::Value::as_array)
        .and_then(|items| items.first())
        .unwrap_or(value);
    for key in ["url", "result", "output", "result_url", "video_url"] {
        if let Some(result) = item.get(key).and_then(serde_json::Value::as_str) {
            return Some(result.to_string());
        }
    }
    item.get("b64_json")
        .and_then(serde_json::Value::as_str)
        .map(|encoded| format!("data:image/png;base64,{encoded}"))
}

fn remote_job_id_from_response(value: &serde_json::Value) -> Option<String> {
    for key in ["job_id", "id", "task_id"] {
        if let Some(id) = value.get(key).and_then(serde_json::Value::as_str) {
            return Some(id.to_string());
        }
    }
    value
        .get("data")
        .and_then(|data| remote_job_id_from_response(data))
}

fn response_status(value: &serde_json::Value, fallback: &str) -> String {
    value
        .get("status")
        .or_else(|| value.get("state"))
        .and_then(serde_json::Value::as_str)
        .map(|status| match status.to_ascii_lowercase().as_str() {
            "success" | "completed" | "complete" | "done" => "succeeded".to_string(),
            "error" | "failed" | "cancelled" => "failed".to_string(),
            _ => "pending".to_string(),
        })
        .unwrap_or_else(|| fallback.to_string())
}

fn provider_credentials(app: &AppHandle, provider_id: &str) -> Result<(String, String), String> {
    let settings: Settings = read_json(settings_path(app)?)?;
    let api_key = settings
        .api_keys
        .get(provider_id)
        .cloned()
        .filter(|key| !key.trim().is_empty())
        .ok_or("请先在设置中填写 API Key")?;
    let base_url = settings
        .base_urls
        .get(provider_id)
        .cloned()
        .or_else(|| {
            settings.custom_providers.iter().find_map(|provider| {
                (provider.get("id").and_then(serde_json::Value::as_str) == Some(provider_id))
                    .then(|| provider.get("base_url").and_then(serde_json::Value::as_str))
                    .flatten()
                    .map(ToOwned::to_owned)
            })
        })
        .ok_or("请先在设置中填写 Base URL")?;
    Ok((base_url, api_key))
}

fn strings_from_models(value: &serde_json::Value) -> Vec<String> {
    let values = value
        .get("data")
        .and_then(serde_json::Value::as_array)
        .or_else(|| value.get("models").and_then(serde_json::Value::as_array))
        .or_else(|| value.as_array());
    let mut models: Vec<String> = values
        .into_iter()
        .flatten()
        .filter_map(|model| {
            model
                .as_str()
                .or_else(|| model.get("id").and_then(serde_json::Value::as_str))
                .or_else(|| model.get("model").and_then(serde_json::Value::as_str))
                .or_else(|| model.get("name").and_then(serde_json::Value::as_str))
        })
        .map(str::trim)
        .filter(|model| !model.is_empty())
        .map(ToOwned::to_owned)
        .collect();
    models.sort();
    models.dedup();
    models
}

#[derive(Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Settings {
    #[serde(default)]
    api_keys: HashMap<String, String>,
    #[serde(default)]
    base_urls: HashMap<String, String>,
    #[serde(default)]
    custom_providers: Vec<serde_json::Value>,
    #[serde(default)]
    service_base_url: Option<String>,
}

fn app_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let _ = app;
    // User data and the WebView cache are intentionally kept on F:.  The application is
    // designed as a local creative workspace and must not leave project data behind on C:.
    let path = PathBuf::from(r"F:\Huahaihuabu\花海画布\data");
    fs::create_dir_all(&path).map_err(|error| error.to_string())?;
    Ok(path)
}

fn projects_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app_dir(app)?.join("projects.db"))
}

fn settings_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app_dir(app)?.join("settings.json"))
}

fn ui_settings_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app_dir(app)?.join("ui-settings.json"))
}

fn auth_session_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app_dir(app)?.join("auth-session.json"))
}

fn machine_id_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app_dir(app)?.join("machine-id.txt"))
}

fn jimeng_session_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app_dir(app)?.join("jimeng-sessionid.txt"))
}

fn jimeng_script_path(app: &AppHandle) -> Result<PathBuf, String> {
    if let Ok(resource_dir) = app.path().resource_dir() {
        let packaged = resource_dir.join("tools").join("jimeng_browser.py");
        if packaged.is_file() {
            return Ok(packaged);
        }
    }
    let development = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .map(|path| path.join("tools").join("jimeng_browser.py"))
        .filter(|path| path.is_file());
    development.ok_or("jimeng_browser.py script not found".to_string())
}

fn python_executable() -> String {
    std::env::var("PYTHON")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| "python.exe".to_string())
}

fn run_jimeng_browser(
    app: &AppHandle,
    action: &str,
    params: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let request = serde_json::json!({"action": action, "params": params});
    let mut child = Command::new(python_executable())
        .arg(jimeng_script_path(app)?)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("无法启动即梦浏览器脚本，请安装 Python: {error}"))?;
    child
        .stdin
        .take()
        .ok_or("无法写入即梦浏览器脚本")?
        .write_all(
            serde_json::to_string(&request)
                .map_err(|error| error.to_string())?
                .as_bytes(),
        )
        .map_err(|error| error.to_string())?;
    let output = child
        .wait_with_output()
        .map_err(|error| format!("即梦浏览器脚本执行失败: {error}"))?;
    let events: Vec<serde_json::Value> = String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter_map(|line| serde_json::from_str(line).ok())
        .collect();
    if let Some(error) = events.iter().find_map(|event| {
        (event.get("event").and_then(serde_json::Value::as_str) == Some("error"))
            .then(|| event.get("error").and_then(serde_json::Value::as_str))
            .flatten()
    }) {
        return Err(error.to_string());
    }
    if !output.status.success() {
        return Err(format!(
            "即梦浏览器脚本退出失败: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    events
        .last()
        .cloned()
        .ok_or("即梦浏览器脚本未返回结果".to_string())
}

fn media_dir(app: &AppHandle, category: &str) -> Result<PathBuf, String> {
    let path = app_dir(app)?.join("media").join(category);
    fs::create_dir_all(&path).map_err(|error| error.to_string())?;
    Ok(path)
}

fn extension_from_data_url(source: &str, fallback: &str) -> String {
    let mime = source
        .strip_prefix("data:")
        .and_then(|value| value.split(';').next())
        .unwrap_or_default()
        .to_ascii_lowercase();
    let extension = match mime.as_str() {
        "image/jpeg" => "jpg",
        "image/png" => "png",
        "image/webp" => "webp",
        "image/gif" => "gif",
        "image/bmp" => "bmp",
        "image/avif" => "avif",
        "video/mp4" => "mp4",
        "video/webm" => "webm",
        "audio/mpeg" => "mp3",
        "audio/wav" | "audio/x-wav" => "wav",
        "audio/ogg" => "ogg",
        _ => fallback,
    };
    extension.to_string()
}

fn normalized_extension(extension: &str, fallback: &str) -> String {
    let trimmed = extension
        .trim()
        .trim_start_matches('.')
        .to_ascii_lowercase();
    if !trimmed.is_empty()
        && trimmed.len() <= 10
        && trimmed
            .chars()
            .all(|character| character.is_ascii_alphanumeric())
    {
        trimmed
    } else {
        fallback.to_string()
    }
}

fn write_media_bytes(
    app: &AppHandle,
    category: &str,
    bytes: &[u8],
    extension: &str,
) -> Result<String, String> {
    let extension = normalized_extension(extension, "bin");
    let file = media_dir(app, category)?.join(format!("{}.{}", Uuid::new_v4(), extension));
    fs::write(&file, bytes).map_err(|error| error.to_string())?;
    Ok(file.display().to_string())
}

fn persist_media_source(app: &AppHandle, category: &str, source: String) -> Result<String, String> {
    let source = source.trim();
    if source.is_empty() {
        return Err("media source is empty".to_string());
    }
    if let Some((header, encoded)) = source.split_once(",") {
        if header.starts_with("data:") && header.ends_with(";base64") {
            let bytes = STANDARD
                .decode(encoded)
                .map_err(|error| format!("invalid base64 data URL: {error}"))?;
            return write_media_bytes(
                app,
                category,
                &bytes,
                &extension_from_data_url(header, "bin"),
            );
        }
    }
    if source.starts_with("http://") || source.starts_with("https://") {
        // Keep remote URLs usable in the canvas. Downloading is deliberately deferred until an
        // explicit provider request so this command does not create unrequested network traffic.
        return Ok(source.to_string());
    }
    let source_path = PathBuf::from(source.strip_prefix("file://").unwrap_or(source));
    if !source_path.is_file() {
        return Err("media source does not exist or is not a file".to_string());
    }
    let extension = source_path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("bin");
    let destination = media_dir(app, category)?.join(format!(
        "{}.{}",
        Uuid::new_v4(),
        normalized_extension(extension, "bin")
    ));
    fs::copy(source_path, &destination).map_err(|error| error.to_string())?;
    Ok(destination.display().to_string())
}

fn safe_file_name(name: &str, default_extension: &str) -> String {
    let requested_path = PathBuf::from(name);
    let base = requested_path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("image");
    let cleaned: String = base
        .chars()
        .map(|character| match character {
            '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' => '_',
            _ => character,
        })
        .collect();
    let cleaned = cleaned.trim_matches('.').trim();
    let candidate = if cleaned.is_empty() { "image" } else { cleaned };
    if PathBuf::from(candidate).extension().is_some() {
        candidate.to_string()
    } else {
        format!(
            "{}.{}",
            candidate,
            normalized_extension(default_extension, "png")
        )
    }
}

fn copy_image_to_windows_clipboard(path: &PathBuf) -> Result<(), String> {
    let status = Command::new("powershell.exe")
        .args([
            "-NoProfile",
            "-STA",
            "-Command",
            "Add-Type -AssemblyName System.Windows.Forms; Add-Type -AssemblyName System.Drawing; $image = [System.Drawing.Image]::FromFile($args[0]); try { [System.Windows.Forms.Clipboard]::SetImage($image) } finally { $image.Dispose() }",
        ])
        .arg(path)
        .status()
        .map_err(|error| format!("failed to start clipboard helper: {error}"))?;
    if status.success() {
        Ok(())
    } else {
        Err("Windows rejected the image clipboard operation".to_string())
    }
}

fn copy_text_to_windows_clipboard(text: &str) -> Result<(), String> {
    let status = Command::new("powershell.exe")
        .args([
            "-NoProfile",
            "-STA",
            "-Command",
            "Set-Clipboard -Value $args[0]",
        ])
        .arg(text)
        .status()
        .map_err(|error| format!("failed to start clipboard helper: {error}"))?;
    if status.success() {
        Ok(())
    } else {
        Err("Windows rejected the text clipboard operation".to_string())
    }
}

fn ffmpeg_executable(name: &str) -> PathBuf {
    let bundled = PathBuf::from(r"C:\ffmpeg\bin").join(format!("{name}.exe"));
    if bundled.is_file() {
        bundled
    } else {
        PathBuf::from(format!("{name}.exe"))
    }
}

fn run_ffmpeg(arguments: &[String]) -> Result<(), String> {
    let output = Command::new(ffmpeg_executable("ffmpeg"))
        .args(arguments)
        .output()
        .map_err(|error| format!("无法启动 FFmpeg: {error}"))?;
    if output.status.success() {
        return Ok(());
    }
    let stderr = String::from_utf8_lossy(&output.stderr);
    Err(format!("FFmpeg 处理失败: {}", stderr.trim()))
}

fn media_output_path(video_path: &str, suffix: &str) -> Result<PathBuf, String> {
    let input = PathBuf::from(video_path);
    if !input.is_file() {
        return Err("视频文件不存在".to_string());
    }
    let directory = input.parent().ok_or("无法确定视频输出目录")?;
    let stem = input
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("video");
    Ok(directory.join(format!("{stem}_{suffix}_{}.mp4", Uuid::new_v4())))
}

fn local_image_source(app: &AppHandle, source: String) -> Result<PathBuf, String> {
    let source = persist_media_source(app, "images", source)?;
    let path = PathBuf::from(source);
    if path.is_file() {
        Ok(path)
    } else {
        Err("远程图片请先保存到本地后再处理".to_string())
    }
}

fn storyboard_metadata_path(image_path: &PathBuf) -> PathBuf {
    PathBuf::from(format!("{}.storyboard.json", image_path.display()))
}

fn read_json<T: for<'a> Deserialize<'a> + Default>(path: PathBuf) -> Result<T, String> {
    match fs::read_to_string(path) {
        Ok(content) => serde_json::from_str(&content).map_err(|error| error.to_string()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(T::default()),
        Err(error) => Err(error.to_string()),
    }
}

fn write_json<T: Serialize>(path: PathBuf, value: &T) -> Result<(), String> {
    let content = serde_json::to_string_pretty(value).map_err(|error| error.to_string())?;
    fs::write(path, content).map_err(|error| error.to_string())
}

fn row_to_project(row: &rusqlite::Row<'_>) -> rusqlite::Result<ProjectRecord> {
    Ok(ProjectRecord {
        id: row.get("id")?,
        name: row.get("name")?,
        nodes_json: row.get("nodes_json")?,
        edges_json: row.get("edges_json")?,
        viewport_json: row.get("viewport_json")?,
        history_json: row.get("history_json")?,
        image_pool_json: row.get("image_pool_json")?,
        node_count: row.get("node_count")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}

fn legacy_projects_path() -> Option<PathBuf> {
    dirs::config_dir().map(|directory| {
        directory
            .join("com.storyboard-copilot.app")
            .join("projects.db")
    })
}

fn open_projects(app: &AppHandle) -> Result<Connection, String> {
    let connection = Connection::open(projects_path(app)?).map_err(|error| error.to_string())?;
    connection
        .execute_batch(
            "
            CREATE TABLE IF NOT EXISTS projects (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                nodes_json TEXT NOT NULL DEFAULT '[]',
                edges_json TEXT NOT NULL DEFAULT '[]',
                viewport_json TEXT NOT NULL DEFAULT '{}',
                history_json TEXT NOT NULL DEFAULT '[]',
                node_count INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                image_pool_json TEXT NOT NULL DEFAULT '[]'
            );
            CREATE INDEX IF NOT EXISTS idx_projects_updated_at ON projects(updated_at DESC);
            CREATE TABLE IF NOT EXISTS assets (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                category TEXT NOT NULL,
                tags TEXT NOT NULL DEFAULT '',
                file_path TEXT NOT NULL,
                source_type TEXT NOT NULL,
                source_node_id TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_assets_updated_at ON assets(updated_at DESC);
            CREATE INDEX IF NOT EXISTS idx_assets_category ON assets(category);
            CREATE TABLE IF NOT EXISTS generation_jobs (
                job_id TEXT PRIMARY KEY,
                provider_id TEXT NOT NULL,
                kind TEXT NOT NULL,
                status TEXT NOT NULL,
                progress INTEGER NOT NULL DEFAULT 0,
                result TEXT,
                error TEXT,
                remote_job_id TEXT,
                updated_at TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_generation_jobs_updated_at ON generation_jobs(updated_at DESC);
            CREATE TABLE IF NOT EXISTS chat_sessions (
                id TEXT PRIMARY KEY,
                project_id TEXT,
                title TEXT NOT NULL,
                model TEXT NOT NULL DEFAULT '',
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_chat_sessions_project_updated
                ON chat_sessions(project_id, updated_at DESC);
            CREATE TABLE IF NOT EXISTS chat_messages (
                id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL,
                role TEXT NOT NULL,
                content TEXT NOT NULL,
                context_json TEXT NOT NULL DEFAULT '{}',
                created_at TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_chat_messages_session_created
                ON chat_messages(session_id, created_at ASC);
            CREATE TABLE IF NOT EXISTS agent_previews (
                id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL,
                project_id TEXT,
                actions_json TEXT NOT NULL,
                status TEXT NOT NULL,
                created_at TEXT NOT NULL,
                confirmed_at TEXT
            );
            CREATE INDEX IF NOT EXISTS idx_agent_previews_session_created
                ON agent_previews(session_id, created_at DESC);
            CREATE TABLE IF NOT EXISTS canvas_batch_history (
                id TEXT PRIMARY KEY,
                project_id TEXT NOT NULL,
                action TEXT NOT NULL,
                before_nodes_json TEXT NOT NULL,
                before_edges_json TEXT NOT NULL,
                after_nodes_json TEXT NOT NULL,
                after_edges_json TEXT NOT NULL,
                created_at TEXT NOT NULL,
                undone INTEGER NOT NULL DEFAULT 0
            );
            CREATE INDEX IF NOT EXISTS idx_canvas_batch_history_project
                ON canvas_batch_history(project_id, undone, created_at DESC);
            ",
        )
        .map_err(|error| error.to_string())?;

    let count: i64 = connection
        .query_row("SELECT COUNT(*) FROM projects", [], |row| row.get(0))
        .map_err(|error| error.to_string())?;
    if count == 0 {
        if let Some(legacy_path) = legacy_projects_path().filter(|path| path.is_file()) {
            if let Ok(legacy) =
                Connection::open_with_flags(legacy_path, OpenFlags::SQLITE_OPEN_READ_ONLY)
            {
                let mut statement = legacy
                    .prepare(
                        "SELECT id, name, nodes_json, edges_json, viewport_json, history_json,
                                image_pool_json, node_count, created_at, updated_at FROM projects",
                    )
                    .map_err(|error| error.to_string())?;
                let records = statement
                    .query_map([], row_to_project)
                    .map_err(|error| error.to_string())?;
                for record in records {
                    let record = record.map_err(|error| error.to_string())?;
                    connection
                        .execute(
                            "INSERT OR IGNORE INTO projects
                             (id, name, nodes_json, edges_json, viewport_json, history_json,
                              image_pool_json, node_count, created_at, updated_at)
                             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
                            params![
                                record.id,
                                record.name,
                                record.nodes_json,
                                record.edges_json,
                                record.viewport_json,
                                record.history_json,
                                record.image_pool_json,
                                record.node_count,
                                record.created_at,
                                record.updated_at,
                            ],
                        )
                        .map_err(|error| error.to_string())?;
                }
            }
        }
    }
    let asset_count: i64 = connection
        .query_row("SELECT COUNT(*) FROM assets", [], |row| row.get(0))
        .map_err(|error| error.to_string())?;
    if asset_count == 0 {
        if let Some(legacy_path) = legacy_projects_path().filter(|path| path.is_file()) {
            if let Ok(legacy) =
                Connection::open_with_flags(legacy_path, OpenFlags::SQLITE_OPEN_READ_ONLY)
            {
                let has_assets_table: bool = legacy
                    .query_row(
                        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'assets')",
                        [],
                        |row| row.get(0),
                    )
                    .unwrap_or(false);
                if has_assets_table {
                    let mut column_statement = legacy
                        .prepare("SELECT name FROM pragma_table_info('assets')")
                        .map_err(|error| error.to_string())?;
                    let columns = column_statement
                        .query_map([], |row| row.get::<_, String>(0))
                        .map_err(|error| error.to_string())?
                        .collect::<Result<Vec<_>, _>>()
                        .map_err(|error| error.to_string())?;
                    let required = [
                        "id",
                        "name",
                        "category",
                        "tags",
                        "file_path",
                        "source_type",
                        "source_node_id",
                        "created_at",
                        "updated_at",
                    ];
                    if required.iter().all(|required_column| {
                        columns.iter().any(|column| column == required_column)
                    }) {
                        let mut statement = legacy
                            .prepare(
                                "SELECT id, name, category, tags, file_path, source_type, source_node_id,
                                        created_at, updated_at FROM assets",
                            )
                            .map_err(|error| error.to_string())?;
                        let records = statement
                            .query_map([], row_to_asset)
                            .map_err(|error| error.to_string())?;
                        for record in records {
                            let record = record.map_err(|error| error.to_string())?;
                            connection
                                .execute(
                                    "INSERT OR IGNORE INTO assets
                                     (id, name, category, tags, file_path, source_type, source_node_id, created_at, updated_at)
                                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
                                    params![
                                        record.id,
                                        record.name,
                                        record.category,
                                        record.tags,
                                        record.file_path,
                                        record.source_type,
                                        record.source_node_id,
                                        record.created_at,
                                        record.updated_at,
                                    ],
                                )
                                .map_err(|error| error.to_string())?;
                        }
                    }
                }
            }
        }
    }
    Ok(connection)
}

fn row_to_asset(row: &rusqlite::Row<'_>) -> rusqlite::Result<AssetRecord> {
    Ok(AssetRecord {
        id: row.get("id")?,
        name: row.get("name")?,
        category: row.get("category")?,
        tags: row.get("tags")?,
        file_path: row.get("file_path")?,
        source_type: row.get("source_type")?,
        source_node_id: row.get("source_node_id")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}

fn row_to_generation_job(row: &rusqlite::Row<'_>) -> rusqlite::Result<GenerationJob> {
    Ok(GenerationJob {
        job_id: row.get("job_id")?,
        provider_id: row.get("provider_id")?,
        kind: row.get("kind")?,
        status: row.get("status")?,
        progress: row.get("progress")?,
        result: row.get("result")?,
        error: row.get("error")?,
        remote_job_id: row.get("remote_job_id")?,
        updated_at: row.get("updated_at")?,
    })
}

fn save_generation_job(connection: &Connection, job: &GenerationJob) -> Result<(), String> {
    connection
        .execute(
            "INSERT INTO generation_jobs
             (job_id, provider_id, kind, status, progress, result, error, remote_job_id, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
             ON CONFLICT(job_id) DO UPDATE SET
               status = excluded.status, progress = excluded.progress, result = excluded.result,
               error = excluded.error, remote_job_id = excluded.remote_job_id, updated_at = excluded.updated_at",
            params![
                &job.job_id,
                &job.provider_id,
                &job.kind,
                &job.status,
                job.progress,
                &job.result,
                &job.error,
                &job.remote_job_id,
                &job.updated_at,
            ],
        )
        .map_err(|error| error.to_string())?;
    Ok(())
}

fn get_generation_job(
    connection: &Connection,
    job_id: &str,
) -> Result<Option<GenerationJob>, String> {
    connection
        .query_row(
            "SELECT job_id, provider_id, kind, status, progress, result, error, remote_job_id, updated_at
             FROM generation_jobs WHERE job_id = ?1",
            [job_id],
            row_to_generation_job,
        )
        .optional()
        .map_err(|error| error.to_string())
}

fn read_projects(app: &AppHandle) -> Result<Vec<ProjectRecord>, String> {
    let connection = open_projects(app)?;
    let mut statement = connection
        .prepare(
            "SELECT id, name, nodes_json, edges_json, viewport_json, history_json,
                    image_pool_json, node_count, created_at, updated_at
             FROM projects ORDER BY updated_at DESC",
        )
        .map_err(|error| error.to_string())?;
    let projects = statement
        .query_map([], row_to_project)
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    Ok(projects)
}

#[tauri::command]
fn list_assets(
    app: AppHandle,
    category_filter: String,
    search: String,
    lock: State<StoreLock>,
) -> Result<Vec<AssetRecord>, String> {
    let _guard = lock
        .0
        .lock()
        .map_err(|_| "asset store lock poisoned".to_string())?;
    let connection = open_projects(&app)?;
    let category = category_filter.trim();
    let search = search.trim();
    let mut statement = connection
        .prepare(
            "SELECT id, name, category, tags, file_path, source_type, source_node_id,
                    created_at, updated_at
             FROM assets
             WHERE (?1 = '' OR category = ?1)
               AND (?2 = '' OR name LIKE '%' || ?2 || '%' OR tags LIKE '%' || ?2 || '%')
             ORDER BY updated_at DESC",
        )
        .map_err(|error| error.to_string())?;
    let assets = statement
        .query_map(params![category, search], row_to_asset)
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    Ok(assets)
}

#[tauri::command]
fn add_asset(
    app: AppHandle,
    name: String,
    category: String,
    tags: String,
    file_path: String,
    source_type: String,
    source_node_id: Option<String>,
    lock: State<StoreLock>,
) -> Result<AssetRecord, String> {
    if name.trim().is_empty() || category.trim().is_empty() || file_path.trim().is_empty() {
        return Err("asset name, category, and file path are required".to_string());
    }
    let _guard = lock
        .0
        .lock()
        .map_err(|_| "asset store lock poisoned".to_string())?;
    let now = Utc::now().to_rfc3339();
    let asset = AssetRecord {
        id: Uuid::new_v4().to_string(),
        name,
        category,
        tags,
        file_path,
        source_type,
        source_node_id,
        created_at: now.clone(),
        updated_at: now,
    };
    open_projects(&app)?
        .execute(
            "INSERT INTO assets
             (id, name, category, tags, file_path, source_type, source_node_id, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![
                &asset.id,
                &asset.name,
                &asset.category,
                &asset.tags,
                &asset.file_path,
                &asset.source_type,
                &asset.source_node_id,
                &asset.created_at,
                &asset.updated_at,
            ],
        )
        .map_err(|error| error.to_string())?;
    Ok(asset)
}

#[tauri::command]
fn update_asset(
    app: AppHandle,
    id: String,
    name: Option<String>,
    category: Option<String>,
    tags: Option<String>,
    lock: State<StoreLock>,
) -> Result<AssetRecord, String> {
    let _guard = lock
        .0
        .lock()
        .map_err(|_| "asset store lock poisoned".to_string())?;
    let connection = open_projects(&app)?;
    let existing = connection
        .query_row(
            "SELECT id, name, category, tags, file_path, source_type, source_node_id,
                    created_at, updated_at FROM assets WHERE id = ?1",
            [&id],
            row_to_asset,
        )
        .optional()
        .map_err(|error| error.to_string())?
        .ok_or("asset not found")?;
    let asset = AssetRecord {
        name: name.unwrap_or(existing.name),
        category: category.unwrap_or(existing.category),
        tags: tags.unwrap_or(existing.tags),
        updated_at: Utc::now().to_rfc3339(),
        ..existing
    };
    if asset.name.trim().is_empty() || asset.category.trim().is_empty() {
        return Err("asset name and category cannot be empty".to_string());
    }
    connection
        .execute(
            "UPDATE assets SET name = ?1, category = ?2, tags = ?3, updated_at = ?4 WHERE id = ?5",
            params![
                &asset.name,
                &asset.category,
                &asset.tags,
                &asset.updated_at,
                &asset.id
            ],
        )
        .map_err(|error| error.to_string())?;
    Ok(asset)
}

#[tauri::command]
fn delete_asset(app: AppHandle, id: String, lock: State<StoreLock>) -> Result<(), String> {
    let _guard = lock
        .0
        .lock()
        .map_err(|_| "asset store lock poisoned".to_string())?;
    // Assets can point at user-selected paths, so deleting a library entry must never delete its file.
    open_projects(&app)?
        .execute("DELETE FROM assets WHERE id = ?1", [id])
        .map_err(|error| error.to_string())?;
    Ok(())
}

#[tauri::command]
fn clear_assets(app: AppHandle, lock: State<StoreLock>) -> Result<(), String> {
    let _guard = lock
        .0
        .lock()
        .map_err(|_| "asset store lock poisoned".to_string())?;
    // This clears only the database library index, never files chosen or created by the user.
    open_projects(&app)?
        .execute("DELETE FROM assets", [])
        .map_err(|error| error.to_string())?;
    Ok(())
}

#[tauri::command]
fn persist_image_source(app: AppHandle, source: String) -> Result<String, String> {
    persist_media_source(&app, "images", source)
}

#[tauri::command]
fn persist_image_binary(
    app: AppHandle,
    bytes: Vec<u8>,
    extension: String,
) -> Result<String, String> {
    write_media_bytes(
        &app,
        "images",
        &bytes,
        &normalized_extension(&extension, "png"),
    )
}

#[tauri::command]
fn persist_video_source(app: AppHandle, source: String) -> Result<String, String> {
    persist_media_source(&app, "videos", source)
}

#[tauri::command]
fn persist_video_binary(
    app: AppHandle,
    bytes: Vec<u8>,
    extension: String,
) -> Result<String, String> {
    write_media_bytes(
        &app,
        "videos",
        &bytes,
        &normalized_extension(&extension, "mp4"),
    )
}

#[tauri::command]
fn persist_audio_source(app: AppHandle, source: String) -> Result<String, String> {
    persist_media_source(&app, "audio", source)
}

#[tauri::command]
fn save_image_to_downloads(
    app: AppHandle,
    data_url: String,
    filename: String,
) -> Result<String, String> {
    let saved_source = persist_media_source(&app, "images", data_url)?;
    let source_path = PathBuf::from(&saved_source);
    if !source_path.is_file() {
        return Err("remote images must be saved locally before downloading".to_string());
    }
    let download_dir = dirs::download_dir().ok_or("Downloads folder is unavailable")?;
    fs::create_dir_all(&download_dir).map_err(|error| error.to_string())?;
    let name = safe_file_name(&filename, "png");
    let destination = download_dir.join(&name);
    if source_path == destination {
        return Ok(destination.display().to_string());
    }
    fs::copy(source_path, &destination).map_err(|error| error.to_string())?;
    Ok(destination.display().to_string())
}

#[tauri::command]
fn copy_image_to_clipboard(app: AppHandle, data_url: String) -> Result<(), String> {
    let saved_source = persist_media_source(&app, "images", data_url)?;
    let source_path = PathBuf::from(saved_source);
    if !source_path.is_file() {
        return Err("remote images must be saved locally before copying".to_string());
    }
    copy_image_to_windows_clipboard(&source_path)
}

#[tauri::command]
fn copy_image_source_to_clipboard(source: String) -> Result<(), String> {
    copy_text_to_windows_clipboard(&source)
}

#[tauri::command]
fn get_video_duration(video_path: String) -> Result<f64, String> {
    if !PathBuf::from(&video_path).is_file() {
        return Err("视频文件不存在".to_string());
    }
    let output = Command::new(ffmpeg_executable("ffprobe"))
        .args([
            "-v",
            "error",
            "-show_entries",
            "format=duration",
            "-of",
            "default=noprint_wrappers=1:nokey=1",
            &video_path,
        ])
        .output()
        .map_err(|error| format!("无法启动 FFprobe: {error}"))?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    String::from_utf8_lossy(&output.stdout)
        .trim()
        .parse::<f64>()
        .map_err(|error| format!("无法读取视频时长: {error}"))
}

#[tauri::command]
fn extract_audio_from_video(app: AppHandle, video_path: String) -> Result<String, String> {
    if !PathBuf::from(&video_path).is_file() {
        return Err("视频文件不存在".to_string());
    }
    let output = media_dir(&app, "audio")?.join(format!("{}.mp3", Uuid::new_v4()));
    run_ffmpeg(&[
        "-y".to_string(),
        "-i".to_string(),
        video_path,
        "-vn".to_string(),
        "-c:a".to_string(),
        "libmp3lame".to_string(),
        output.display().to_string(),
    ])?;
    Ok(output.display().to_string())
}

#[tauri::command]
fn compose_videos_sequential(
    video_paths: Vec<String>,
    output_dir: String,
) -> Result<String, String> {
    if video_paths.is_empty() {
        return Err("至少需要一个视频".to_string());
    }
    if video_paths
        .iter()
        .any(|path| !PathBuf::from(path).is_file())
    {
        return Err("存在不可读取的视频文件".to_string());
    }
    let directory = PathBuf::from(output_dir);
    fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    let list_path = directory.join(format!("concat_{}.txt", Uuid::new_v4()));
    let list = video_paths
        .iter()
        .map(|path| format!("file '{}'", path.replace('\'', "'\\''")))
        .collect::<Vec<_>>()
        .join("\n");
    fs::write(&list_path, list).map_err(|error| error.to_string())?;
    let output = directory.join(format!("composed_{}.mp4", Uuid::new_v4()));
    let result = run_ffmpeg(&[
        "-y".to_string(),
        "-f".to_string(),
        "concat".to_string(),
        "-safe".to_string(),
        "0".to_string(),
        "-i".to_string(),
        list_path.display().to_string(),
        "-c".to_string(),
        "copy".to_string(),
        output.display().to_string(),
    ]);
    let _ = fs::remove_file(&list_path);
    result?;
    Ok(output.display().to_string())
}

#[tauri::command]
fn remove_video_watermark(
    video_path: String,
    x: u32,
    y: u32,
    w: u32,
    h: u32,
) -> Result<String, String> {
    if w == 0 || h == 0 {
        return Err("水印区域必须大于零".to_string());
    }
    let output = media_output_path(&video_path, "no_watermark")?;
    run_ffmpeg(&[
        "-y".to_string(),
        "-i".to_string(),
        video_path,
        "-vf".to_string(),
        format!("delogo=x={x}:y={y}:w={w}:h={h}:show=0"),
        "-c:a".to_string(),
        "copy".to_string(),
        output.display().to_string(),
    ])?;
    Ok(output.display().to_string())
}

#[tauri::command]
fn remove_video_subtitles(video_path: String, crop_height: u32) -> Result<String, String> {
    if crop_height == 0 {
        return Err("字幕裁剪高度必须大于零".to_string());
    }
    let output = media_output_path(&video_path, "no_subtitles")?;
    run_ffmpeg(&[
        "-y".to_string(),
        "-i".to_string(),
        video_path,
        "-vf".to_string(),
        format!("crop=in_w:in_h-{crop_height}:0:0"),
        "-c:a".to_string(),
        "copy".to_string(),
        output.display().to_string(),
    ])?;
    Ok(output.display().to_string())
}

#[tauri::command]
fn upscale_video(video_path: String, target_width: u32) -> Result<String, String> {
    if target_width < 2 {
        return Err("目标宽度必须至少为 2 像素".to_string());
    }
    let output = media_output_path(&video_path, "upscaled")?;
    run_ffmpeg(&[
        "-y".to_string(),
        "-i".to_string(),
        video_path,
        "-vf".to_string(),
        format!("scale={target_width}:-2:flags=lanczos"),
        "-c:a".to_string(),
        "copy".to_string(),
        output.display().to_string(),
    ])?;
    Ok(output.display().to_string())
}

#[tauri::command]
fn split_image_source(
    app: AppHandle,
    source: String,
    rows: u32,
    cols: u32,
    line_thickness: Option<f64>,
) -> Result<Vec<String>, String> {
    if rows == 0 || cols == 0 || rows > 20 || cols > 20 {
        return Err("分割行列数必须在 1 到 20 之间".to_string());
    }
    let source_path = local_image_source(&app, source)?;
    let image = image::open(&source_path).map_err(|error| format!("无法读取图片: {error}"))?;
    let (width, height) = image.dimensions();
    if width < cols || height < rows {
        return Err("图片尺寸小于分割网格".to_string());
    }
    let line = line_thickness.unwrap_or(0.0).clamp(0.0, 5.0) / 100.0;
    let cell_width = width / cols;
    let cell_height = height / rows;
    let mut paths = Vec::new();
    for row in 0..rows {
        for col in 0..cols {
            let inset_x = (cell_width as f64 * line / 2.0).round() as u32;
            let inset_y = (cell_height as f64 * line / 2.0).round() as u32;
            let x = col * cell_width + inset_x;
            let y = row * cell_height + inset_y;
            let crop_width = cell_width.saturating_sub(inset_x * 2).max(1);
            let crop_height = cell_height.saturating_sub(inset_y * 2).max(1);
            let crop = image.crop_imm(x, y, crop_width, crop_height);
            let path = media_dir(&app, "images")?.join(format!("split_{}.png", Uuid::new_v4()));
            crop.save(&path)
                .map_err(|error| format!("保存分割图片失败: {error}"))?;
            paths.push(path.display().to_string());
        }
    }
    Ok(paths)
}

#[tauri::command]
fn merge_storyboard_images(
    app: AppHandle,
    payload: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let sources = payload
        .get("sources")
        .and_then(serde_json::Value::as_array)
        .ok_or("合并请求缺少 sources")?;
    let rows = payload
        .get("rows")
        .and_then(serde_json::Value::as_u64)
        .unwrap_or(1) as u32;
    let cols = payload
        .get("cols")
        .and_then(serde_json::Value::as_u64)
        .unwrap_or(sources.len() as u64) as u32;
    if sources.is_empty() || rows == 0 || cols == 0 || sources.len() > (rows * cols) as usize {
        return Err("分镜合并网格无效".to_string());
    }
    let mut images = Vec::new();
    for source in sources {
        let source = source.as_str().ok_or("图片来源必须是字符串")?.to_string();
        let path = local_image_source(&app, source)?;
        images.push(image::open(path).map_err(|error| format!("无法读取分镜图片: {error}"))?);
    }
    let cell_width = images.iter().map(DynamicImage::width).max().unwrap_or(1);
    let cell_height = images.iter().map(DynamicImage::height).max().unwrap_or(1);
    let mut canvas = RgbaImage::new(cell_width * cols, cell_height * rows);
    for (index, image) in images.iter().enumerate() {
        let x = (index as u32 % cols) * cell_width;
        let y = (index as u32 / cols) * cell_height;
        let resized = image.resize_exact(cell_width, cell_height, FilterType::Lanczos3);
        image::imageops::overlay(&mut canvas, &resized.to_rgba8(), x.into(), y.into());
    }
    let path = media_dir(&app, "images")?.join(format!("storyboard_{}.png", Uuid::new_v4()));
    DynamicImage::ImageRgba8(canvas)
        .save(&path)
        .map_err(|error| format!("保存合并分镜失败: {error}"))?;
    Ok(
        serde_json::json!({"path": path.display().to_string(), "width": cell_width * cols, "height": cell_height * rows}),
    )
}

#[tauri::command]
fn prepare_node_image_source(
    app: AppHandle,
    source: String,
    max_preview_dimension: Option<u32>,
) -> Result<serde_json::Value, String> {
    let path = local_image_source(&app, source)?;
    let image = image::open(&path).map_err(|error| format!("无法读取图片: {error}"))?;
    let (width, height) = image.dimensions();
    let maximum = max_preview_dimension.unwrap_or(0);
    let preview_path = if maximum > 0 && width.max(height) > maximum {
        let preview = image.thumbnail(maximum, maximum);
        let path = media_dir(&app, "previews")?.join(format!("preview_{}.png", Uuid::new_v4()));
        preview
            .save(&path)
            .map_err(|error| format!("保存预览图失败: {error}"))?;
        path.display().to_string()
    } else {
        path.display().to_string()
    };
    Ok(
        serde_json::json!({"path": path.display().to_string(), "previewPath": preview_path, "width": width, "height": height}),
    )
}

#[tauri::command]
fn embed_storyboard_image_metadata(
    source: String,
    metadata: serde_json::Value,
) -> Result<String, String> {
    let path = PathBuf::from(&source);
    if !path.is_file() {
        return Err("图片文件不存在".to_string());
    }
    write_json(storyboard_metadata_path(&path), &metadata)?;
    Ok(source)
}

#[tauri::command]
fn read_storyboard_image_metadata(source: String) -> Result<Option<serde_json::Value>, String> {
    let path = PathBuf::from(source);
    let metadata_path = storyboard_metadata_path(&path);
    match fs::read_to_string(metadata_path) {
        Ok(value) => serde_json::from_str(&value)
            .map(Some)
            .map_err(|error| format!("分镜元数据无效: {error}")),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.to_string()),
    }
}

#[tauri::command]
fn remove_bg(
    app: AppHandle,
    image_path: String,
    feather: Option<u32>,
    green_screen: Option<bool>,
    edge_shrink: Option<i32>,
) -> Result<String, String> {
    let path = local_image_source(&app, image_path)?;
    let mut image = image::open(&path)
        .map_err(|error| format!("无法读取图片: {error}"))?
        .to_rgba8();
    let feather = feather.unwrap_or(0).min(64) as i32;
    let edge_shrink = edge_shrink.unwrap_or(0).clamp(-32, 32);
    for pixel in image.pixels_mut() {
        let [red, green, blue, alpha] = pixel.0;
        let green_key = green_screen.unwrap_or(false)
            && green as i32 > red as i32 + 25
            && green as i32 > blue as i32 + 15;
        let near_white = red > 242 && green > 242 && blue > 242;
        if green_key || near_white {
            pixel.0[3] = 0;
        } else if feather > 0 {
            let brightness = (red as i32 + green as i32 + blue as i32) / 3;
            let threshold = 255 - feather - edge_shrink;
            if brightness > threshold {
                pixel.0[3] = ((255 - brightness).max(0) * 255 / feather.max(1)) as u8;
            } else {
                pixel.0[3] = alpha;
            }
        }
    }
    let output = media_dir(&app, "images")?.join(format!("removed_bg_{}.png", Uuid::new_v4()));
    DynamicImage::ImageRgba8(image)
        .save(&output)
        .map_err(|error| format!("保存抠图结果失败: {error}"))?;
    Ok(output.display().to_string())
}

#[tauri::command]
fn list_project_summaries(
    app: AppHandle,
    lock: State<StoreLock>,
) -> Result<Vec<ProjectRecord>, String> {
    let _guard = lock
        .0
        .lock()
        .map_err(|_| "project store lock poisoned".to_string())?;
    let mut projects = read_projects(&app)?;
    projects.sort_by(|left, right| right.updated_at.cmp(&left.updated_at));
    Ok(projects)
}

#[tauri::command]
fn get_project_record(
    app: AppHandle,
    id: String,
    lock: State<StoreLock>,
) -> Result<Option<ProjectRecord>, String> {
    let _guard = lock
        .0
        .lock()
        .map_err(|_| "project store lock poisoned".to_string())?;
    Ok(read_projects(&app)?
        .into_iter()
        .find(|project| project.id == id))
}

#[tauri::command]
fn upsert_project_record(
    app: AppHandle,
    id: String,
    name: String,
    nodes_json: Option<String>,
    edges_json: Option<String>,
    viewport_json: Option<String>,
    history_json: Option<String>,
    image_pool_json: Option<String>,
    node_count: Option<u32>,
    lock: State<StoreLock>,
) -> Result<ProjectRecord, String> {
    let _guard = lock
        .0
        .lock()
        .map_err(|_| "project store lock poisoned".to_string())?;
    let connection = open_projects(&app)?;
    let existing_created_at: Option<String> = connection
        .query_row(
            "SELECT created_at FROM projects WHERE id = ?1",
            [&id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| error.to_string())?;
    let now = Utc::now().to_rfc3339();
    let record = ProjectRecord {
        id: id.clone(),
        name,
        nodes_json: nodes_json.unwrap_or_else(|| "[]".to_string()),
        edges_json: edges_json.unwrap_or_else(|| "[]".to_string()),
        viewport_json: viewport_json.unwrap_or_else(|| "{}".to_string()),
        history_json: history_json.unwrap_or_else(|| "[]".to_string()),
        image_pool_json: image_pool_json.unwrap_or_else(|| "[]".to_string()),
        node_count: node_count.unwrap_or(0),
        created_at: existing_created_at.unwrap_or_else(|| now.clone()),
        updated_at: now,
    };
    connection
        .execute(
            "INSERT INTO projects
             (id, name, nodes_json, edges_json, viewport_json, history_json,
              image_pool_json, node_count, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
             ON CONFLICT(id) DO UPDATE SET
               name = excluded.name,
               nodes_json = excluded.nodes_json,
               edges_json = excluded.edges_json,
               viewport_json = excluded.viewport_json,
               history_json = excluded.history_json,
               image_pool_json = excluded.image_pool_json,
               node_count = excluded.node_count,
               updated_at = excluded.updated_at",
            params![
                &record.id,
                &record.name,
                &record.nodes_json,
                &record.edges_json,
                &record.viewport_json,
                &record.history_json,
                &record.image_pool_json,
                record.node_count,
                &record.created_at,
                &record.updated_at,
            ],
        )
        .map_err(|error| error.to_string())?;
    Ok(record)
}

#[tauri::command]
fn rename_project_record(
    app: AppHandle,
    id: String,
    name: String,
    lock: State<StoreLock>,
) -> Result<(), String> {
    let _guard = lock
        .0
        .lock()
        .map_err(|_| "project store lock poisoned".to_string())?;
    let changed = open_projects(&app)?
        .execute(
            "UPDATE projects SET name = ?1, updated_at = ?2 WHERE id = ?3",
            params![name, Utc::now().to_rfc3339(), id],
        )
        .map_err(|error| error.to_string())?;
    if changed == 0 {
        return Err("project not found".to_string());
    }
    Ok(())
}

#[tauri::command]
fn delete_project_record(app: AppHandle, id: String, lock: State<StoreLock>) -> Result<(), String> {
    let _guard = lock
        .0
        .lock()
        .map_err(|_| "project store lock poisoned".to_string())?;
    open_projects(&app)?
        .execute("DELETE FROM projects WHERE id = ?1", [id])
        .map_err(|error| error.to_string())?;
    Ok(())
}

#[tauri::command]
fn update_project_viewport_record(
    app: AppHandle,
    id: String,
    viewport_json: String,
    lock: State<StoreLock>,
) -> Result<(), String> {
    let _guard = lock
        .0
        .lock()
        .map_err(|_| "project store lock poisoned".to_string())?;
    let changed = open_projects(&app)?
        .execute(
            "UPDATE projects SET viewport_json = ?1, updated_at = ?2 WHERE id = ?3",
            params![viewport_json, Utc::now().to_rfc3339(), id],
        )
        .map_err(|error| error.to_string())?;
    if changed == 0 {
        return Err("project not found".to_string());
    }
    Ok(())
}

#[tauri::command]
fn export_project_to_file(
    app: AppHandle,
    project_id: String,
    file_path: String,
    lock: State<StoreLock>,
) -> Result<(), String> {
    let _guard = lock
        .0
        .lock()
        .map_err(|_| "project store lock poisoned".to_string())?;
    let project = get_project_record_from_db(&open_projects(&app)?, &project_id)?
        .ok_or("project not found")?;
    let export = serde_json::json!({
        "format": "storyboard-copilot-project",
        "version": 1,
        "project": project,
    });
    let content = serde_json::to_string_pretty(&export).map_err(|error| error.to_string())?;
    fs::write(file_path, content).map_err(|error| error.to_string())
}

#[tauri::command]
fn import_project_from_file(
    app: AppHandle,
    file_path: String,
    lock: State<StoreLock>,
) -> Result<ProjectRecord, String> {
    let _guard = lock
        .0
        .lock()
        .map_err(|_| "project store lock poisoned".to_string())?;
    let content = fs::read_to_string(file_path).map_err(|error| error.to_string())?;
    let value: serde_json::Value =
        serde_json::from_str(&content).map_err(|error| error.to_string())?;
    let mut project: ProjectRecord =
        serde_json::from_value(value.get("project").cloned().unwrap_or(value))
            .map_err(|error| format!("invalid project export: {error}"))?;
    let now = Utc::now().to_rfc3339();
    project.id = Uuid::new_v4().to_string();
    project.created_at = now.clone();
    project.updated_at = now;
    insert_project(&open_projects(&app)?, &project)?;
    Ok(project)
}

fn get_project_record_from_db(
    connection: &Connection,
    id: &str,
) -> Result<Option<ProjectRecord>, String> {
    connection
        .query_row(
            "SELECT id, name, nodes_json, edges_json, viewport_json, history_json,
                    image_pool_json, node_count, created_at, updated_at
             FROM projects WHERE id = ?1",
            [id],
            row_to_project,
        )
        .optional()
        .map_err(|error| error.to_string())
}

fn insert_project(connection: &Connection, project: &ProjectRecord) -> Result<(), String> {
    connection
        .execute(
            "INSERT INTO projects
             (id, name, nodes_json, edges_json, viewport_json, history_json,
              image_pool_json, node_count, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
            params![
                &project.id,
                &project.name,
                &project.nodes_json,
                &project.edges_json,
                &project.viewport_json,
                &project.history_json,
                &project.image_pool_json,
                project.node_count,
                &project.created_at,
                &project.updated_at,
            ],
        )
        .map_err(|error| error.to_string())?;
    Ok(())
}

fn row_to_chat_session(row: &rusqlite::Row<'_>) -> rusqlite::Result<ChatSession> {
    Ok(ChatSession {
        id: row.get(0)?,
        project_id: row.get(1)?,
        title: row.get(2)?,
        model: row.get(3)?,
        created_at: row.get(4)?,
        updated_at: row.get(5)?,
    })
}

fn row_to_chat_message(row: &rusqlite::Row<'_>) -> rusqlite::Result<ChatMessage> {
    Ok(ChatMessage {
        id: row.get(0)?,
        session_id: row.get(1)?,
        role: row.get(2)?,
        content: row.get(3)?,
        context_json: row.get(4)?,
        created_at: row.get(5)?,
    })
}

fn insert_chat_message(connection: &Connection, message: &ChatMessage) -> Result<(), String> {
    connection
        .execute(
            "INSERT INTO chat_messages (id, session_id, role, content, context_json, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                message.id,
                message.session_id,
                message.role,
                message.content,
                message.context_json,
                message.created_at,
            ],
        )
        .map_err(|error| error.to_string())?;
    connection
        .execute(
            "UPDATE chat_sessions SET updated_at = ?1 WHERE id = ?2",
            params![Utc::now().to_rfc3339(), message.session_id],
        )
        .map_err(|error| error.to_string())?;
    Ok(())
}

fn chat_response_content(value: &serde_json::Value) -> Option<String> {
    let content = value
        .pointer("/choices/0/message/content")
        .or_else(|| value.pointer("/data/choices/0/message/content"))?;
    if let Some(text) = content.as_str() {
        return Some(text.to_string());
    }
    content.as_array().map(|parts| {
        parts
            .iter()
            .filter_map(|part| {
                part.get("text")
                    .or_else(|| part.get("content"))
                    .and_then(serde_json::Value::as_str)
            })
            .collect::<Vec<_>>()
            .join("")
    })
}

fn sanitize_chat_context(context_json: Option<String>) -> Result<String, String> {
    let raw = context_json.unwrap_or_else(|| "{}".to_string());
    if raw.len() > 32_000 {
        return Err("chat context is too large; share a smaller selection".to_string());
    }
    let value: serde_json::Value =
        serde_json::from_str(&raw).map_err(|error| format!("invalid chat context: {error}"))?;
    // A data URI would transfer the original image/audio/video.  The chat design only
    // sends node metadata and a local media reference unless the UI adds an explicit,
    // separately confirmed attachment feature.
    if raw.contains("data:image/") || raw.contains("data:video/") || raw.contains("data:audio/") {
        return Err("raw media must be attached through an explicit confirmation flow".to_string());
    }
    serde_json::to_string(&value).map_err(|error| error.to_string())
}

fn validate_agent_actions(actions_json: &str) -> Result<(), String> {
    let actions: serde_json::Value = serde_json::from_str(actions_json)
        .map_err(|error| format!("invalid agent action preview: {error}"))?;
    let items = actions
        .as_array()
        .ok_or("agent action preview must be a JSON array".to_string())?;
    if items.is_empty() || items.len() > 20 {
        return Err("agent action preview must contain 1 to 20 actions".to_string());
    }
    let allowed = [
        "createNodes",
        "connectImagesToVideo",
        "arrangeNodes",
        "updateNodePrompts",
        "generateImage",
        "generateVideo",
        "deleteNodes",
    ];
    for action in items {
        let kind = action
            .get("type")
            .and_then(serde_json::Value::as_str)
            .ok_or("each agent action must include a type".to_string())?;
        if !allowed.contains(&kind) {
            return Err(format!("agent action '{kind}' is not allowed"));
        }
        if !action
            .get("params")
            .is_some_and(serde_json::Value::is_object)
        {
            return Err(format!(
                "agent action '{kind}' must use an object params field"
            ));
        }
    }
    Ok(())
}

fn node_id(node: &serde_json::Value) -> Option<&str> {
    node.get("id").and_then(serde_json::Value::as_str)
}

fn node_text(node: &serde_json::Value) -> String {
    let data = node.get("data").unwrap_or(node);
    ["label", "title", "name", "displayName", "type"]
        .iter()
        .find_map(|key| data.get(*key).and_then(serde_json::Value::as_str))
        .unwrap_or("生视频节点")
        .to_string()
}

fn node_is_kind(node: &serde_json::Value, kind: &str) -> bool {
    let node_type = node
        .get("type")
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default()
        .to_ascii_lowercase();
    let data = node
        .get("data")
        .cloned()
        .unwrap_or_default()
        .to_string()
        .to_ascii_lowercase();
    match kind {
        "image" => {
            node_type.contains("image")
                || data.contains("imageurl")
                || data.contains("image_url")
                || data.contains("图像")
        }
        "video" => {
            node_type.contains("video")
                || data.contains("video")
                || data.contains("生视频")
                || data.contains("图生视频")
        }
        _ => false,
    }
}

fn node_position(node: &serde_json::Value) -> (f64, f64) {
    let position = node.get("position").unwrap_or(&serde_json::Value::Null);
    (
        position
            .get("x")
            .and_then(serde_json::Value::as_f64)
            .unwrap_or(0.0),
        position
            .get("y")
            .and_then(serde_json::Value::as_f64)
            .unwrap_or(0.0),
    )
}

fn node_size(node: &serde_json::Value) -> (f64, f64) {
    let measured = node.get("measured").unwrap_or(&serde_json::Value::Null);
    (
        node.get("width")
            .or_else(|| measured.get("width"))
            .and_then(serde_json::Value::as_f64)
            .unwrap_or(320.0),
        node.get("height")
            .or_else(|| measured.get("height"))
            .and_then(serde_json::Value::as_f64)
            .unwrap_or(180.0),
    )
}

fn write_project_canvas(
    connection: &Connection,
    project: &ProjectRecord,
    nodes: &[serde_json::Value],
    edges: &[serde_json::Value],
) -> Result<ProjectRecord, String> {
    let mut updated = project.clone();
    updated.nodes_json = serde_json::to_string(nodes).map_err(|error| error.to_string())?;
    updated.edges_json = serde_json::to_string(edges).map_err(|error| error.to_string())?;
    updated.node_count = nodes.len() as u32;
    updated.updated_at = Utc::now().to_rfc3339();
    connection
        .execute(
            "UPDATE projects SET nodes_json = ?1, edges_json = ?2, node_count = ?3, updated_at = ?4 WHERE id = ?5",
            params![
                updated.nodes_json,
                updated.edges_json,
                updated.node_count,
                updated.updated_at,
                updated.id,
            ],
        )
        .map_err(|error| error.to_string())?;
    Ok(updated)
}

fn record_canvas_batch_history(
    connection: &Connection,
    project_id: &str,
    action: &str,
    before_nodes: &[serde_json::Value],
    before_edges: &[serde_json::Value],
    after_nodes: &[serde_json::Value],
    after_edges: &[serde_json::Value],
) -> Result<(), String> {
    connection
        .execute(
            "DELETE FROM canvas_batch_history WHERE project_id = ?1 AND undone = 1",
            [project_id],
        )
        .map_err(|error| error.to_string())?;
    connection
        .execute(
            "INSERT INTO canvas_batch_history
             (id, project_id, action, before_nodes_json, before_edges_json, after_nodes_json, after_edges_json, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                Uuid::new_v4().to_string(),
                project_id,
                action,
                serde_json::to_string(before_nodes).map_err(|error| error.to_string())?,
                serde_json::to_string(before_edges).map_err(|error| error.to_string())?,
                serde_json::to_string(after_nodes).map_err(|error| error.to_string())?,
                serde_json::to_string(after_edges).map_err(|error| error.to_string())?,
                Utc::now().to_rfc3339(),
            ],
        )
        .map_err(|error| error.to_string())?;
    Ok(())
}

#[tauri::command]
fn list_chat_sessions(
    app: AppHandle,
    project_id: Option<String>,
    lock: State<StoreLock>,
) -> Result<Vec<ChatSession>, String> {
    let _guard = lock
        .0
        .lock()
        .map_err(|_| "project store lock poisoned".to_string())?;
    let connection = open_projects(&app)?;
    let mut statement = match project_id {
        Some(_) => connection
            .prepare("SELECT id, project_id, title, model, created_at, updated_at FROM chat_sessions WHERE project_id = ?1 ORDER BY updated_at DESC")
            .map_err(|error| error.to_string())?,
        None => connection
            .prepare("SELECT id, project_id, title, model, created_at, updated_at FROM chat_sessions WHERE project_id IS NULL ORDER BY updated_at DESC")
            .map_err(|error| error.to_string())?,
    };
    let rows = match project_id {
        Some(ref id) => statement.query_map([id], row_to_chat_session),
        None => statement.query_map([], row_to_chat_session),
    }
    .map_err(|error| error.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn create_chat_session(
    app: AppHandle,
    project_id: Option<String>,
    title: Option<String>,
    model: Option<String>,
    lock: State<StoreLock>,
) -> Result<ChatSession, String> {
    let _guard = lock
        .0
        .lock()
        .map_err(|_| "project store lock poisoned".to_string())?;
    let now = Utc::now().to_rfc3339();
    let session = ChatSession {
        id: Uuid::new_v4().to_string(),
        project_id,
        title: title
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(|| "新对话".to_string()),
        model: model.unwrap_or_default(),
        created_at: now.clone(),
        updated_at: now,
    };
    open_projects(&app)?
        .execute(
            "INSERT INTO chat_sessions (id, project_id, title, model, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                session.id,
                session.project_id,
                session.title,
                session.model,
                session.created_at,
                session.updated_at
            ],
        )
        .map_err(|error| error.to_string())?;
    Ok(session)
}

#[tauri::command]
fn list_chat_messages(
    app: AppHandle,
    session_id: String,
    lock: State<StoreLock>,
) -> Result<Vec<ChatMessage>, String> {
    let _guard = lock
        .0
        .lock()
        .map_err(|_| "project store lock poisoned".to_string())?;
    let connection = open_projects(&app)?;
    let mut statement = connection
        .prepare("SELECT id, session_id, role, content, context_json, created_at FROM chat_messages WHERE session_id = ?1 ORDER BY created_at ASC")
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([session_id], row_to_chat_message)
        .map_err(|error| error.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())
}

#[tauri::command]
async fn send_chat_message(
    app: AppHandle,
    session_id: String,
    provider_id: String,
    model: String,
    content: String,
    context_json: Option<String>,
    lock: State<'_, StoreLock>,
) -> Result<ChatMessage, String> {
    if content.trim().is_empty() || content.len() > 24_000 {
        return Err("chat message must contain 1 to 24000 characters".to_string());
    }
    let context_json = sanitize_chat_context(context_json)?;
    let (history, user_message) = {
        let _guard = lock
            .0
            .lock()
            .map_err(|_| "project store lock poisoned".to_string())?;
        let connection = open_projects(&app)?;
        let session_exists: Option<String> = connection
            .query_row(
                "SELECT id FROM chat_sessions WHERE id = ?1",
                [&session_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(|error| error.to_string())?;
        if session_exists.is_none() {
            return Err("chat session not found".to_string());
        }
        let mut statement = connection
            .prepare("SELECT id, session_id, role, content, context_json, created_at FROM chat_messages WHERE session_id = ?1 ORDER BY created_at DESC LIMIT 24")
            .map_err(|error| error.to_string())?;
        let mut history = statement
            .query_map([&session_id], row_to_chat_message)
            .map_err(|error| error.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())?;
        history.reverse();
        let user_message = ChatMessage {
            id: Uuid::new_v4().to_string(),
            session_id: session_id.clone(),
            role: "user".to_string(),
            content,
            context_json,
            created_at: Utc::now().to_rfc3339(),
        };
        insert_chat_message(&connection, &user_message)?;
        (history, user_message)
    };

    let (base_url, api_key) = provider_credentials(&app, &provider_id)?;
    let endpoint = provider_endpoint(&base_url, "chat/completions")?;
    let mut messages = vec![serde_json::json!({
        "role": "system",
        "content": "You are the Flower Sea Canvas assistant. Give practical, concise creative help. Never claim to have executed an action. Canvas changes, deletes and paid generation must be returned as a preview for user confirmation. You may only propose these action types: createNodes, connectImagesToVideo, arrangeNodes, updateNodePrompts, generateImage, generateVideo, deleteNodes. Do not request or reveal API keys."
    })];
    for message in history {
        messages.push(serde_json::json!({"role": message.role, "content": message.content}));
    }
    let contextual_content = if user_message.context_json == "{}" {
        user_message.content.clone()
    } else {
        format!(
            "{}\n\nCurrent canvas metadata (no raw media): {}",
            user_message.content, user_message.context_json
        )
    };
    messages.push(serde_json::json!({"role": "user", "content": contextual_content}));
    let response = Client::new()
        .post(endpoint)
        .bearer_auth(api_key)
        .json(&serde_json::json!({"model": model, "messages": messages, "stream": false}))
        .send()
        .await
        .map_err(|error| format!("chat request failed: {error}"))?;
    let status = response.status();
    let body = response
        .text()
        .await
        .map_err(|error| format!("chat response read failed: {error}"))?;
    if !status.is_success() {
        return Err(format!(
            "chat request failed ({status}): {}",
            body.chars().take(500).collect::<String>()
        ));
    }
    let value: serde_json::Value = serde_json::from_str(&body)
        .map_err(|error| format!("chat response was not JSON: {error}"))?;
    let assistant_message = ChatMessage {
        id: Uuid::new_v4().to_string(),
        session_id,
        role: "assistant".to_string(),
        content: chat_response_content(&value)
            .ok_or("chat response did not contain message content".to_string())?,
        context_json: "{}".to_string(),
        created_at: Utc::now().to_rfc3339(),
    };
    let _guard = lock
        .0
        .lock()
        .map_err(|_| "project store lock poisoned".to_string())?;
    insert_chat_message(&open_projects(&app)?, &assistant_message)?;
    Ok(assistant_message)
}

#[tauri::command]
fn create_agent_preview(
    app: AppHandle,
    session_id: String,
    project_id: Option<String>,
    actions_json: String,
    lock: State<StoreLock>,
) -> Result<AgentPreview, String> {
    validate_agent_actions(&actions_json)?;
    let _guard = lock
        .0
        .lock()
        .map_err(|_| "project store lock poisoned".to_string())?;
    let preview = AgentPreview {
        id: Uuid::new_v4().to_string(),
        session_id,
        project_id,
        actions_json,
        status: "pending".to_string(),
        created_at: Utc::now().to_rfc3339(),
        confirmed_at: None,
    };
    open_projects(&app)?
        .execute(
            "INSERT INTO agent_previews (id, session_id, project_id, actions_json, status, created_at, confirmed_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![preview.id, preview.session_id, preview.project_id, preview.actions_json, preview.status, preview.created_at, preview.confirmed_at],
        )
        .map_err(|error| error.to_string())?;
    Ok(preview)
}

#[tauri::command]
fn resolve_agent_preview(
    app: AppHandle,
    preview_id: String,
    confirm: bool,
    lock: State<StoreLock>,
) -> Result<AgentPreview, String> {
    let _guard = lock
        .0
        .lock()
        .map_err(|_| "project store lock poisoned".to_string())?;
    let connection = open_projects(&app)?;
    let mut preview: AgentPreview = connection
        .query_row(
            "SELECT id, session_id, project_id, actions_json, status, created_at, confirmed_at FROM agent_previews WHERE id = ?1",
            [&preview_id],
            |row| Ok(AgentPreview { id: row.get(0)?, session_id: row.get(1)?, project_id: row.get(2)?, actions_json: row.get(3)?, status: row.get(4)?, created_at: row.get(5)?, confirmed_at: row.get(6)? }),
        )
        .map_err(|error| error.to_string())?;
    if preview.status != "pending" {
        return Err("agent preview has already been resolved".to_string());
    }
    preview.status = if confirm { "confirmed" } else { "rejected" }.to_string();
    preview.confirmed_at = confirm.then(|| Utc::now().to_rfc3339());
    connection
        .execute(
            "UPDATE agent_previews SET status = ?1, confirmed_at = ?2 WHERE id = ?3",
            params![preview.status, preview.confirmed_at, preview.id],
        )
        .map_err(|error| error.to_string())?;
    Ok(preview)
}

#[tauri::command]
fn execute_agent_preview(
    app: AppHandle,
    preview_id: String,
    lock: State<StoreLock>,
) -> Result<AgentExecution, String> {
    let _guard = lock
        .0
        .lock()
        .map_err(|_| "project store lock poisoned".to_string())?;
    let connection = open_projects(&app)?;
    let mut preview: AgentPreview = connection
        .query_row(
            "SELECT id, session_id, project_id, actions_json, status, created_at, confirmed_at FROM agent_previews WHERE id = ?1",
            [&preview_id],
            |row| Ok(AgentPreview { id: row.get(0)?, session_id: row.get(1)?, project_id: row.get(2)?, actions_json: row.get(3)?, status: row.get(4)?, created_at: row.get(5)?, confirmed_at: row.get(6)? }),
        )
        .map_err(|error| error.to_string())?;
    if preview.status != "confirmed" {
        return Err("agent preview must be confirmed before it can execute".to_string());
    }
    let project_id = preview
        .project_id
        .clone()
        .ok_or("a project is required for canvas actions".to_string())?;
    let actions: Vec<serde_json::Value> = serde_json::from_str(&preview.actions_json)
        .map_err(|error| format!("invalid confirmed agent preview: {error}"))?;
    if actions.iter().any(|action| matches!(action.get("type").and_then(serde_json::Value::as_str), Some("generateImage") | Some("generateVideo"))) {
        return Err("paid generation is not executed by an agent preview; use the generation form for a second confirmation".to_string());
    }
    if actions.iter().any(|action| action.get("type").and_then(serde_json::Value::as_str) == Some("connectImagesToVideo")) {
        return Err("use the canvas multi-image connection toolbar to choose a target video node explicitly".to_string());
    }
    let project = get_project_record_from_db(&connection, &project_id)?
        .ok_or("project not found".to_string())?;
    let mut nodes = project_nodes(&project)?;
    let mut edges = project_edges(&project)?;
    let before_nodes = nodes.clone();
    let before_edges = edges.clone();
    for action in actions {
        let kind = action.get("type").and_then(serde_json::Value::as_str).unwrap_or_default();
        let params = action.get("params").and_then(serde_json::Value::as_object).ok_or("agent action params are required".to_string())?;
        match kind {
            "createNodes" => {
                let items = params.get("nodes").and_then(serde_json::Value::as_array).ok_or("createNodes requires params.nodes".to_string())?;
                if items.len() > 20 { return Err("agent preview cannot create more than 20 nodes".to_string()); }
                for (index, item) in items.iter().enumerate() {
                    let requested_type = item.get("type").and_then(serde_json::Value::as_str).unwrap_or("text");
                    if !matches!(requested_type, "text" | "image" | "video") { return Err("agent nodes must be text, image, or video".to_string()); }
                    let label = item.get("label").and_then(serde_json::Value::as_str).unwrap_or(requested_type).chars().take(160).collect::<String>();
                    let prompt = item.get("prompt").and_then(serde_json::Value::as_str).unwrap_or_default().chars().take(4000).collect::<String>();
                    let x = item.get("x").and_then(serde_json::Value::as_f64).unwrap_or(80.0 + index as f64 * 36.0).clamp(-100_000.0, 100_000.0);
                    let y = item.get("y").and_then(serde_json::Value::as_f64).unwrap_or(80.0 + index as f64 * 36.0).clamp(-100_000.0, 100_000.0);
                    nodes.push(serde_json::json!({"id": format!("agent-{}", Uuid::new_v4()), "type": requested_type, "position": {"x": x, "y": y}, "data": {"label": label, "prompt": prompt}}));
                }
            }
            "updateNodePrompts" => {
                let updates = params.get("updates").and_then(serde_json::Value::as_array).ok_or("updateNodePrompts requires params.updates".to_string())?;
                for update in updates.iter().take(50) {
                    let id = update.get("id").and_then(serde_json::Value::as_str).ok_or("prompt update requires id".to_string())?;
                    let prompt = update.get("prompt").and_then(serde_json::Value::as_str).ok_or("prompt update requires prompt".to_string())?.chars().take(4000).collect::<String>();
                    if let Some(node) = nodes.iter_mut().find(|node| node_id(node) == Some(id)) {
                        let data = node.as_object_mut().ok_or("canvas node must be an object".to_string())?.entry("data").or_insert_with(|| serde_json::json!({}));
                        data.as_object_mut().ok_or("canvas node data must be an object".to_string())?.insert("prompt".to_string(), serde_json::Value::String(prompt));
                    }
                }
            }
            "deleteNodes" => {
                let ids = params.get("ids").and_then(serde_json::Value::as_array).ok_or("deleteNodes requires params.ids".to_string())?.iter().filter_map(serde_json::Value::as_str).collect::<Vec<_>>();
                nodes.retain(|node| !node_id(node).is_some_and(|id| ids.contains(&id)));
                edges.retain(|edge| !edge.get("source").and_then(serde_json::Value::as_str).is_some_and(|id| ids.contains(&id)) && !edge.get("target").and_then(serde_json::Value::as_str).is_some_and(|id| ids.contains(&id)));
            }
            "arrangeNodes" => {
                let ids = params.get("ids").and_then(serde_json::Value::as_array).ok_or("arrangeNodes requires params.ids".to_string())?.iter().filter_map(serde_json::Value::as_str).collect::<Vec<_>>();
                let vertical = params.get("direction").and_then(serde_json::Value::as_str) == Some("vertical");
                let mut selected = nodes.iter_mut().filter(|node| node_id(node).is_some_and(|id| ids.contains(&id))).collect::<Vec<_>>();
                selected.sort_by(|left, right| { let a = node_position(left); let b = node_position(right); if vertical { a.1.total_cmp(&b.1).then(a.0.total_cmp(&b.0)) } else { a.0.total_cmp(&b.0).then(a.1.total_cmp(&b.1)) } });
                let anchor_x = selected.iter().map(|node| node_position(node).0).fold(f64::INFINITY, f64::min);
                let anchor_y = selected.iter().map(|node| node_position(node).1).fold(f64::INFINITY, f64::min);
                let mut cursor = if vertical { anchor_y } else { anchor_x };
                for node in selected {
                    let size = node_size(node);
                    let position = node.as_object_mut().ok_or("canvas node must be an object".to_string())?.entry("position").or_insert_with(|| serde_json::json!({}));
                    let position = position.as_object_mut().ok_or("canvas node position must be an object".to_string())?;
                    position.insert("x".to_string(), serde_json::json!(if vertical { anchor_x } else { cursor }));
                    position.insert("y".to_string(), serde_json::json!(if vertical { cursor } else { anchor_y }));
                    cursor += if vertical { size.1 } else { size.0 } + 48.0;
                }
            }
            _ => return Err(format!("agent action '{kind}' cannot be executed")),
        }
    }
    let updated = write_project_canvas(&connection, &project, &nodes, &edges)?;
    record_canvas_batch_history(&connection, &project_id, "agent-preview", &before_nodes, &before_edges, &nodes, &edges)?;
    preview.status = "executed".to_string();
    connection.execute("UPDATE agent_previews SET status = ?1 WHERE id = ?2", params![preview.status, preview.id]).map_err(|error| error.to_string())?;
    Ok(AgentExecution { preview, project: updated })
}

fn project_nodes(project: &ProjectRecord) -> Result<Vec<serde_json::Value>, String> {
    serde_json::from_str(&project.nodes_json)
        .map_err(|error| format!("invalid project nodes: {error}"))
}

fn project_edges(project: &ProjectRecord) -> Result<Vec<serde_json::Value>, String> {
    serde_json::from_str(&project.edges_json)
        .map_err(|error| format!("invalid project edges: {error}"))
}

fn selected_canvas_nodes<'a>(
    nodes: &'a [serde_json::Value],
    ids: &[String],
) -> Vec<&'a serde_json::Value> {
    nodes
        .iter()
        .filter(|node| node_id(node).is_some_and(|id| ids.iter().any(|selected| selected == id)))
        .collect()
}

#[tauri::command]
fn find_project_for_canvas_selection(
    app: AppHandle,
    node_ids: Vec<String>,
    lock: State<StoreLock>,
) -> Result<Option<String>, String> {
    if node_ids.is_empty() {
        return Ok(None);
    }
    let _guard = lock
        .0
        .lock()
        .map_err(|_| "project store lock poisoned".to_string())?;
    for project in read_projects(&app)? {
        let nodes = project_nodes(&project)?;
        let present: Vec<&str> = nodes.iter().filter_map(node_id).collect();
        if node_ids
            .iter()
            .all(|id| present.iter().any(|present_id| present_id == id))
        {
            return Ok(Some(project.id));
        }
    }
    Ok(None)
}

#[tauri::command]
fn preview_canvas_batch_action(
    app: AppHandle,
    project_id: String,
    selected_node_ids: Vec<String>,
    lock: State<StoreLock>,
) -> Result<CanvasBatchPreview, String> {
    let _guard = lock
        .0
        .lock()
        .map_err(|_| "project store lock poisoned".to_string())?;
    let connection = open_projects(&app)?;
    let project = get_project_record_from_db(&connection, &project_id)?
        .ok_or("project not found".to_string())?;
    let nodes = project_nodes(&project)?;
    let selected = selected_canvas_nodes(&nodes, &selected_node_ids);
    let image_node_ids = selected
        .iter()
        .filter(|node| node_is_kind(node, "image"))
        .filter_map(|node| node_id(node).map(ToOwned::to_owned))
        .collect::<Vec<_>>();
    if image_node_ids.len() < 2 {
        return Err("select at least two image nodes".to_string());
    }
    let video_targets = selected
        .iter()
        .filter(|node| node_is_kind(node, "video"))
        .filter_map(|node| {
            node_id(node).map(|id| CanvasVideoTarget {
                id: id.to_string(),
                name: node_text(node),
            })
        })
        .collect();
    Ok(CanvasBatchPreview {
        project_id,
        image_node_ids,
        video_targets,
        can_create_video_node: true,
    })
}

#[tauri::command]
fn apply_canvas_batch_action(
    app: AppHandle,
    project_id: String,
    selected_node_ids: Vec<String>,
    action: String,
    target_video_node_id: Option<String>,
    lock: State<StoreLock>,
) -> Result<ProjectRecord, String> {
    let _guard = lock
        .0
        .lock()
        .map_err(|_| "project store lock poisoned".to_string())?;
    let connection = open_projects(&app)?;
    let project = get_project_record_from_db(&connection, &project_id)?
        .ok_or("project not found".to_string())?;
    let mut nodes = project_nodes(&project)?;
    let mut edges = project_edges(&project)?;
    let before_nodes = nodes.clone();
    let before_edges = edges.clone();
    let selected = selected_canvas_nodes(&nodes, &selected_node_ids);
    let mut image_ids = selected
        .iter()
        .filter(|node| node_is_kind(node, "image"))
        .filter_map(|node| node_id(node).map(ToOwned::to_owned))
        .collect::<Vec<_>>();
    if image_ids.len() < 2 {
        return Err("select at least two image nodes".to_string());
    }
    image_ids.sort_by(|left, right| {
        let left_node = nodes
            .iter()
            .find(|node| node_id(node) == Some(left.as_str()))
            .expect("selected node exists");
        let right_node = nodes
            .iter()
            .find(|node| node_id(node) == Some(right.as_str()))
            .expect("selected node exists");
        let left_position = node_position(left_node);
        let right_position = node_position(right_node);
        let primary = if action == "arrange-vertical" {
            left_position.1.total_cmp(&right_position.1)
        } else {
            left_position.0.total_cmp(&right_position.0)
        };
        let secondary = if action == "arrange-vertical" {
            left_position.0.total_cmp(&right_position.0)
        } else {
            left_position.1.total_cmp(&right_position.1)
        };
        primary.then(secondary).then(left.cmp(right))
    });

    match action.as_str() {
        "arrange-horizontal" | "arrange-vertical" => {
            let selected_images = nodes
                .iter()
                .filter(|node| {
                    image_ids
                        .iter()
                        .any(|id| node_id(node) == Some(id.as_str()))
                })
                .collect::<Vec<_>>();
            let anchor_x = selected_images
                .iter()
                .map(|node| node_position(node).0)
                .fold(f64::INFINITY, f64::min);
            let anchor_y = selected_images
                .iter()
                .map(|node| node_position(node).1)
                .fold(f64::INFINITY, f64::min);
            let mut cursor_x = anchor_x;
            let mut cursor_y = anchor_y;
            for id in &image_ids {
                let node = nodes
                    .iter_mut()
                    .find(|node| node_id(node) == Some(id.as_str()))
                    .expect("selected node exists");
                let size = node_size(node);
                let position = node
                    .as_object_mut()
                    .ok_or("canvas node must be an object".to_string())?
                    .entry("position")
                    .or_insert_with(|| serde_json::json!({}));
                let position = position
                    .as_object_mut()
                    .ok_or("canvas node position must be an object".to_string())?;
                position.insert("x".to_string(), serde_json::json!(cursor_x));
                position.insert("y".to_string(), serde_json::json!(cursor_y));
                if action == "arrange-horizontal" {
                    cursor_x += size.0 + 48.0;
                } else {
                    cursor_y += size.1 + 48.0;
                }
            }
        }
        "connect-video" => {
            let selected_videos = selected
                .iter()
                .filter(|node| node_is_kind(node, "video"))
                .filter_map(|node| node_id(node).map(ToOwned::to_owned))
                .collect::<Vec<_>>();
            let target_id = match (target_video_node_id, selected_videos.len()) {
                (Some(target), _) if selected_videos.iter().any(|id| id == &target) => target,
                (Some(_), _) => {
                    return Err("chosen video node is not part of the selection".to_string())
                }
                (None, 0) => {
                    let max_x = nodes
                        .iter()
                        .map(|node| node_position(node).0 + node_size(node).0)
                        .fold(0.0, f64::max);
                    let top_y = image_ids
                        .iter()
                        .filter_map(|id| {
                            nodes.iter().find(|node| node_id(node) == Some(id.as_str()))
                        })
                        .map(|node| node_position(node).1)
                        .fold(f64::INFINITY, f64::min);
                    let video_type = nodes
                        .iter()
                        .find(|node| node_is_kind(node, "video"))
                        .and_then(|node| node.get("type"))
                        .cloned()
                        .unwrap_or_else(|| serde_json::json!("video"));
                    let created_id = format!("video-{}", Uuid::new_v4());
                    nodes.push(serde_json::json!({
                        "id": created_id,
                        "type": video_type,
                        "position": {"x": max_x + 48.0, "y": if top_y.is_finite() { top_y } else { 0.0 }},
                        "data": {"label": "批量图生视频", "displayName": "批量图生视频", "videoMode": "image2video", "referenceImageNodeIds": image_ids}
                    }));
                    node_id(nodes.last().expect("new node exists"))
                        .expect("new node id exists")
                        .to_string()
                }
                (None, 1) => selected_videos[0].clone(),
                (None, _) => {
                    return Err("multiple video nodes selected; choose one target".to_string())
                }
            };
            for image_id in &image_ids {
                let duplicate = edges.iter().any(|edge| {
                    edge.get("source").and_then(serde_json::Value::as_str)
                        == Some(image_id.as_str())
                        && edge.get("target").and_then(serde_json::Value::as_str)
                            == Some(target_id.as_str())
                });
                if !duplicate {
                    edges.push(serde_json::json!({
                        "id": format!("batch-edge-{}", Uuid::new_v4()),
                        "source": image_id,
                        "target": target_id,
                        "type": "smoothstep"
                    }));
                }
            }
            if let Some(video) = nodes
                .iter_mut()
                .find(|node| node_id(node) == Some(target_id.as_str()))
            {
                let data = video
                    .as_object_mut()
                    .ok_or("canvas video node must be an object".to_string())?
                    .entry("data")
                    .or_insert_with(|| serde_json::json!({}));
                let data = data
                    .as_object_mut()
                    .ok_or("canvas video data must be an object".to_string())?;
                data.insert(
                    "referenceImageNodeIds".to_string(),
                    serde_json::json!(image_ids),
                );
                data.insert(
                    "requiresMultiReferenceConfirmation".to_string(),
                    serde_json::json!(true),
                );
            }
        }
        _ => return Err("unsupported canvas batch action".to_string()),
    }
    let updated = write_project_canvas(&connection, &project, &nodes, &edges)?;
    record_canvas_batch_history(
        &connection,
        &project_id,
        &action,
        &before_nodes,
        &before_edges,
        &nodes,
        &edges,
    )?;
    Ok(updated)
}

#[tauri::command]
fn undo_last_canvas_batch_action(
    app: AppHandle,
    project_id: String,
    lock: State<StoreLock>,
) -> Result<ProjectRecord, String> {
    let _guard = lock
        .0
        .lock()
        .map_err(|_| "project store lock poisoned".to_string())?;
    let connection = open_projects(&app)?;
    let (history_id, nodes_json, edges_json): (String, String, String) = connection
        .query_row(
            "SELECT id, before_nodes_json, before_edges_json FROM canvas_batch_history WHERE project_id = ?1 AND undone = 0 ORDER BY created_at DESC LIMIT 1",
            [&project_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .map_err(|_| "no canvas batch action to undo".to_string())?;
    let project = get_project_record_from_db(&connection, &project_id)?
        .ok_or("project not found".to_string())?;
    let nodes: Vec<serde_json::Value> =
        serde_json::from_str(&nodes_json).map_err(|error| error.to_string())?;
    let edges: Vec<serde_json::Value> =
        serde_json::from_str(&edges_json).map_err(|error| error.to_string())?;
    let updated = write_project_canvas(&connection, &project, &nodes, &edges)?;
    connection
        .execute(
            "UPDATE canvas_batch_history SET undone = 1 WHERE id = ?1",
            [history_id],
        )
        .map_err(|error| error.to_string())?;
    Ok(updated)
}

#[tauri::command]
fn redo_last_canvas_batch_action(
    app: AppHandle,
    project_id: String,
    lock: State<StoreLock>,
) -> Result<ProjectRecord, String> {
    let _guard = lock
        .0
        .lock()
        .map_err(|_| "project store lock poisoned".to_string())?;
    let connection = open_projects(&app)?;
    let (history_id, nodes_json, edges_json): (String, String, String) = connection
        .query_row(
            "SELECT id, after_nodes_json, after_edges_json FROM canvas_batch_history WHERE project_id = ?1 AND undone = 1 ORDER BY created_at DESC LIMIT 1",
            [&project_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .map_err(|_| "no canvas batch action to redo".to_string())?;
    let project = get_project_record_from_db(&connection, &project_id)?
        .ok_or("project not found".to_string())?;
    let nodes: Vec<serde_json::Value> =
        serde_json::from_str(&nodes_json).map_err(|error| error.to_string())?;
    let edges: Vec<serde_json::Value> =
        serde_json::from_str(&edges_json).map_err(|error| error.to_string())?;
    let updated = write_project_canvas(&connection, &project, &nodes, &edges)?;
    connection
        .execute(
            "UPDATE canvas_batch_history SET undone = 0 WHERE id = ?1",
            [history_id],
        )
        .map_err(|error| error.to_string())?;
    Ok(updated)
}

#[tauri::command]
fn set_api_key(
    app: AppHandle,
    provider: String,
    key: String,
    lock: State<StoreLock>,
) -> Result<(), String> {
    let _guard = lock
        .0
        .lock()
        .map_err(|_| "settings store lock poisoned".to_string())?;
    let mut settings: Settings = read_json(settings_path(&app)?)?;
    settings.api_keys.insert(provider, key);
    write_json(settings_path(&app)?, &settings)
}

#[tauri::command]
fn get_api_key(app: AppHandle, provider: String, lock: State<StoreLock>) -> Result<String, String> {
    let _guard = lock
        .0
        .lock()
        .map_err(|_| "settings store lock poisoned".to_string())?;
    Ok(read_json::<Settings>(settings_path(&app)?)?
        .api_keys
        .get(&provider)
        .cloned()
        .unwrap_or_default())
}

#[tauri::command]
fn set_base_url(
    app: AppHandle,
    provider: String,
    url: String,
    lock: State<StoreLock>,
) -> Result<(), String> {
    let _guard = lock
        .0
        .lock()
        .map_err(|_| "settings store lock poisoned".to_string())?;
    let mut settings: Settings = read_json(settings_path(&app)?)?;
    settings.base_urls.insert(provider, url);
    write_json(settings_path(&app)?, &settings)
}

#[tauri::command]
fn get_base_url(
    app: AppHandle,
    provider: String,
    lock: State<StoreLock>,
) -> Result<String, String> {
    let _guard = lock
        .0
        .lock()
        .map_err(|_| "settings store lock poisoned".to_string())?;
    Ok(read_json::<Settings>(settings_path(&app)?)?
        .base_urls
        .get(&provider)
        .cloned()
        .unwrap_or_default())
}

#[tauri::command]
fn save_settings_json(app: AppHandle, json: String, lock: State<StoreLock>) -> Result<(), String> {
    let _guard = lock
        .0
        .lock()
        .map_err(|_| "settings store lock poisoned".to_string())?;
    if !json.is_empty() {
        serde_json::from_str::<serde_json::Value>(&json)
            .map_err(|error| format!("invalid settings JSON: {error}"))?;
    }
    fs::write(ui_settings_path(&app)?, json).map_err(|error| error.to_string())
}

#[tauri::command]
fn load_settings_json(app: AppHandle, lock: State<StoreLock>) -> Result<String, String> {
    let _guard = lock
        .0
        .lock()
        .map_err(|_| "settings store lock poisoned".to_string())?;
    match fs::read_to_string(ui_settings_path(&app)?) {
        Ok(value) => Ok(value),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
        Err(error) => Err(error.to_string()),
    }
}

#[tauri::command]
fn register_custom_provider(
    app: AppHandle,
    config: serde_json::Value,
    lock: State<StoreLock>,
) -> Result<(), String> {
    let id = config
        .get("id")
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or("custom provider id is required")?;
    let name = config
        .get("name")
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or("custom provider name is required")?;
    let base_url = config
        .get("base_url")
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|value| value.starts_with("http://") || value.starts_with("https://"))
        .ok_or("custom provider base_url must be an HTTP(S) URL")?;
    let models = config
        .get("models")
        .and_then(serde_json::Value::as_array)
        .filter(|values| !values.is_empty())
        .ok_or("custom provider must include at least one model")?;
    if !models.iter().all(|model| model.is_string()) {
        return Err("custom provider models must be strings".to_string());
    }
    let normalized = serde_json::json!({
        "id": id,
        "name": name,
        "base_url": base_url.trim_end_matches('/'),
        "models": models,
    });
    let _guard = lock
        .0
        .lock()
        .map_err(|_| "settings store lock poisoned".to_string())?;
    let mut settings: Settings = read_json(settings_path(&app)?)?;
    settings
        .custom_providers
        .retain(|provider| provider.get("id").and_then(serde_json::Value::as_str) != Some(id));
    settings.custom_providers.push(normalized);
    write_json(settings_path(&app)?, &settings)
}

#[tauri::command]
fn unregister_custom_provider(
    app: AppHandle,
    provider_id: String,
    lock: State<StoreLock>,
) -> Result<(), String> {
    let _guard = lock
        .0
        .lock()
        .map_err(|_| "settings store lock poisoned".to_string())?;
    let mut settings: Settings = read_json(settings_path(&app)?)?;
    let original_len = settings.custom_providers.len();
    settings.custom_providers.retain(|provider| {
        provider.get("id").and_then(serde_json::Value::as_str) != Some(provider_id.as_str())
    });
    if settings.custom_providers.len() == original_len {
        return Err("custom provider not found".to_string());
    }
    write_json(settings_path(&app)?, &settings)
}

#[tauri::command]
fn list_models(app: AppHandle, lock: State<StoreLock>) -> Result<Vec<String>, String> {
    let _guard = lock
        .0
        .lock()
        .map_err(|_| "settings store lock poisoned".to_string())?;
    let settings: Settings = read_json(settings_path(&app)?)?;
    let mut models = vec![
        "grsai/gpt-image-2".to_string(),
        "grsai/gpt-image-2-1k".to_string(),
    ];
    for provider in settings.custom_providers {
        let Some(provider_id) = provider.get("id").and_then(serde_json::Value::as_str) else {
            continue;
        };
        let Some(provider_models) = provider.get("models").and_then(serde_json::Value::as_array)
        else {
            continue;
        };
        models.extend(
            provider_models
                .iter()
                .filter_map(serde_json::Value::as_str)
                .map(|model| {
                    if model.contains('/') {
                        model.to_string()
                    } else {
                        format!("{provider_id}/{model}")
                    }
                }),
        );
    }
    models.sort();
    models.dedup();
    Ok(models)
}

#[tauri::command]
async fn list_remote_models(base_url: String, api_key: String) -> Result<Vec<String>, String> {
    if api_key.trim().is_empty() {
        return Err("请先填写 API Key".to_string());
    }
    let endpoint = models_endpoint(&base_url)?;
    let response = Client::new()
        .get(endpoint)
        .bearer_auth(api_key.trim())
        .header("Accept", "application/json")
        .send()
        .await
        .map_err(|error| format!("获取模型失败: {error}"))?;
    let status = response.status();
    let body = response
        .text()
        .await
        .map_err(|error| format!("读取模型响应失败: {error}"))?;
    if !status.is_success() {
        return Err(format!("获取模型失败 ({status}): {body}"));
    }
    let models = strings_from_models(
        &serde_json::from_str(&body).map_err(|error| format!("模型响应不是 JSON: {error}"))?,
    );
    if models.is_empty() {
        return Err("模型接口没有返回可用模型".to_string());
    }
    Ok(models)
}

#[tauri::command]
async fn auth_login(
    app: AppHandle,
    email: String,
    password: String,
) -> Result<serde_json::Value, String> {
    if email.trim().is_empty() || password.is_empty() {
        return Err("邮箱和密码不能为空".to_string());
    }
    let client = Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|error| error.to_string())?;
    let value = service_json_request(
        client
            .post(service_endpoint(&app, "/api/auth/login")?)
            .json(&serde_json::json!({"email": email.trim(), "password": password})),
        "登录",
    )
    .await?;
    let session = auth_session_from_response(&value);
    if session.token.is_empty() || session.user.is_none() {
        return Err("登录响应缺少令牌或用户信息".to_string());
    }
    write_json(auth_session_path(&app)?, &session)?;
    Ok(session.user.unwrap_or(serde_json::Value::Null))
}

#[tauri::command]
async fn auth_register(
    app: AppHandle,
    email: String,
    password: String,
) -> Result<serde_json::Value, String> {
    if email.trim().is_empty() || password.len() < 6 {
        return Err("请输入邮箱和至少 6 位密码".to_string());
    }
    let client = Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|error| error.to_string())?;
    let value = service_json_request(
        client
            .post(service_endpoint(&app, "/api/auth/register")?)
            .json(&serde_json::json!({"email": email.trim(), "password": password})),
        "注册",
    )
    .await?;
    let session = auth_session_from_response(&value);
    if session.token.is_empty() || session.user.is_none() {
        return Err("注册响应缺少令牌或用户信息".to_string());
    }
    write_json(auth_session_path(&app)?, &session)?;
    Ok(session.user.unwrap_or(serde_json::Value::Null))
}

#[tauri::command]
async fn auth_logout(app: AppHandle) -> Result<(), String> {
    let session: AuthSession = read_json(auth_session_path(&app)?)?;
    if !session.token.is_empty() {
        let client = Client::builder()
            .timeout(std::time::Duration::from_secs(15))
            .build()
            .map_err(|error| error.to_string())?;
        let _ = service_json_request(
            client
                .post(service_endpoint(&app, "/api/auth/logout")?)
                .bearer_auth(&session.token),
            "退出登录",
        )
        .await;
    }
    let path = auth_session_path(&app)?;
    if path.exists() {
        fs::remove_file(path).map_err(|error| error.to_string())?;
    }
    Ok(())
}

#[tauri::command]
async fn get_auth_state(app: AppHandle) -> Result<serde_json::Value, String> {
    let session: AuthSession = read_json(auth_session_path(&app)?)?;
    if session.token.is_empty() {
        return Ok(serde_json::json!({"authenticated": false, "reason": "未登录"}));
    }
    let user = session.user.unwrap_or_else(|| serde_json::json!({}));
    Ok(serde_json::json!({"authenticated": true, "user": user}))
}

#[tauri::command]
fn get_auth_token(app: AppHandle) -> Result<String, String> {
    Ok(read_json::<AuthSession>(auth_session_path(&app)?)?.token)
}

#[tauri::command]
fn credits_machine_id(app: AppHandle) -> Result<String, String> {
    let path = machine_id_path(&app)?;
    match fs::read_to_string(&path) {
        Ok(value) if !value.trim().is_empty() => Ok(value.trim().to_string()),
        Ok(_) | Err(_) => {
            let id = Uuid::new_v4().to_string();
            fs::write(path, &id).map_err(|error| error.to_string())?;
            Ok(id)
        }
    }
}

#[tauri::command]
async fn credits_balance(app: AppHandle, machine_id: String, token: String) -> Result<serde_json::Value, String> {
    let client = Client::builder()
        .timeout(std::time::Duration::from_secs(20))
        .build()
        .map_err(|error| error.to_string())?;
    let request = client
        .get(service_endpoint(&app, "/api/credits/balance")?)
        .query(&[("user_id", machine_id)]);
    let request = if token.trim().is_empty() {
        request
    } else {
        request.bearer_auth(token.trim())
    };
    service_json_request(request, "查询积分").await
}

#[tauri::command]
async fn credits_deduct(
    app: AppHandle,
    machine_id: String,
    provider: String,
    model: String,
    mode: String,
    duration: String,
    job_id: String,
    token: String,
) -> Result<serde_json::Value, String> {
    let client = Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|error| error.to_string())?;
    let request = client
        .post(service_endpoint(&app, "/api/credits/deduct")?)
        .json(&serde_json::json!({
            "machine_id": machine_id,
            "provider": provider,
            "model": model,
            "mode": mode,
            "duration": duration,
            "job_id": job_id,
        }));
    let request = if token.trim().is_empty() {
        request
    } else {
        request.bearer_auth(token.trim())
    };
    service_json_request(request, "扣除积分").await
}

#[tauri::command]
async fn credits_refund(
    app: AppHandle,
    machine_id: String,
    job_id: String,
    provider: String,
    reason: String,
    token: String,
) -> Result<serde_json::Value, String> {
    let client = Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|error| error.to_string())?;
    let request = client
        .post(service_endpoint(&app, "/api/credits/refund")?)
        .query(&[("user_id", machine_id)])
        .json(&serde_json::json!({
            "job_id": job_id,
            "provider": provider,
            "reason": reason,
        }));
    let request = if token.trim().is_empty() {
        request
    } else {
        request.bearer_auth(token.trim())
    };
    service_json_request(request, "退还积分").await
}

#[tauri::command]
fn jimeng_save_sessionid(app: AppHandle, sessionid: String) -> Result<(), String> {
    let sessionid = sessionid.trim();
    if sessionid.len() < 8 {
        return Err("即梦 sessionid 无效".to_string());
    }
    fs::write(jimeng_session_path(&app)?, sessionid).map_err(|error| error.to_string())
}

#[tauri::command]
fn jimeng_check_sessionid(app: AppHandle) -> Result<bool, String> {
    Ok(fs::read_to_string(jimeng_session_path(&app)?)
        .map(|value| value.trim().len() >= 8)
        .unwrap_or(false))
}

#[tauri::command]
fn jimeng_poll_sessionid(app: AppHandle) -> Result<bool, String> {
    jimeng_check_sessionid(app)
}

#[tauri::command]
fn jimeng_delete_sessionid(app: AppHandle) -> Result<(), String> {
    let path = jimeng_session_path(&app)?;
    if path.exists() {
        fs::remove_file(path).map_err(|error| error.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn jimeng_browser_check_env(app: AppHandle) -> Result<serde_json::Value, String> {
    run_jimeng_browser(&app, "check_env", serde_json::json!({}))
}

#[tauri::command]
fn jimeng_browser_install(app: AppHandle) -> Result<serde_json::Value, String> {
    run_jimeng_browser(&app, "install_playwright", serde_json::json!({}))
}

#[tauri::command]
fn jimeng_browser_open_login(
    app: AppHandle,
    browser_exe: Option<String>,
) -> Result<serde_json::Value, String> {
    run_jimeng_browser(
        &app,
        "open_login_browser",
        serde_json::json!({"browser_exe": browser_exe}),
    )
}

#[tauri::command]
fn jimeng_login_window(app: AppHandle) -> Result<serde_json::Value, String> {
    jimeng_browser_open_login(app, None)
}

#[tauri::command]
fn jimeng_browser_generate(
    app: AppHandle,
    params: serde_json::Value,
) -> Result<serde_json::Value, String> {
    run_jimeng_browser(&app, "generate_browser", params)
}

#[tauri::command]
fn jimeng_submit_video(app: AppHandle, payload: String) -> Result<String, String> {
    let mut params: serde_json::Value = serde_json::from_str(&payload)
        .map_err(|error| format!("invalid Jimeng payload: {error}"))?;
    if params.get("sessionid").is_none() {
        let sessionid = fs::read_to_string(jimeng_session_path(&app)?)
            .map_err(|_| "请先登录即梦官网或填入 sessionid".to_string())?;
        params["sessionid"] = serde_json::Value::String(sessionid.trim().to_string());
    }
    let event = run_jimeng_browser(&app, "generate_http", params)?;
    event
        .get("video_path")
        .or_else(|| event.get("video_url"))
        .and_then(serde_json::Value::as_str)
        .map(ToOwned::to_owned)
        .ok_or("即梦未返回视频路径".to_string())
}

#[tauri::command]
async fn submit_generate_image_job(
    app: AppHandle,
    payload: String,
    lock: State<'_, StoreLock>,
) -> Result<String, String> {
    let request: serde_json::Value = serde_json::from_str(&payload)
        .map_err(|error| format!("invalid image request: {error}"))?;
    let provider_id = request
        .get("provider_id")
        .and_then(serde_json::Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or("image request is missing provider_id")?
        .to_string();
    let (base_url, api_key) = provider_credentials(&app, &provider_id)?;
    let mut job = GenerationJob {
        job_id: Uuid::new_v4().to_string(),
        provider_id,
        kind: "image".to_string(),
        status: "pending".to_string(),
        progress: 0,
        result: None,
        error: None,
        remote_job_id: None,
        updated_at: Utc::now().to_rfc3339(),
    };
    {
        let _guard = lock
            .0
            .lock()
            .map_err(|_| "generation job lock poisoned".to_string())?;
        save_generation_job(&open_projects(&app)?, &job)?;
    }
    let endpoint = provider_endpoint(&base_url, "images/generations")?;
    let response = Client::builder()
        .timeout(std::time::Duration::from_secs(120))
        .build()
        .map_err(|error| error.to_string())?
        .post(endpoint)
        .bearer_auth(api_key)
        .json(&request)
        .send()
        .await;
    match response {
        Ok(response) => {
            let status = response.status();
            let body = response
                .text()
                .await
                .map_err(|error| format!("读取图片生成响应失败: {error}"))?;
            if !status.is_success() {
                job.status = "failed".to_string();
                job.error = Some(format!("图片生成请求失败 ({status}): {body}"));
            } else {
                let value: serde_json::Value = serde_json::from_str(&body)
                    .map_err(|error| format!("图片生成响应不是 JSON: {error}"))?;
                job.result = image_result_from_response(&value);
                job.remote_job_id = remote_job_id_from_response(&value);
                job.status = if job.result.is_some() {
                    "succeeded".to_string()
                } else {
                    response_status(&value, "pending")
                };
                job.progress = if job.status == "succeeded" { 100 } else { 0 };
                job.error = value
                    .get("error")
                    .and_then(serde_json::Value::as_str)
                    .map(ToOwned::to_owned);
            }
        }
        Err(error) => {
            job.status = "failed".to_string();
            job.error = Some(format!("图片生成请求失败: {error}"));
        }
    }
    job.updated_at = Utc::now().to_rfc3339();
    {
        let _guard = lock
            .0
            .lock()
            .map_err(|_| "generation job lock poisoned".to_string())?;
        save_generation_job(&open_projects(&app)?, &job)?;
    }
    if job.status == "failed" {
        return Err(job.error.unwrap_or_else(|| "图片生成失败".to_string()));
    }
    Ok(job.job_id)
}

#[tauri::command]
async fn get_generate_image_job(
    app: AppHandle,
    job_id: String,
    lock: State<'_, StoreLock>,
) -> Result<GenerationJob, String> {
    let mut job = {
        let _guard = lock
            .0
            .lock()
            .map_err(|_| "generation job lock poisoned".to_string())?;
        get_generation_job(&open_projects(&app)?, &job_id)?.ok_or("generation job not found")?
    };
    if job.kind != "image" || job.status != "pending" || job.remote_job_id.is_none() {
        return Ok(job);
    }
    let (base_url, api_key) = provider_credentials(&app, &job.provider_id)?;
    let endpoint = provider_endpoint(
        &base_url,
        &format!(
            "images/generations/{}",
            job.remote_job_id.as_deref().unwrap_or_default()
        ),
    )?;
    let response = Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|error| error.to_string())?
        .get(endpoint)
        .bearer_auth(api_key)
        .send()
        .await;
    match response {
        Ok(response) if response.status().is_success() => {
            let value: serde_json::Value = response
                .json()
                .await
                .map_err(|error| format!("生成任务响应不是 JSON: {error}"))?;
            job.result = image_result_from_response(&value).or(job.result);
            job.status = if job.result.is_some() {
                "succeeded".to_string()
            } else {
                response_status(&value, "pending")
            };
            job.progress = value
                .get("progress")
                .and_then(serde_json::Value::as_u64)
                .map(|value| value.min(100) as u8)
                .unwrap_or(if job.status == "succeeded" { 100 } else { 0 });
            job.error = value
                .get("error")
                .and_then(serde_json::Value::as_str)
                .map(ToOwned::to_owned);
        }
        Ok(response) => {
            job.status = "failed".to_string();
            job.error = Some(format!("查询图片任务失败 ({})", response.status()));
        }
        Err(error) => {
            job.status = "failed".to_string();
            job.error = Some(format!("查询图片任务失败: {error}"));
        }
    }
    job.updated_at = Utc::now().to_rfc3339();
    {
        let _guard = lock
            .0
            .lock()
            .map_err(|_| "generation job lock poisoned".to_string())?;
        save_generation_job(&open_projects(&app)?, &job)?;
    }
    Ok(job)
}

#[tauri::command]
async fn generate_image(
    app: AppHandle,
    provider: String,
    payload: String,
) -> Result<String, String> {
    let mut request: serde_json::Value = serde_json::from_str(&payload)
        .map_err(|error| format!("invalid image request: {error}"))?;
    if request.get("provider_id").is_none() {
        request["provider_id"] = serde_json::Value::String(provider.clone());
    }
    let (base_url, api_key) = provider_credentials(&app, &provider)?;
    let response = Client::builder()
        .timeout(std::time::Duration::from_secs(120))
        .build()
        .map_err(|error| error.to_string())?
        .post(provider_endpoint(&base_url, "images/generations")?)
        .bearer_auth(api_key)
        .json(&request)
        .send()
        .await
        .map_err(|error| format!("图片生成请求失败: {error}"))?;
    let status = response.status();
    let value: serde_json::Value = response
        .json()
        .await
        .map_err(|error| format!("图片生成响应不是 JSON: {error}"))?;
    if !status.is_success() {
        return Err(format!("图片生成失败 ({status}): {value}"));
    }
    image_result_from_response(&value).ok_or("图片生成响应未包含结果".to_string())
}

#[tauri::command]
async fn generate_tts(app: AppHandle, payload: String) -> Result<String, String> {
    let request: serde_json::Value =
        serde_json::from_str(&payload).map_err(|error| format!("invalid TTS request: {error}"))?;
    let provider = request
        .get("provider")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("grsai");
    let (base_url, api_key) = provider_credentials(&app, provider)?;
    let response = Client::builder()
        .timeout(std::time::Duration::from_secs(120))
        .build()
        .map_err(|error| error.to_string())?
        .post(provider_endpoint(&base_url, "audio/speech")?)
        .bearer_auth(api_key)
        .json(&request)
        .send()
        .await
        .map_err(|error| format!("TTS 请求失败: {error}"))?;
    let status = response.status();
    if !status.is_success() {
        return Err(format!(
            "TTS 请求失败 ({status}): {}",
            response.text().await.unwrap_or_default()
        ));
    }
    let bytes = response
        .bytes()
        .await
        .map_err(|error| format!("读取 TTS 音频失败: {error}"))?;
    if bytes.is_empty() {
        return Err("TTS 返回了空音频".to_string());
    }
    write_media_bytes(&app, "audio", &bytes, "mp3")
}

#[tauri::command]
async fn submit_generate_video_job(
    app: AppHandle,
    payload: String,
    lock: State<'_, StoreLock>,
) -> Result<String, String> {
    let request: serde_json::Value = serde_json::from_str(&payload)
        .map_err(|error| format!("invalid video request: {error}"))?;
    let provider_id = request
        .get("provider_id")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("vjimeng")
        .to_string();
    let (base_url, api_key) = match (
        request.get("base_url").and_then(serde_json::Value::as_str),
        request.get("api_key").and_then(serde_json::Value::as_str),
    ) {
        (Some(base), Some(key)) if !base.trim().is_empty() && !key.trim().is_empty() => {
            (base.to_string(), key.to_string())
        }
        _ => provider_credentials(&app, &provider_id)?,
    };
    let mut job = GenerationJob {
        job_id: Uuid::new_v4().to_string(),
        provider_id,
        kind: "video".to_string(),
        status: "pending".to_string(),
        progress: 0,
        result: None,
        error: None,
        remote_job_id: None,
        updated_at: Utc::now().to_rfc3339(),
    };
    {
        let _guard = lock
            .0
            .lock()
            .map_err(|_| "generation job lock poisoned".to_string())?;
        save_generation_job(&open_projects(&app)?, &job)?;
    }
    let response = Client::builder()
        .timeout(std::time::Duration::from_secs(120))
        .build()
        .map_err(|error| error.to_string())?
        .post(provider_endpoint(&base_url, "video/generations")?)
        .bearer_auth(api_key)
        .json(&request)
        .send()
        .await;
    match response {
        Ok(response) => {
            let status = response.status();
            let value: serde_json::Value = response
                .json()
                .await
                .map_err(|error| format!("视频生成响应不是 JSON: {error}"))?;
            if !status.is_success() {
                job.status = "failed".to_string();
                job.error = Some(format!("视频生成失败 ({status}): {value}"));
            } else {
                job.result = image_result_from_response(&value);
                job.remote_job_id = remote_job_id_from_response(&value);
                job.status = if job.result.is_some() {
                    "succeeded".to_string()
                } else {
                    response_status(&value, "pending")
                };
                job.progress = if job.status == "succeeded" { 100 } else { 0 };
            }
        }
        Err(error) => {
            job.status = "failed".to_string();
            job.error = Some(format!("视频生成请求失败: {error}"));
        }
    }
    job.updated_at = Utc::now().to_rfc3339();
    {
        let _guard = lock
            .0
            .lock()
            .map_err(|_| "generation job lock poisoned".to_string())?;
        save_generation_job(&open_projects(&app)?, &job)?;
    }
    if job.status == "failed" {
        Err(job.error.unwrap_or_else(|| "视频生成失败".to_string()))
    } else {
        Ok(job.job_id)
    }
}

#[tauri::command]
async fn get_generate_video_job(
    app: AppHandle,
    job_id: String,
    lock: State<'_, StoreLock>,
) -> Result<GenerationJob, String> {
    let mut job = {
        let _guard = lock
            .0
            .lock()
            .map_err(|_| "generation job lock poisoned".to_string())?;
        get_generation_job(&open_projects(&app)?, &job_id)?.ok_or("generation job not found")?
    };
    if job.kind != "video" {
        return Err("generation job is not a video job".to_string());
    }
    if job.status != "pending" || job.remote_job_id.is_none() {
        return Ok(job);
    }
    let (base_url, api_key) = provider_credentials(&app, &job.provider_id)?;
    let endpoint = provider_endpoint(
        &base_url,
        &format!(
            "video/generations/{}",
            job.remote_job_id.as_deref().unwrap_or_default()
        ),
    )?;
    let response = Client::builder()
        .timeout(std::time::Duration::from_secs(45))
        .build()
        .map_err(|error| error.to_string())?
        .get(endpoint)
        .bearer_auth(api_key)
        .send()
        .await;
    match response {
        Ok(response) if response.status().is_success() => {
            let value: serde_json::Value = response
                .json()
                .await
                .map_err(|error| format!("视频任务响应不是 JSON: {error}"))?;
            job.result = image_result_from_response(&value).or(job.result);
            job.status = if job.result.is_some() {
                "succeeded".to_string()
            } else {
                response_status(&value, "pending")
            };
            job.progress = value
                .pointer("/data/progress")
                .or_else(|| value.get("progress"))
                .and_then(serde_json::Value::as_u64)
                .map(|value| value.min(100) as u8)
                .unwrap_or(if job.status == "succeeded" { 100 } else { 0 });
            job.error = value
                .pointer("/data/fail_reason")
                .or_else(|| value.get("error"))
                .and_then(serde_json::Value::as_str)
                .map(ToOwned::to_owned);
        }
        Ok(response) => {
            job.status = "failed".to_string();
            job.error = Some(format!("查询视频任务失败 ({})", response.status()));
        }
        Err(error) => {
            job.status = "failed".to_string();
            job.error = Some(format!("查询视频任务失败: {error}"));
        }
    }
    job.updated_at = Utc::now().to_rfc3339();
    let _guard = lock
        .0
        .lock()
        .map_err(|_| "generation job lock poisoned".to_string())?;
    save_generation_job(&open_projects(&app)?, &job)?;
    Ok(job)
}

#[tauri::command]
fn jimeng_get_video_status(job_id: String) -> Result<serde_json::Value, String> {
    let path = PathBuf::from(&job_id);
    if path.is_file() || job_id.starts_with("http://") || job_id.starts_with("https://") {
        Ok(serde_json::json!({"status":"succeeded", "result":job_id, "progress":100}))
    } else {
        Err("即梦任务状态需要由当前浏览器生成会话查询".to_string())
    }
}

#[tauri::command]
fn get_default_save_dir() -> String {
    dirs::download_dir()
        .unwrap_or_else(|| std::env::temp_dir())
        .display()
        .to_string()
}

#[tauri::command]
fn validate_save_dir(path: String) -> bool {
    let path = PathBuf::from(path);
    path.is_dir() || fs::create_dir_all(path).is_ok()
}

#[tauri::command]
async fn check_for_update(app: AppHandle) -> Result<Option<UpdateInfo>, String> {
    let update = app
        .updater()
        .map_err(|error| format!("无法初始化更新服务：{error}"))?
        .check()
        .await
        .map_err(|error| format!("检查更新失败：{error}"))?;

    Ok(update.map(|update| UpdateInfo {
        current_version: update.current_version,
        version: update.version,
        date: update.date.map(|date| date.to_string()),
        notes: update.body,
    }))
}

#[tauri::command]
async fn install_available_update(app: AppHandle) -> Result<(), String> {
    let update = app
        .updater()
        .map_err(|error| format!("无法初始化更新服务：{error}"))?
        .check()
        .await
        .map_err(|error| format!("检查更新失败：{error}"))?
        .ok_or_else(|| "当前已是最新版本。".to_string())?;

    update
        .download_and_install(|_, _| {}, || {})
        .await
        .map_err(|error| format!("下载或验证更新失败：{error}"))
}

#[tauri::command]
fn app_version() -> &'static str {
    env!("CARGO_PKG_VERSION")
}

#[tauri::command]
fn open_project_homepage() -> Result<(), String> {
    // Explorer delegates HTTPS URLs to the user's configured default browser.  The
    // target is a fixed project URL, never user-supplied command input.
    Command::new("explorer.exe")
        .arg(PROJECT_HOMEPAGE)
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("无法打开项目主页：{error}"))
}

#[tauri::command]
fn minimize_window(window: WebviewWindow) -> Result<(), String> {
    window.minimize().map_err(|error| error.to_string())
}

#[tauri::command]
fn toggle_maximize_window(window: WebviewWindow) -> Result<(), String> {
    let maximized = window.is_maximized().map_err(|error| error.to_string())?;
    if maximized {
        window.unmaximize().map_err(|error| error.to_string())
    } else {
        window.maximize().map_err(|error| error.to_string())
    }
}

#[tauri::command]
fn close_window(window: WebviewWindow) -> Result<(), String> {
    window.close().map_err(|error| error.to_string())
}

#[tauri::command]
fn center(window: WebviewWindow) -> Result<(), String> {
    window.center().map_err(|error| error.to_string())
}

#[tauri::command]
fn export_to_animate(app: AppHandle, image_path: String) -> Result<(), String> {
    let source = persist_media_source(&app, "images", image_path)?;
    let path = PathBuf::from(source);
    if !path.is_file() {
        return Err("远程图片需先保存到本地后再导出".to_string());
    }
    // Adobe Animate accepts pasted bitmap data. This keeps the integration independent of a
    // particular Animate installation path or version.
    copy_image_to_windows_clipboard(&path)
}

#[tauri::command]
fn query_task_token(
    app: AppHandle,
    job_id: String,
    lock: State<StoreLock>,
) -> Result<GenerationJob, String> {
    let _guard = lock
        .0
        .lock()
        .map_err(|_| "generation job lock poisoned".to_string())?;
    get_generation_job(&open_projects(&app)?, &job_id)?
        .ok_or("generation job not found".to_string())
}

fn main() {
    tauri::Builder::default()
        .manage(StoreLock::default())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            let webview_data = PathBuf::from(r"F:\Huahaihuabu\花海画布\webview");
            fs::create_dir_all(&webview_data)?;
            WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title("花海画布")
                .inner_size(1280.0, 800.0)
                .min_inner_size(960.0, 640.0)
                .resizable(true)
                .data_directory(webview_data)
                .build()?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            list_assets,
            add_asset,
            update_asset,
            delete_asset,
            clear_assets,
            persist_image_source,
            persist_image_binary,
            persist_video_source,
            persist_video_binary,
            persist_audio_source,
            save_image_to_downloads,
            copy_image_to_clipboard,
            copy_image_source_to_clipboard,
            get_video_duration,
            extract_audio_from_video,
            compose_videos_sequential,
            remove_video_watermark,
            remove_video_subtitles,
            upscale_video,
            split_image_source,
            merge_storyboard_images,
            prepare_node_image_source,
            embed_storyboard_image_metadata,
            read_storyboard_image_metadata,
            remove_bg,
            list_project_summaries,
            get_project_record,
            upsert_project_record,
            rename_project_record,
            delete_project_record,
            update_project_viewport_record,
            export_project_to_file,
            import_project_from_file,
            list_chat_sessions,
            create_chat_session,
            list_chat_messages,
            send_chat_message,
            create_agent_preview,
            resolve_agent_preview,
            execute_agent_preview,
            find_project_for_canvas_selection,
            preview_canvas_batch_action,
            apply_canvas_batch_action,
            undo_last_canvas_batch_action,
            redo_last_canvas_batch_action,
            set_api_key,
            get_api_key,
            set_base_url,
            get_base_url,
            save_settings_json,
            load_settings_json,
            register_custom_provider,
            unregister_custom_provider,
            list_models,
            list_remote_models,
            auth_login,
            auth_register,
            auth_logout,
            get_auth_state,
            get_auth_token,
            credits_machine_id,
            credits_balance,
            credits_deduct,
            credits_refund,
            jimeng_save_sessionid,
            jimeng_check_sessionid,
            jimeng_poll_sessionid,
            jimeng_delete_sessionid,
            jimeng_browser_check_env,
            jimeng_browser_install,
            jimeng_browser_open_login,
            jimeng_login_window,
            jimeng_browser_generate,
            jimeng_submit_video,
            submit_generate_image_job,
            get_generate_image_job,
            generate_image,
            generate_tts,
            submit_generate_video_job,
            get_generate_video_job,
            jimeng_get_video_status,
            get_default_save_dir,
            validate_save_dir,
            check_for_update,
            install_available_update,
            app_version,
            open_project_homepage,
            minimize_window,
            toggle_maximize_window,
            close_window,
            center,
            export_to_animate,
            query_task_token,
        ])
        .run(tauri::generate_context!())
        .expect("failed to run 花海画布");
}
