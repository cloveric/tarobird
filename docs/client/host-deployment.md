# 主机与中转：选择部署方式

**主机**运行 Hub、托管 Bot、CLI、MCP，保存工作区、记忆、会话和附件。
**中转**转发设备到主机的加密连接，不运行 Bot，也不复制聊天数据库。
手机、平板和电脑均可以作为客户端；文件和工具在 Bot 的运行主机上执行。
一台电脑可以同时运行自己的 Bot，并连接其他运行主机；每台主机独立保存身份、
Bot 和历史。备用中转仍只通向同一 Hub，不是另一台独立运行主机。
要让手机远程连接已有电脑，先看[Agent 配置和手动教程](remote-access.md)。

| 设置中的选项 | 数据流 | 必须在线的机器 |
|---|---|---|
| 本地电脑运行 Bot | 我的设备 → 直连或中转 → 主电脑 | 主电脑；使用中转时还需至少一个中转 |
| VPS 运行 Bot，直接连接 | 我的设备 → 主机 VPS | 主机 VPS |
| VPS 运行 Bot，通过其他 VPS 中转 | 我的设备 → 中转 VPS → 主机 VPS | 主机 VPS，以及至少一个中转 |

后两种均不要求 Tailscale，本地电脑关闭不会停止云端 Bot。
主机 VPS 的 HTTPS 入口已经负责收发数据，无需为了“传输”再安装一次中转服务。
仍可添加其他中转作为备用；所有入口必须连接同一个 Hub 身份。
备用中转不能代替停机的运行主机。当前没有主机自动接管、数据库复制或中转离线附件仓库。
新装的第二个 Hub 会生成不同身份，不能作为原 Hub 的备用线路。

## 客户端设置

配对页和 **设置 → 连接 → 编辑线路 → 主端部署方式** 提供上述选项及连接示意。
选择仅描述已部署的环境、决定保存哪些地址，不安装软件或迁移数据。
不知道部署方式时选“已有连接地址 / 暂不确定”；旧配置不会根据 VPS 地址猜测主机位置。

- VPS 直连：填写“主机 HTTPS 地址”，额外中转可选。
- VPS 经中转：填写“中转 VPS 主备线路”，无需填写主机私有地址。
- 本地电脑：填写可达的 HTTPS 地址，或添加中转。Tailscale 是可选的连接手段。
- 填写的是业务 HTTPS 入口，不是 SSH 地址或 mTLS 隧道端口。
- 点“保存线路”后才生效；中转模式不保存隐藏的直连地址。
- 设置按设备保存；新设备二维码携带部署说明和全部线路，旧设备偏好不会自动修改。

首次配对时，通过 SSH 登录运行 Hub 的 VPS，以运行 Hub 的同一账号、同一状态目录批准：

```sh
node /opt/tarocub/dist/src/index.js hub devices approve <屏幕上的配对码> --state-dir /var/lib/tarocub/hub
```

### 为什么直连“可用”，却仍在使用中转

“可用”表示该地址的健康检查通过、返回的主机公钥匹配；“当前使用”才表示已建立的
聊天连接。回到局域网后，客户端会连续检查更优先的线路，至少三次成功后，在同一
主机的回复、同步、待发送消息和文件传输都空闲时自动切换，避免打断正在进行的工作。
健康检查不替代新连接的 TLS 和主机签名验证。

首次连接或故障恢复时，客户端会快速使用已经验证的备用线路，避免不可达的直连
拖住整个连接。后台决定回切时则保留已验证的目标，不重新按响应先后选择中转。
这个目标只用于下一次重连，十秒后失效；线路配置改变、连接被替代或连接失败后，
恢复正常探测和回退。无需重新配对或清除本机数据。

这部分属于各端 App 共用的客户端连接逻辑，不改变主机能力、配置或协议，因此
CLI 无新增命令。回归入口为 `client/tests/connection-switchback.test.ts`，以及
浏览器 `routes`、`multi-vps` 和 `native-transport`；浏览器适配测试不等同于 Android
真机或已安装版本验收。

## VPS 作为主机（Linux / Ubuntu）

VPS 需要完整 TaroCub 构建、客户端静态文件、所选引擎 CLI 及其登录／配置。
仅安装 `tarocub-relay` 不会得到运行 Bot 的主机。CLI 登录、MCP、语音转写依赖
需在 VPS 自己配置；桌面专有工具不能因此在无桌面的 Linux 上运行。

先以运行服务的非 root 账号显式初始化同一状态目录（不启动第二个 Hub）：

```sh
sudo -u tarocub env HOME=/var/lib/tarocub node /opt/tarocub/dist/src/index.js init --name "Cloud host" --state-dir /var/lib/tarocub/hub
```

