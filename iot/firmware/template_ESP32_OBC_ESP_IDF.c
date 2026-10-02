/**
 * OBC (One-Board Controller) 固件模板 — ESP-IDF 框架
 *
 * 基于 ESP-IDF v5.x，使用 esp-mqtt 和 esp-http-client 组件。
 *
 * 功能：
 *   - MQTT 连接平台（见下面 MQTT_HOST，改成你自己的域名），接收参数配置与指令
 *   - 定时上报遥测数据（温度、RSSI、运行时间等）
 *   - 接收 retain 配置（JSON）并应用
 *   - 接收实时指令（JSON）并执行（OLED 显示、GPIO 控制、重启等）
 *   - 定期 OTA 轮询，支持远程固件升级
 *
 * 必需修改的配置项：
 *   - DEVICE_ID / DEVICE_KEY  从设备控制台注册获得
 *   - WIFI_SSID / WIFI_PASS   你的 Wi-Fi 凭据
 *
 * 项目结构：
 *   components/
 *     obc/          ← 本文件放在这里
 *   main/
 *     CMakeLists.txt
 *   CMakeLists.txt
 *   sdkconfig
 *
 * 依赖组件（在 CMakeLists.txt 中添加）：
 *   - esp_mqtt       (ESP-MQTT)
 *   - esp_http_client (HTTP 客户端)
 *   - cJSON           (JSON 解析，ESP-IDF 内置)
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "freertos/event_groups.h"
#include "esp_system.h"
#include "esp_event.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "nvs_flash.h"
#include "esp_netif.h"
#include "esp_wifi.h"
#include "mqtt_client.h"
#include "esp_http_client.h"
#include "esp_ota_ops.h"
#include "esp_partition.h"
#include "driver/gpio.h"
#include "cJSON.h"

#ifndef MIN
#define MIN(a, b)  (((a) < (b)) ? (a) : (b))
#endif

// ===== 1. 平台配置（从设备控制台注册后填写） =====
#define DEVICE_ID   "dev-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
#define DEVICE_KEY  "dk-yyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy"

// ===== 2. Wi-Fi 配置 =====
#define WIFI_SSID   "your_wifi_ssid"
#define WIFI_PASS   "your_wifi_password"
#define WIFI_MAX_RETRY  5

// ===== 3. MQTT 平台 =====
#define MQTT_HOST   "example.com"   /* ← 改成你自己的域名（与站点证书一致） */
#define MQTT_PORT   8883
#define MQTT_URI    "mqtts://" MQTT_HOST ":" STR(MQTT_PORT)

#define MQTT_TOPIC_TELEMETRY  "devices/" DEVICE_ID "/telemetry"
#define MQTT_TOPIC_CONFIG     "devices/" DEVICE_ID "/config"
#define MQTT_TOPIC_CMD        "devices/" DEVICE_ID "/cmd"
#define MQTT_TOPIC_ACK        "devices/" DEVICE_ID "/config/ack"
#define MQTT_TOPIC_STATUS     "devices/" DEVICE_ID "/status"

// ===== 4. OTA 配置 =====
#define OTA_INFO_URL  "https://" MQTT_HOST "/device-api/api/ota/info"
#define OTA_FW_URL    "https://" MQTT_HOST "/device-api/api/ota/fw/current.bin"
#define OTA_CHECK_INTERVAL_MS  (6 * 3600 * 1000)  // 6 小时

// ===== 5. 遥测上报间隔 =====
#define TELEMETRY_INTERVAL_MS  15000  // 15 秒

// ===== 6. 硬件引脚 =====
#define BUZZER_GPIO   25
#define LED_GPIO      2

// ===== 辅助宏 =====
#define STR(x)  #x
#define XSTR(x) STR(x)

// ===== 日志标签 =====
static const char *TAG = "OBC";

// ===== 全局状态 =====
static esp_mqtt_client_handle_t mqtt_client = NULL;
static int cfg_version = 0;
static int cfg_brightness = 255;
static char cfg_default_text[64] = "Hello OBC";
static const char *CURRENT_FW_VERSION = "1.0.0";
static EventGroupHandle_t wifi_event_group;
static int wifi_retry_count = 0;
static int64_t boot_time_us = 0;

// ===== 事件组位 =====
#define WIFI_CONNECTED_BIT  BIT0
#define MQTT_CONNECTED_BIT  BIT1

