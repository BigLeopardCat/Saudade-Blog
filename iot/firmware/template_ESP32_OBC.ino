/**
 * OBC (One-Board Controller) 固件模板
 * 基于 ESP32 + Arduino 框架
 *
 * 功能：
 *   - MQTT 连接平台（见下面 MQTT_HOST，改成你自己的域名），接收参数配置与指令
 *   - 定时上报遥测数据（温度、RSSI、运行时间等）
 *   - 接收 retain 配置（JSON）并应用
 *   - 接收实时指令（JSON）并执行（OLED 显示、GPIO 控制、重启等）
 *   - 定期 OTA 轮询，支持远程固件升级
 *
 * 必需修改的配置项：
 *   - DEVICE_ID  / DEVICE_KEY  从设备控制台注册获得
 *   - WIFI_SSID  / WIFI_PASS   你的 Wi-Fi 凭据
 *
 * 依赖库（通过 Arduino IDE 库管理器安装）：
 *   - PubSubClient 2.8+    (MQTT)
 *   - ArduinoJson 6.21+    (JSON 解析)
 *   - ESP32_SSD1306 或 Adafruit SSD1306 (OLED 显示，可选)
 *   - WiFi / HTTPClient / Update (ESP32 内置)
 */

#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <PubSubClient.h>
#include <ArduinoJson.h>
#include <HTTPClient.h>
#include <Update.h>

// ===== 1. 平台配置（从设备控制台注册后填写） =====
#define DEVICE_ID   "dev-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
#define DEVICE_KEY  "dk-yyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy"

// ===== 2. Wi-Fi 配置 =====
#define WIFI_SSID   "your_wifi_ssid"
#define WIFI_PASS   "your_wifi_password"

// ===== 3. MQTT 平台 =====
#define MQTT_HOST   "example.com"   // ← 改成你自己的域名（与站点证书一致）
#define MQTT_PORT   8883
#define MQTT_TOPIC_TELEMETRY  "devices/" DEVICE_ID "/telemetry"
#define MQTT_TOPIC_CONFIG     "devices/" DEVICE_ID "/config"
#define MQTT_TOPIC_CMD        "devices/" DEVICE_ID "/cmd"
#define MQTT_TOPIC_ACK        "devices/" DEVICE_ID "/config/ack"
#define MQTT_TOPIC_STATUS     "devices/" DEVICE_ID "/status"

// ===== 4. OTA 配置 =====
#define OTA_INFO_URL  "https://" MQTT_HOST "/device-api/api/ota/info"
#define OTA_FW_URL    "https://" MQTT_HOST "/device-api/api/ota/fw/current.bin"
#define OTA_CHECK_INTERVAL_MS  (6 * 3600 * 1000UL)  // 每 6 小时检查一次

// ===== 5. 遥测上报间隔 =====
#define TELEMETRY_INTERVAL_MS  15000  // 15 秒

// ===== 6. 硬件引脚定义（按需修改） =====
#define OLED_SDA  21
#define OLED_SCL  22
#define BUZZER_PIN  25
#define LED_PIN     2

// ===== 全局状态 =====
WiFiClientSecure wifiClient;
PubSubClient mqtt(wifiClient);

// 当前配置（从 MQTT retain 消息解析）
int    cfg_brightness = 255;
String cfg_default_text = "Hello OBC";
int    cfg_version = 0;

// 固件版本（用于 OTA 版本比较）
const char* CURRENT_FW_VERSION = "1.0.0";

// 计时器
unsigned long lastTelemetryMs = 0;
unsigned long lastOtaCheckMs  = 0;
unsigned long bootMs          = 0;

// ===== 前置声明 =====
void setupWiFi();
void setupMQTT();
void mqttCallback(char* topic, byte* payload, unsigned int length);
void handleConfig(const char* json);
void handleCommand(const char* json);
void publishTelemetry();
void publishStatus(const char* status);
void checkOTA();
void applyConfig();