随后将该目录的 `config.json` 按下例配置。示例使用非特权 HTTPS 端口 8443，无需以 root 运行。
路径、域名为占位值，需替换为真实且可由服务账号读取的证书：

```json
{
  "host": "127.0.0.1",
  "port": 8788,
  "clientDir": "/opt/tarocub/client/dist",
  "origins": ["https://hub.example.com:8443"],
  "tlsListeners": [{
    "host": "0.0.0.0",
    "port": 8443,
    "exposure": "public",
    "tls": {
      "cert": "/etc/tarocub/tls/fullchain.pem",
      "key": "/etc/tarocub/tls/privkey.pem"
    }
  }]
}
```

DNS 指向主机，放行 HTTPS 8443 和受控的 SSH 管理入口；不要对外放行
8788、Gateway/Bus 或本地控制接口。证书须匹配域名、被客户端信任并正常续期。
`origins` 列出浏览器的准确来源（含非默认端口），不是 `*`。
公网监听必须逐个声明 `exposure: "public"`；默认仍拒绝公网和通配监听。
主监听若声明 public 而未配置 TLS，会拒绝启动，不会退回明文。

专用非 root 账号的 systemd 运维模板如下，路径需匹配实际安装：

```ini
[Unit]
Description=TaroCub Bot host
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=tarocub
Group=tarocub
Environment=HOME=/var/lib/tarocub
Environment=PATH=/var/lib/tarocub/.local/bin:/usr/local/bin:/usr/bin:/bin
WorkingDirectory=/opt/tarocub
ExecStart=/usr/bin/node /opt/tarocub/dist/src/index.js hub run --state-dir /var/lib/tarocub/hub
Restart=on-failure
RestartSec=5
KillMode=control-group
TimeoutStopSec=45
UMask=0077
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
```

引擎登录与服务必须使用同一账号和 HOME，CLI 必须在服务 PATH 内。
使用此单元时通过 systemctl 管理生命周期，不同时用 `hub service start`
启动另一个管理进程。模板不是已部署或已验证的云端服务。

## 主机 VPS + 独立中转 VPS

在主机 VPS 运行完整 TaroCub，中转 VPS 使用[中转部署配置](relay-deployment.md)。
文档原来的“Mac 发起隧道”在这里由“主机 VPS 发起隧道”承担。
每个中转采用独立 mTLS 凭据，隧道目标仍为主机的 loopback TLS 监听。
以 `relay.example.com` 作为业务入口时，主机配置示例：

```json
{
  "host": "127.0.0.1",
  "port": 8788,
  "clientDir": "/opt/tarocub/client/dist",
  "origins": ["https://relay.example.com"],
  "tlsListeners": [{
    "host": "127.0.0.1",
    "port": 9443,
    "tls": {
      "cert": "/etc/tarocub/tls/relay-entry-fullchain.pem",
      "key": "/etc/tarocub/tls/relay-entry-key.pem"
    }
  }],
  "relays": [{
    "id": "primary",
    "label": "首选中转",
    "host": "tunnel.example.com",
    "port": 7443,
    "servername": "tunnel.example.com",
    "targetHost": "127.0.0.1",
    "targetPort": 9443,
    "tls": {
      "ca": "/etc/tarocub/tunnels/ca.pem",
      "cert": "/etc/tarocub/tunnels/host.pem",
      "key": "/etc/tarocub/tunnels/host.key"
    }
  }]
}
```

业务 HTTPS 私钥留在运行 Hub 的主机 VPS，`relay-entry-*` 证书需覆盖
`relay.example.com`；隧道证书与业务证书分开。
添加多台中转沿用多 SNI 证书和 `relays` 列表。直连与中转并用时，合并上述
公网及 loopback TLS 监听，并完整列出浏览器来源。
中转安装器按专用中转 VPS 管理防火墙，不能拿它在运行主机上代替主机安装。

## 安全与迁移边界

HTTPS 保护传输；配对批准、设备签名、Hub 身份绑定、短期令牌及吊销保护应用访问。
公网监听不会开放 `/instance` 或 `/api/instance/*`，也不会绕过消息、文件鉴权。
Tailscale 可额外减少公网暴露，但不替代应用认证。

主机管理员可以读取工作区、记忆及凭据，传输加密不隔离 root 权限。
中转只处理加密流量，不提供完整数据库或离线附件副本。
从电脑迁到 VPS 需另行处理工作区、记忆、引擎会话与登录配置；App 选项不会执行迁移。
现有全量备份自动恢复要求原路径、目标不存在，不承诺跨系统无损一键迁移。

已有本地 HTTPS/mTLS 和浏览器验证，以及[Ubuntu VPS 到原 Mac 主机的公网中转验证](ip-relay-2026-10-12.md)。
这不代表完整 Bot 主机迁移到 VPS、各引擎云端登录或所有手机原生场景均已验收；
这些场景需要按实际部署分别验证。