// ===== 前置声明 =====
static void wifi_init_sta(void);
static void mqtt_app_start(void);
static void mqtt_event_handler(void *args, esp_event_base_t base, int32_t event_id, void *data);
static void handle_config(const char *json);
static void handle_command(const char *json);
static void publish_telemetry(void);
static void publish_status(const char *status);
static void check_ota(void);
static void apply_config(void);

// ============================================================
// 入口
// ============================================================
void app_main(void) {
    ESP_LOGI(TAG, "[OBC] 固件启动 v%s", CURRENT_FW_VERSION);

    // 初始化 NVS（Wi-Fi 和 MQTT 需要）
    esp_err_t ret = nvs_flash_init();
    if (ret == ESP_ERR_NVS_NO_FREE_PAGES || ret == ESP_ERR_NVS_NEW_VERSION_FOUND) {
        ESP_ERROR_CHECK(nvs_flash_erase());
        ret = nvs_flash_init();
    }
    ESP_ERROR_CHECK(ret);

    // 初始化网络接口
    ESP_ERROR_CHECK(esp_netif_init());
    ESP_ERROR_CHECK(esp_event_loop_create_default());

    boot_time_us = esp_timer_get_time();

    // 连接 Wi-Fi
    wifi_init_sta();

    // 启动 MQTT
    mqtt_app_start();
}

// ============================================================
// Wi-Fi 连接
// ============================================================
static void wifi_event_handler(void *arg, esp_event_base_t base,
                               int32_t event_id, void *data) {
    if (base == WIFI_EVENT && event_id == WIFI_EVENT_STA_START) {
        esp_wifi_connect();
    } else if (base == WIFI_EVENT && event_id == WIFI_EVENT_STA_DISCONNECTED) {
        if (wifi_retry_count < WIFI_MAX_RETRY) {
            esp_wifi_connect();
            wifi_retry_count++;
            ESP_LOGW(TAG, "Wi-Fi 重连 %d/%d", wifi_retry_count, WIFI_MAX_RETRY);
        } else {
            ESP_LOGE(TAG, "Wi-Fi 连接失败");
        }
    } else if (base == IP_EVENT && event_id == IP_EVENT_STA_GOT_IP) {
        ip_event_got_ip_t *event = (ip_event_got_ip_t *)data;
        ESP_LOGI(TAG, "Wi-Fi 已连接，IP: " IPSTR, IP2STR(&event->ip_info.ip));
        wifi_retry_count = 0;
        xEventGroupSetBits(wifi_event_group, WIFI_CONNECTED_BIT);
    }
}

static void wifi_init_sta(void) {
    wifi_event_group = xEventGroupCreate();

    esp_netif_create_default_wifi_sta();
    wifi_init_config_t cfg = WIFI_INIT_CONFIG_DEFAULT();
    ESP_ERROR_CHECK(esp_wifi_init(&cfg));

    esp_event_handler_instance_t instance_any_id;
    esp_event_handler_instance_t instance_got_ip;
    ESP_ERROR_CHECK(esp_event_handler_instance_register(WIFI_EVENT,
        ESP_EVENT_ANY_ID, &wifi_event_handler, NULL, &instance_any_id));
    ESP_ERROR_CHECK(esp_event_handler_instance_register(IP_EVENT,
        IP_EVENT_STA_GOT_IP, &wifi_event_handler, NULL, &instance_got_ip));

    wifi_config_t wifi_config = {
        .sta = {
            .ssid = WIFI_SSID,
            .password = WIFI_PASS,
            .threshold.authmode = WIFI_AUTH_WPA2_PSK,
        },
    };
    ESP_ERROR_CHECK(esp_wifi_set_mode(WIFI_MODE_STA));
    ESP_ERROR_CHECK(esp_wifi_set_config(WIFI_IF_STA, &wifi_config));
    ESP_ERROR_CHECK(esp_wifi_start());

    ESP_LOGI(TAG, "Wi-Fi 连接中 %s ...", WIFI_SSID);

    // 等待 Wi-Fi 连接
    xEventGroupWaitBits(wifi_event_group, WIFI_CONNECTED_BIT,
                        pdFALSE, pdTRUE, portMAX_DELAY);
}

