//! One paid request per approved job. Transport errors are never automatically retried.
use super::{settings::Settings, Request};
use base64::{engine::general_purpose::STANDARD, Engine};
use futures::StreamExt;
use serde_json::{json, Value};

pub const OUTPUT_LIMIT: usize = 20 * 1024 * 1024;

pub async fn limited(response: reqwest::Response, limit: usize) -> Result<Vec<u8>, String> {
    if response
        .content_length()
        .is_some_and(|size| size > limit as u64)
    {
        return Err("图片响应超过大小限制".into());
    }
    let mut body = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|_| "图片响应中断")?;
        if chunk.len() > limit.saturating_sub(body.len()) {
            return Err("图片响应超过大小限制".into());
        }
        body.extend_from_slice(&chunk);
    }
    Ok(body)
}

pub fn payload(request: &Request, references: &[(String, Vec<u8>)]) -> Value {
    let mut body = json!({"model":request.model,"prompt":request.prompt,
        "size":request.size,"quality":request.quality,"n":1,"output_format":"png"});
    if !references.is_empty() {
        body["images"] = json!(references.iter().map(|(mime, bytes)|
            json!({"image_url":format!("data:{mime};base64,{}",STANDARD.encode(bytes))})).collect::<Vec<_>>());
    }
    body
}

pub fn decode(body: &[u8]) -> Result<(Vec<u8>, Value), String> {
    let value: Value = serde_json::from_slice(body).map_err(|_| "生图服务响应格式无效")?;
    let images = value["data"]
        .as_array()
        .filter(|v| v.len() == 1)
        .ok_or("生图结果数量无效")?;
    let encoded = images[0]["b64_json"]
        .as_str()
        .ok_or("生图服务未返回图片数据")?;
    if encoded.len() > OUTPUT_LIMIT * 4 / 3 + 4 {
        return Err("生图结果过大".into());
    }
    let bytes = STANDARD.decode(encoded).map_err(|_| "生图数据编码无效")?;
    if bytes.len() > OUTPUT_LIMIT || crate::utils::sniff_image_ext(&bytes) != Some("png") {
        return Err("生图结果不是有效的 PNG 图片".into());
    }
    Ok((bytes, value.get("usage").cloned().unwrap_or(Value::Null)))
}

pub async fn generate(
    settings: Settings,
    request: &Request,
    references: &[(String, Vec<u8>)],
) -> Result<(Vec<u8>, Value), String> {
    let endpoint = if references.is_empty() {
        "generations"
    } else {
        "edits"
    };
    let client =
        super::transport::client(settings.proxy.as_ref()).map_err(|_| "无法初始化生图客户端")?;
    let response = client
        .post(format!("{}/images/{endpoint}", settings.base))
        .bearer_auth(&settings.key)
        .json(&payload(request, references))
        .send()
        .await
        .map_err(|error| {
            tracing::warn!(
                connect = error.is_connect(),
                timeout = error.is_timeout(),
                "image provider transport failed; no automatic retry"
            );
            if error.is_connect() {
                "无法连接生图服务，请检查服务器出站网络；不会自动重试"
            } else {
                "请求中断或超时，结果未知；请核实服务商记录后再创建新任务"
            }
        })?;
    if !response.status().is_success() {
        // Do not copy provider errors, request URLs or credentials into public messages.
        tracing::warn!(status=%response.status(),"image provider rejected approved request");
        return Err(match response.status().as_u16() {
            401 => "生图服务鉴权失败，请核对 API 服务地址与密钥是否匹配",
            403 => "生图服务拒绝访问，请核对模型权限、组织验证或服务地区限制",
            429 => "生图服务额度不足或请求受限，请查看服务商控制台",
            400 | 404 | 422 => "生图服务不接受此模型或参数，请核对服务商支持的模型与接口",
            _ => "生图服务暂不可用，请查看服务商状态；不会自动重试",
        }
        .into());
    }
    decode(&limited(response, OUTPUT_LIMIT * 4 / 3 + 128 * 1024).await?)
}