// ===== 初始化 =====
void setup() {
  Serial.begin(115200);
  Serial.println("\n[OBC] 固件启动");

  // 引脚初始化
  pinMode(BUZZER_PIN, OUTPUT);
  pinMode(LED_PIN, OUTPUT);
  digitalWrite(BUZZER_PIN, LOW);
  digitalWrite(LED_PIN, LOW);

  bootMs = millis();

  // 连接 Wi-Fi
  setupWiFi();

  // 配置 MQTT
  wifiClient.setInsecure();  // 生产环境建议使用证书验证
  mqtt.setServer(MQTT_HOST, MQTT_PORT);
  mqtt.setCallback(mqttCallback);
  mqtt.setBufferSize(2048);  // 接收大 JSON 不截断

  // 连接 MQTT
  setupMQTT();

  // 发布上线状态
  publishStatus("online");

  Serial.println("[OBC] 初始化完成");
}

// ===== 主循环 =====
void loop() {
  // 保持 MQTT 连接
  if (!mqtt.connected()) {
    setupMQTT();
  }
  mqtt.loop();

  unsigned long now = millis();

  // 定时上报遥测
  if (now - lastTelemetryMs >= TELEMETRY_INTERVAL_MS) {
    lastTelemetryMs = now;
    publishTelemetry();
  }

  // 定时 OTA 检查
  if (now - lastOtaCheckMs >= OTA_CHECK_INTERVAL_MS) {
    lastOtaCheckMs = now;
    checkOTA();
  }
}

// ===== Wi-Fi 连接 =====
void setupWiFi() {
  Serial.printf("[WiFi] 连接 %s ...\n", WIFI_SSID);
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
    Serial.print(".");
  }
  Serial.println("\n[WiFi] 已连接，IP: " + WiFi.localIP().toString());
}

// ===== MQTT 连接 =====
void setupMQTT() {
  while (!mqtt.connected()) {
    Serial.printf("[MQTT] 连接 %s:%d ...\n", MQTT_HOST, MQTT_PORT);
    if (mqtt.connect(DEVICE_ID, DEVICE_ID, DEVICE_KEY)) {
      Serial.println("[MQTT] 已连接");

      // 订阅 retain 配置（设备上线即取最新配置）
      mqtt.subscribe(MQTT_TOPIC_CONFIG);
      Serial.printf("[MQTT] 已订阅 %s\n", MQTT_TOPIC_CONFIG);

      // 订阅实时指令
      mqtt.subscribe(MQTT_TOPIC_CMD);
      Serial.printf("[MQTT] 已订阅 %s\n", MQTT_TOPIC_CMD);
    } else {
      Serial.printf("[MQTT] 连接失败, rc=%d, 5s 后重试\n", mqtt.state());
      delay(5000);
    }
  }
}

// ===== MQTT 消息回调 =====
void mqttCallback(char* topic, byte* payload, unsigned int length) {
  // 将 payload 转为字符串
  String jsonStr;
  for (unsigned int i = 0; i < length; i++) {
    jsonStr += (char)payload[i];
  }
  Serial.printf("[MQTT] 收到消息: %s\n", topic);
  Serial.printf("[MQTT] 内容: %s\n", jsonStr.c_str());

  String topicStr = String(topic);
  if (topicStr.endsWith("/config")) {
    handleConfig(jsonStr.c_str());
  } else if (topicStr.endsWith("/cmd")) {
    handleCommand(jsonStr.c_str());
  }
}

// ============================================================
// 配置接收（retain 消息，设备上线即取，可随时更新）
// 协议：{"cfg_version": N, "config": {"brightness": 255, ...}}
// 接收到后：解析 → 应用 → 回复 config/ack
// ============================================================
void handleConfig(const char* json) {
  StaticJsonDocument<1024> doc;
  DeserializationError err = deserializeJson(doc, json);
  if (err) {
    Serial.printf("[Config] JSON 解析失败: %s\n", err.c_str());
    return;
  }

  int ver = doc["cfg_version"] | 0;
  JsonObject config = doc["config"].as<JsonObject>();

  if (config.isNull() || config.size() == 0) {
    Serial.println("[Config] 空配置，忽略");
    return;
  }

  Serial.printf("[Config] 收到 v%d\n", ver);

  // ---- 读取已知参数（可扩展） ----
  if (config.containsKey("brightness")) {
    cfg_brightness = config["brightness"];
    Serial.printf("[Config] brightness = %d\n", cfg_brightness);
  }
  if (config.containsKey("default_text")) {
    cfg_default_text = config["default_text"].as<String>();
    Serial.printf("[Config] default_text = %s\n", cfg_default_text.c_str());
  }
  // ★ 扩展自定义参数：
  // if (config.containsKey("my_param")) {
  //   my_param = config["my_param"];
  // }

  cfg_version = ver;

  // 应用配置（如 OLED 亮度刷新等）
  applyConfig();

  // ---- 发送配置回执 ----
  StaticJsonDocument<64> ackDoc;
  ackDoc["ack"] = true;
  ackDoc["cfg_version"] = ver;
  String ackStr;
  serializeJson(ackDoc, ackStr);
  mqtt.publish(MQTT_TOPIC_ACK, ackStr.c_str(), false);
  Serial.printf("[Config] 已回执 v%d\n", ver);
}