// ============================================================
// MQTT
// ============================================================
static void mqtt_event_handler(void *args, esp_event_base_t base,
                               int32_t event_id, void *data) {
    esp_mqtt_event_handle_t event = (esp_mqtt_event_handle_t)data;
    esp_mqtt_client_handle_t client = event->client;

    switch (event->event_id) {
        case MQTT_EVENT_CONNECTED:
            ESP_LOGI(TAG, "MQTT 已连接");
            xEventGroupSetBits(wifi_event_group, MQTT_CONNECTED_BIT);

            // 订阅 retain 配置（上线即取）
            esp_mqtt_client_subscribe(client, MQTT_TOPIC_CONFIG, 1);
            ESP_LOGI(TAG, "已订阅 %s", MQTT_TOPIC_CONFIG);

            // 订阅实时指令
            esp_mqtt_client_subscribe(client, MQTT_TOPIC_CMD, 1);
            ESP_LOGI(TAG, "已订阅 %s", MQTT_TOPIC_CMD);

            // 发布上线状态
            publish_status("online");
            break;

        case MQTT_EVENT_DISCONNECTED:
            ESP_LOGW(TAG, "MQTT 断开连接");
            break;

        case MQTT_EVENT_DATA: {
            char topic[128];
            char *payload = (char *)malloc(event->data_len + 1);
            if (payload == NULL) break;
            memcpy(payload, event->data, event->data_len);
            payload[event->data_len] = '\0';
            snprintf(topic, sizeof(topic), "%.*s", event->topic_len, event->topic);

            ESP_LOGI(TAG, "MQTT 收到: %s", topic);

            if (strstr(topic, "/config")) {
                handle_config(payload);
            } else if (strstr(topic, "/cmd")) {
                handle_command(payload);
            }

            free(payload);
            break;
        }

        case MQTT_EVENT_ERROR:
            ESP_LOGE(TAG, "MQTT 错误");
            break;

        default:
            break;
    }
}

static void mqtt_app_start(void) {
    esp_mqtt_client_config_t mqtt_cfg = {
        .broker.address.uri = MQTT_URI,
        .broker.verification.skip_cert_common_name_check = true,
        .credentials.username = DEVICE_ID,
        .credentials.authentication.password = DEVICE_KEY,
        .session.client_id = DEVICE_ID,
        .network.reconnect_timeout_ms = 5000,
    };

    mqtt_client = esp_mqtt_client_init(&mqtt_cfg);
    esp_mqtt_client_register_event(mqtt_client, ESP_EVENT_ANY_ID,
                                   mqtt_event_handler, NULL);
    esp_mqtt_client_start(mqtt_client);
}

// ============================================================
// 配置接收（retain 消息，设备上线即取，可随时更新）
// 协议：{"cfg_version": N, "config": {"brightness": 255, ...}}
// 接收到后：解析 → 应用 → 回复 config/ack
// ============================================================
static void handle_config(const char *json) {
    cJSON *root = cJSON_Parse(json);
    if (root == NULL) {
        ESP_LOGE(TAG, "Config JSON 解析失败");
        return;
    }

    cJSON *ver = cJSON_GetObjectItem(root, "cfg_version");
    cJSON *config = cJSON_GetObjectItem(root, "config");

    if (ver == NULL || config == NULL || !cJSON_IsObject(config)) {
        ESP_LOGW(TAG, "Config 格式无效");
        cJSON_Delete(root);
        return;
    }

    int new_ver = ver->valueint;
    ESP_LOGI(TAG, "收到配置 v%d", new_ver);

    // ---- 读取已知参数（可扩展） ----
    cJSON *brightness = cJSON_GetObjectItem(config, "brightness");
    if (brightness != NULL && cJSON_IsNumber(brightness)) {
        cfg_brightness = brightness->valueint;
        ESP_LOGI(TAG, "brightness = %d", cfg_brightness);
    }

    cJSON *default_text = cJSON_GetObjectItem(config, "default_text");
    if (default_text != NULL && cJSON_IsString(default_text)) {
        strncpy(cfg_default_text, default_text->valuestring, sizeof(cfg_default_text) - 1);
        ESP_LOGI(TAG, "default_text = %s", cfg_default_text);
    }

    // ★ 扩展自定义参数示例：
    // cJSON *my_param = cJSON_GetObjectItem(config, "my_param");
    // if (my_param != NULL) { ... }

    cfg_version = new_ver;
    apply_config();

    // ---- 发送配置回执 ----
    cJSON *ack = cJSON_CreateObject();
    cJSON_AddBoolToObject(ack, "ack", true);
    cJSON_AddNumberToObject(ack, "cfg_version", new_ver);
    char *ack_str = cJSON_PrintUnformatted(ack);
    if (ack_str) {
        esp_mqtt_client_publish(mqtt_client, MQTT_TOPIC_ACK, ack_str, 0, 0, 0);
        free(ack_str);
    }
    cJSON_Delete(ack);
    ESP_LOGI(TAG, "已回执 v%d", new_ver);

    cJSON_Delete(root);
}

