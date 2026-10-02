#!/usr/bin/env python3
"""生成设备服务的凭据/配置文件 `svc.env`（0600）。

设备服务用里面那对内部账号连本机 broker（EMQX 的 HTTP 认证链特判 username=svc →
superuser，所以服务能订阅通配主题）；其余几项是监听地址、SQLite 路径、日志路径。

用法（在 device-service 的部署目录里跑，或把 DEVICE_DIR 指过去）：

    DEVICE_DIR=/opt/device-service python3 iot/device-service/gen_svc_env.py

幂等：**已存在就不覆盖**（重跑一次把口令换掉会让正在跑的服务连不上 broker，
而那不像是"再跑一次生成脚本"该有的后果）。要重新生成就先手动删掉那个文件。

⚠️ 与早先那版（硬编码部署者家目录那种写法）的区别：路径不再写死成绝对路径，
改成相对 `DEVICE_DIR` 推导 ⇒ 换目录、换机器都不用改这段代码。
"""
import os
import secrets

# 部署目录：默认取本脚本上溯两级（device-service/ → iot/）**再上溯一级**没有意义，
# 因为服务本体不在本仓 —— 所以这里只能靠 DEVICE_DIR 显式指定，或落在当前目录。
device_dir = os.path.abspath(os.environ.get("DEVICE_DIR", os.getcwd()))
path = os.path.join(device_dir, "svc.env")

if os.path.exists(path):
    print(f"已存在 {path}，跳过（要重新生成先删掉它）")
    raise SystemExit(0)

content = f"""# 设备服务内部账号（连接本机 EMQX 用；EMQX 认证链特判 svc -> superuser）
DEVICE_SVC_USER=svc
DEVICE_SVC_KEY={secrets.token_urlsafe(24)}
# 监听地址（仅本机；公网入口走 nginx 的 /device-api/）
DEVICE_LISTEN=127.0.0.1:3100
# SQLite 路径（设备注册表与遥测缓存）
DEVICE_DB_PATH={os.path.join(device_dir, "devices.db")}
# 日志文件（默认 stderr 之外再追加写一份；systemd 下 journalctl 也有一份）
DEVICE_LOG_FILE={os.path.join(device_dir, "device-service.log")}
"""
with open(path, "w") as f:
    f.write(content)
os.chmod(path, 0o600)
print(f"已生成 {path} (0600)")