// 应用配置到硬件
void applyConfig() {
  // 在此处实现硬件配置更新
  // 例：调整 OLED 对比度、更新 LED 亮度等
  Serial.printf("[Config] 应用配置: brightness=%d, default_text=%s\n",
    cfg_brightness, cfg_default_text.c_str());
}

// ============================================================
// 指令接收（一次性，不 retain。可扩展为任意 JSON 格式）
// 内置指令类型：
//   {"type":"display",   "text":"..."}    → OLED 显示
//   {"type":"restart"}                   → 重启设备
//   {"type":"ota_check"}                 → 立即检查 OTA
//   {"type":"gpio",      "pin":N, "state":"high"|"low"} → GPIO 控制
//   {"type":"beep",      "duration": ms}  → 蜂鸣器
// ★ 可自行扩展任意 type，在 handleCommand 中添加对应分支
// ============================================================
void handleCommand(const char* json) {
  StaticJsonDocument<512> doc;
  DeserializationError err = deserializeJson(doc, json);
  if (err) {
    Serial.printf("[Cmd] JSON 解析失败: %s\n", err.c_str());
    return;
  }

  const char* type = doc["type"] | "";

  if (strcmp(type, "display") == 0) {
    const char* text = doc["text"] | "";
    Serial.printf("[Cmd] OLED 显示: %s\n", text);
    // ★ 在此处调用 OLED 驱动库显示文本
    // display.clear();
    // display.drawString(0, 0, text);
    // display.display();

  } else if (strcmp(type, "restart") == 0) {
    Serial.println("[Cmd] 重启设备");
    publishStatus("offline");
    delay(100);
    ESP.restart();

  } else if (strcmp(type, "ota_check") == 0) {
    Serial.println("[Cmd] 立即执行 OTA 检查");
    checkOTA();

  } else if (strcmp(type, "gpio") == 0) {
    int pin = doc["pin"] | -1;
    const char* state = doc["state"] | "low";
    if (pin >= 0) {
      pinMode(pin, OUTPUT);
      int val = (strcmp(state, "high") == 0) ? HIGH : LOW;
      digitalWrite(pin, val);
      Serial.printf("[Cmd] GPIO %d -> %s\n", pin, state);
    }

  } else if (strcmp(type, "beep") == 0) {
    int duration = doc["duration"] | 200;
    digitalWrite(BUZZER_PIN, HIGH);
    delay(duration);
    digitalWrite(BUZZER_PIN, LOW);
    Serial.printf("[Cmd] 蜂鸣 %d ms\n", duration);

  } else {
    Serial.printf("[Cmd] 未知指令类型: %s\n", type);
    // ★ 可在此处处理自定义指令
  }
}

// ============================================================
// 遥测上报（非 retain，每 15 秒）
// 上报内容示例：
//   {
//     "temperature": 26.5,       // 传感器数据
//     "humidity": 60.2,
//     "rssi": -72,                // Wi-Fi 信号强度
//     "uptime": 12345,            // 运行秒数
//     "firmware": "1.0.0",       // 当前固件版本（平台自动记录）
//     "cfg_version": 5,           // 当前已应用的配置版本
//     "free_heap": 184320,        // 剩余内存
//     "custom_field": "value"     // ★ 可自由扩展任意字段
//   }
// ============================================================
void publishTelemetry() {
  StaticJsonDocument<512> doc;

  // ---- 传感器数据 ----
  // ★ 替换为你的实际传感器读数
  doc["temperature"] = 25.0 + (float)(analogRead(34) % 100) / 10.0;
  doc["humidity"]    = 50.0 + (float)(analogRead(35) % 100) / 10.0;
  doc["rssi"]        = WiFi.RSSI();
  doc["uptime"]      = (millis() - bootMs) / 1000;
  doc["firmware"]    = CURRENT_FW_VERSION;
  doc["cfg_version"] = cfg_version;
  doc["free_heap"]   = ESP.getFreeHeap();

  // ★ 扩展自定义字段：
  // doc["light_sensor"] = analogRead(36);
  // doc["button_state"] = digitalRead(0);

  String jsonStr;
  serializeJson(doc, jsonStr);

  bool ok = mqtt.publish(MQTT_TOPIC_TELEMETRY, jsonStr.c_str(), false);
  Serial.printf("[Telemetry] %s → %s\n", ok ? "OK" : "FAIL", jsonStr.c_str());
}