// 应用配置到硬件
static void apply_config(void) {
    ESP_LOGI(TAG, "应用配置: brightness=%d, default_text=%s",
             cfg_brightness, cfg_default_text);
    // ★ 在此处实现硬件配置更新
}

// ============================================================
// 指令接收（一次性，不 retain。可扩展为任意 JSON 格式）
// 内置指令类型：
//   {"type":"display",   "text":"..."}    → OLED 显示
//   {"type":"restart"}                   → 重启设备
//   {"type":"ota_check"}                 → 立即检查 OTA
//   {"type":"gpio",      "pin":N, "state":"high"|"low"} → GPIO 控制
//   {"type":"beep",      "duration": ms}  → 蜂鸣器
// ★ 可自行扩展任意 type，在 handle_command 中添加对应分支
// ============================================================
static void handle_command(const char *json) {
    cJSON *root = cJSON_Parse(json);
    if (root == NULL) {
        ESP_LOGE(TAG, "Cmd JSON 解析失败");
        return;
    }

    cJSON *type = cJSON_GetObjectItem(root, "type");
    if (type == NULL || !cJSON_IsString(type)) {
        ESP_LOGW(TAG, "Cmd 缺少 type 字段");
        cJSON_Delete(root);
        return;
    }

    const char *cmd_type = type->valuestring;

    if (strcmp(cmd_type, "display") == 0) {
        cJSON *text = cJSON_GetObjectItem(root, "text");
        const char *display_text = (text && cJSON_IsString(text)) ? text->valuestring : "";
        ESP_LOGI(TAG, "OLED 显示: %s", display_text);
        // ★ 在此处调用 OLED 驱动显示

    } else if (strcmp(cmd_type, "restart") == 0) {
        ESP_LOGI(TAG, "重启设备");
        publish_status("offline");
        vTaskDelay(pdMS_TO_TICKS(100));
        esp_restart();

    } else if (strcmp(cmd_type, "ota_check") == 0) {
        ESP_LOGI(TAG, "立即检查 OTA");
        check_ota();

    } else if (strcmp(cmd_type, "gpio") == 0) {
        cJSON *pin = cJSON_GetObjectItem(root, "pin");
        cJSON *state = cJSON_GetObjectItem(root, "state");
        if (pin != NULL && cJSON_IsNumber(pin)) {
            int gpio = pin->valueint;
            int level = (state && cJSON_IsString(state) &&
                        strcmp(state->valuestring, "high") == 0) ? 1 : 0;
            gpio_set_direction(gpio, GPIO_MODE_OUTPUT);
            gpio_set_level(gpio, level);
            ESP_LOGI(TAG, "GPIO %d -> %s", gpio, level ? "HIGH" : "LOW");
        }

    } else if (strcmp(cmd_type, "beep") == 0) {
        cJSON *duration = cJSON_GetObjectItem(root, "duration");
        int ms = (duration && cJSON_IsNumber(duration)) ? duration->valueint : 200;
        gpio_set_direction(BUZZER_GPIO, GPIO_MODE_OUTPUT);
        gpio_set_level(BUZZER_GPIO, 1);
        vTaskDelay(pdMS_TO_TICKS(ms));
        gpio_set_level(BUZZER_GPIO, 0);
        ESP_LOGI(TAG, "蜂鸣 %d ms", ms);

    } else {
        ESP_LOGW(TAG, "未知指令类型: %s", cmd_type);
        // ★ 在此处处理自定义指令
    }

    cJSON_Delete(root);
}

// ============================================================
// 遥测上报（非 retain，每 15 秒）
// 上报内容示例：
//   {
//     "temperature": 26.5,       // 传感器数据
//     "humidity": 60.2,
//     "rssi": -72,                // Wi-Fi 信号强度
//     "uptime": 12345,            // 运行秒数
//     "firmware": "1.0.0",       // 固件版本（平台自动记录）
//     "cfg_version": 5,           // 当前已应用的配置版本
//     "free_heap": 184320         // 剩余内存
//   }
// ============================================================
static void publish_telemetry(void) {
    if (mqtt_client == NULL) return;

    cJSON *root = cJSON_CreateObject();

    // ---- 传感器数据 ----
    // ★ 替换为实际传感器读数
    cJSON_AddNumberToObject(root, "temperature", 25.0 + (float)(esp_random() % 100) / 10.0);
    cJSON_AddNumberToObject(root, "humidity", 50.0 + (float)(esp_random() % 100) / 10.0);
    cJSON_AddNumberToObject(root, "rssi", -72);
    cJSON_AddNumberToObject(root, "uptime", (esp_timer_get_time() - boot_time_us) / 1000000);
    cJSON_AddStringToObject(root, "firmware", CURRENT_FW_VERSION);
    cJSON_AddNumberToObject(root, "cfg_version", cfg_version);
    cJSON_AddNumberToObject(root, "free_heap", esp_get_free_heap_size());

    // ★ 扩展自定义字段：
    // cJSON_AddNumberToObject(root, "light_sensor", adc1_get_raw(ADC1_CHANNEL_0));

    char *json_str = cJSON_PrintUnformatted(root);
    if (json_str) {
        esp_mqtt_client_publish(mqtt_client, MQTT_TOPIC_TELEMETRY, json_str, 0, 0, 0);
        ESP_LOGI(TAG, "遥测: %s", json_str);
        free(json_str);
    }

    cJSON_Delete(root);
}

// 发布设备状态
static void publish_status(const char *status) {
    if (mqtt_client == NULL) return;
    esp_mqtt_client_publish(mqtt_client, MQTT_TOPIC_STATUS, status, 0, 0, 0);
    ESP_LOGI(TAG, "状态: %s", status);
}

// ============================================================
// 定时遥测任务
// ============================================================
static void telemetry_task(void *pvParameter) {
    while (1) {
        vTaskDelay(pdMS_TO_TICKS(TELEMETRY_INTERVAL_MS));
        publish_telemetry();
    }
}

// ============================================================
// OTA 远程固件升级
// 流程：
//   1. HTTP Basic Auth 获取 /api/ota/info
//   2. 对比版本号
//   3. 下载 current.bin 并写入 OTA 分区
//   4. 重启
// ============================================================
static void ota_task(void *pvParameter) {
    while (1) {
        vTaskDelay(pdMS_TO_TICKS(OTA_CHECK_INTERVAL_MS));
        check_ota();
    }
}