// 发布设备状态（online/offline）
void publishStatus(const char* status) {
  mqtt.publish(MQTT_TOPIC_STATUS, status, false);
  Serial.printf("[Status] %s\n", status);
}

// ============================================================
// OTA 远程固件升级
// 流程：
//   1. 带上设备凭证（Basic Auth）访问 /api/ota/info
//   2. 对比版本号，若平台版本更新则下载 current.bin
//   3. 通过 ESP32 OTA 写入固件
//   4. 重启后运行新固件
// ============================================================
void checkOTA() {
  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("[OTA] Wi-Fi 未连接，跳过检查");
    return;
  }

  Serial.println("[OTA] 检查固件更新...");

  // ---- 1. 获取版本信息 ----
  HTTPClient http;
  http.begin(OTA_INFO_URL);
  http.setAuthorization(DEVICE_ID, DEVICE_KEY);  // Basic Auth
  http.setTimeout(10000);

  int httpCode = http.GET();
  if (httpCode != 200) {
    Serial.printf("[OTA] 版本查询失败: HTTP %d\n", httpCode);
    http.end();
    return;
  }

  String response = http.getString();
  http.end();

  StaticJsonDocument<256> doc;
  DeserializationError err = deserializeJson(doc, response);
  if (err) {
    Serial.printf("[OTA] 版本信息解析失败: %s\n", err.c_str());
    return;
  }

  const char* latestVersion = doc["version"] | "";
  if (strlen(latestVersion) == 0) {
    Serial.println("[OTA] 平台无固件版本");
    return;
  }

  Serial.printf("[OTA] 平台最新: %s, 本地: %s\n", latestVersion, CURRENT_FW_VERSION);

  // 版本比较（简单字符串比较，正式项目建议使用 semver 库）
  if (strcmp(latestVersion, CURRENT_FW_VERSION) <= 0) {
    Serial.println("[OTA] 已是最新版本");
    return;
  }

  // ---- 2. 下载并更新固件 ----
  Serial.printf("[OTA] 开始下载 %s ...\n", latestVersion);

  HTTPClient fwHttp;
  fwHttp.begin(OTA_FW_URL);
  fwHttp.setAuthorization(DEVICE_ID, DEVICE_KEY);
  fwHttp.setTimeout(30000);  // 30s 超时（大固件可能需更长时间）

  int fwCode = fwHttp.GET();
  if (fwCode != 200) {
    Serial.printf("[OTA] 固件下载失败: HTTP %d\n", fwCode);
    fwHttp.end();
    return;
  }

  int contentLength = fwHttp.getSize();
  if (contentLength <= 0) {
    Serial.println("[OTA] 固件大小为 0");
    fwHttp.end();
    return;
  }

  // 准备 OTA 写入
  if (!Update.begin(contentLength)) {
    Serial.printf("[OTA] Update.begin 失败: %s\n", Update.errorString());
    fwHttp.end();
    return;
  }

  // 流式写入
  WiFiClient* stream = fwHttp.getStreamPtr();
  size_t written = Update.writeStream(*stream);
  if (written != contentLength) {
    Serial.printf("[OTA] 写入 %d/%d 字节失败\n", written, contentLength);
    Update.end();
    fwHttp.end();
    return;
  }

  if (!Update.end()) {
    Serial.printf("[OTA] Update.end 失败: %s\n", Update.errorString());
    fwHttp.end();
    return;
  }

  fwHttp.end();

  if (Update.isFinished()) {
    Serial.printf("[OTA] 升级成功! %d 字节写入, 即将重启...\n", written);
    publishStatus("offline");
    delay(100);
    ESP.restart();
  } else {
    Serial.printf("[OTA] 升级未完成: %s\n", Update.errorString());
  }
}