static void check_ota(void) {
    ESP_LOGI(TAG, "检查 OTA 更新...");

    // ---- 1. 获取版本信息 ----
    esp_http_client_config_t info_config = {
        .url = OTA_INFO_URL,
        .auth_type = HTTP_AUTH_TYPE_BASIC,
        .username = DEVICE_ID,
        .password = DEVICE_KEY,
        .timeout_ms = 10000,
    };
    esp_http_client_handle_t info_client = esp_http_client_init(&info_config);
    if (info_client == NULL) {
        ESP_LOGE(TAG, "OTA info 客户端初始化失败");
        return;
    }

    esp_err_t err = esp_http_client_open(info_client, 0);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "OTA info 请求失败: %s", esp_err_to_name(err));
        esp_http_client_cleanup(info_client);
        return;
    }

    int content_length = esp_http_client_fetch_headers(info_client);
    if (content_length <= 0) {
        ESP_LOGW(TAG, "OTA info 响应为空");
        esp_http_client_cleanup(info_client);
        return;
    }

    char *buf = malloc(content_length + 1);
    if (buf == NULL) {
        esp_http_client_cleanup(info_client);
        return;
    }

    int read_len = esp_http_client_read_response(info_client, buf, content_length);
    buf[read_len] = '\0';
    esp_http_client_cleanup(info_client);

    // 解析版本信息
    cJSON *root = cJSON_Parse(buf);
    free(buf);
    if (root == NULL) {
        ESP_LOGE(TAG, "OTA info JSON 解析失败");
        return;
    }

    cJSON *version = cJSON_GetObjectItem(root, "version");
    if (version == NULL || !cJSON_IsString(version)) {
        ESP_LOGI(TAG, "平台无固件版本");
        cJSON_Delete(root);
        return;
    }

    const char *latest = version->valuestring;
    ESP_LOGI(TAG, "平台最新: %s, 本地: %s", latest, CURRENT_FW_VERSION);

    // 简单版本比较（正式项目建议使用 semver 库）
    if (strcmp(latest, CURRENT_FW_VERSION) <= 0) {
        ESP_LOGI(TAG, "已是最新版本");
        cJSON_Delete(root);
        return;
    }
    cJSON_Delete(root);

    // ---- 2. 下载固件 ----
    ESP_LOGI(TAG, "开始下载 %s ...", latest);

    esp_http_client_config_t fw_config = {
        .url = OTA_FW_URL,
        .auth_type = HTTP_AUTH_TYPE_BASIC,
        .username = DEVICE_ID,
        .password = DEVICE_KEY,
        .timeout_ms = 30000,
    };
    esp_http_client_handle_t fw_client = esp_http_client_init(&fw_config);
    if (fw_client == NULL) {
        ESP_LOGE(TAG, "OTA FW 客户端初始化失败");
        return;
    }

    err = esp_http_client_open(fw_client, 0);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "OTA FW 下载失败: %s", esp_err_to_name(err));
        esp_http_client_cleanup(fw_client);
        return;
    }

    int fw_len = esp_http_client_fetch_headers(fw_client);
    if (fw_len <= 0) {
        ESP_LOGE(TAG, "OTA FW 内容为空");
        esp_http_client_cleanup(fw_client);
        return;
    }

    // ---- 3. OTA 写入 ----
    esp_ota_handle_t ota_handle = 0;
    const esp_partition_t *ota_partition = esp_ota_get_next_update_partition(NULL);
    if (ota_partition == NULL) {
        ESP_LOGE(TAG, "OTA 分区未找到");
        esp_http_client_cleanup(fw_client);
        return;
    }

    err = esp_ota_begin(ota_partition, fw_len, &ota_handle);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "esp_ota_begin 失败: %s", esp_err_to_name(err));
        esp_http_client_cleanup(fw_client);
        return;
    }

    // 流式写入
    char ota_buf[1024];
    int remaining = fw_len;
    while (remaining > 0) {
        int r = esp_http_client_read(fw_client, ota_buf, MIN(remaining, sizeof(ota_buf)));
        if (r < 0) {
            ESP_LOGE(TAG, "OTA 下载读取错误");
            esp_ota_abort(ota_handle);
            esp_http_client_cleanup(fw_client);
            return;
        }
        err = esp_ota_write(ota_handle, ota_buf, r);
        if (err != ESP_OK) {
            ESP_LOGE(TAG, "OTA 写入失败: %s", esp_err_to_name(err));
            esp_ota_abort(ota_handle);
            esp_http_client_cleanup(fw_client);
            return;
        }
        remaining -= r;
    }

    esp_http_client_cleanup(fw_client);

    err = esp_ota_end(ota_handle);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "esp_ota_end 失败: %s", esp_err_to_name(err));
        return;
    }

    err = esp_ota_set_boot_partition(ota_partition);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "esp_ota_set_boot_partition 失败: %s", esp_err_to_name(err));
        return;
    }

    ESP_LOGI(TAG, "OTA 升级成功! 即将重启...");
    publish_status("offline");
    vTaskDelay(pdMS_TO_TICKS(100));
    esp_restart();
}

// ============================================================
// 启动遥测 + OTA 后台任务
// ============================================================
static void background_tasks_start(void) {
    // 等待 MQTT 连接后再启动任务
    xEventGroupWaitBits(wifi_event_group, MQTT_CONNECTED_BIT,
                        pdFALSE, pdTRUE, pdMS_TO_TICKS(30000));

    xTaskCreate(telemetry_task, "telemetry", 4096, NULL, 5, NULL);
    xTaskCreate(ota_task, "ota_check", 4096, NULL, 3, NULL);
    ESP_LOGI(TAG, "后台任务已启动");
}