# 手动配置 VPS 中转

[English](vps-relay-manual.md) · [Agent 配置与手机说明](remote-access.md)

本教程在 **已有电脑主机**和 Debian/Ubuntu VPS 之间增加中转，保留原 Bot、聊天和配对。
电脑侧命令适用于 macOS/Linux 的 POSIX shell；Windows 需使用自己的服务和计划任务机制。
每个命令块都要先替换示例地址与绝对路径，不要把整个教程直接粘贴到终端执行。

## 1. 确认原主机、SSH 和端口（电脑）

准备 Node.js 24、OpenSSL 3、当前源码构建（`npm ci` 后 `npm run build`）、已验证的
VPS SSH 连接，以及原 Hub 的状态目录。VPS 也需要可供服务账号运行的 Node.js 24 和
Certbot 5.4+；Certbot 安装方式见[官方说明](https://certbot.eff.org/instructions)。
桌面 App 自带的 Node 可管理原 Hub，但编译中转程序需要源码目录。

设置以下变量，`192.0.2.10` 是文档专用地址，必须替换：

```sh
export TARO_VPS_IP='192.0.2.10'
export TARO_HUB_DIR='/absolute/path/to/existing-hub'
export TARO_PACKAGE_DIR='/absolute/path/to/host-package'
export TARO_NODE='/absolute/path/to/node'
export TARO_RELAY_DIR="$TARO_HUB_DIR/vps-relay"
umask 077
mkdir -p "$TARO_RELAY_DIR"
chmod 700 "$TARO_RELAY_DIR"
"$TARO_NODE" "$TARO_PACKAGE_DIR/dist/src/index.js" hub service status --state-dir "$TARO_HUB_DIR"
```

macOS App 安装在 Applications 时，通常使用：

- `TARO_HUB_DIR`：`$HOME/Library/Application Support/com.tarocub.client/host`
- `TARO_PACKAGE_DIR`：`/Applications/TaroBot.app/Contents/Resources/host`
- `TARO_NODE`：`/Applications/TaroBot.app/Contents/Resources/host/node`

源码主机要使用启动时实际传入的 `--state-dir`。CLI 默认 `$HOME/.cctb/hub`，与桌面
App 的目录不同。先记录主机状态和公钥，按[备份说明](operations.md#backup-and-export)
做私有备份，保留 `config.json`、`identity.json`、数据库和附件。不要直接复制正在写入的
SQLite 主文件而遗漏 WAL。

在 `~/.ssh/config` 添加别名，填写自己的账号和私钥路径：

```sshconfig
Host tarobot-relay
    HostName 192.0.2.10
    User ubuntu
    IdentityFile /absolute/path/to/vps.pem
    IdentitiesOnly yes
    StrictHostKeyChecking yes
    BatchMode yes
    ConnectTimeout 10
```

先通过云控制台核验 SSH 主机密钥指纹，再加入 `known_hosts`；不要关闭主机密钥校验。
SSH 私钥留在本机，只允许当前账号读取。加密私钥按正常方式通过 SSH agent 解锁；
无人值守任务也必须能使用已授权的非交互认证，否则之后的证书拉取会失败。

查看 VPS 当前监听端口并确认 sudo 权限：

```sh
ssh tarobot-relay 'sudo -n true && sudo ss -lntp'
```

本教程使用空闲的 **8443（手机 HTTPS）**、**7443（电脑隧道）**、
**19878（VPS 本机健康检查）**和 **9443（电脑本机 TLS）**。电脑端也要检查端口是否冲突。
保留现有网站、SSH、防火墙和证书任务；这些步骤不套用 `hub relay deploy` 的专用服务器
防火墙策略。

## 2. 生成独立隧道凭据（电脑）

在新建的私有目录执行一次；遇到已有私钥时应检查现有配置，不要覆盖：

```sh
set -eu
cd "$TARO_RELAY_DIR"
for tls_key in tunnel-ca.key tunnel-client.key tunnel-server.key; do
  if test -e "$tls_key"; then printf 'Existing key: %s\n' "$tls_key" >&2; exit 1; fi
done
openssl req -x509 -newkey rsa:3072 -nodes -keyout tunnel-ca.key \
  -out tunnel-ca.pem -days 3650 -subj '/CN=TaroBot private tunnel CA' \
  -addext 'basicConstraints=critical,CA:TRUE' \
  -addext 'keyUsage=critical,keyCertSign,cRLSign'
openssl req -new -newkey rsa:3072 -nodes -keyout tunnel-server.key \
  -out tunnel-server.csr -subj '/CN=tarobot-tunnel.internal'
cat > tunnel-server.ext <<'EOF'
basicConstraints=critical,CA:FALSE
keyUsage=critical,digitalSignature,keyEncipherment
extendedKeyUsage=serverAuth
subjectAltName=DNS:tarobot-tunnel.internal
EOF
openssl x509 -req -in tunnel-server.csr -CA tunnel-ca.pem -CAkey tunnel-ca.key \
  -CAcreateserial -out tunnel-server.pem -days 365 -extfile tunnel-server.ext
openssl req -new -newkey rsa:3072 -nodes -keyout tunnel-client.key \
  -out tunnel-client.csr -subj '/CN=TaroBot host tunnel client'
cat > tunnel-client.ext <<'EOF'
basicConstraints=critical,CA:FALSE
keyUsage=critical,digitalSignature
extendedKeyUsage=clientAuth
EOF
openssl x509 -req -in tunnel-client.csr -CA tunnel-ca.pem -CAkey tunnel-ca.key \
  -CAcreateserial -out tunnel-client.pem -days 365 -extfile tunnel-client.ext
openssl x509 -in tunnel-client.pem -noout -fingerprint -sha256
```

保存最后输出的 SHA-256 客户端指纹，后面填入中转配置。
`tarobot-tunnel.internal` 是隧道证书里的名称，不需要在公网注册域名。
CA 私钥和客户端私钥留在电脑上；只有 CA **证书**、隧道服务端证书及服务端私钥上传 VPS。
隧道证书示例有效期一年，到期前需单独轮换，不由后面的公网证书任务续期。

## 3. 申请可信公网证书（电脑和 VPS）

示例使用固定公网 IPv4，无需域名。已有域名也可以使用：改为 DNS SAN、配置 DNS 指向
VPS，并选择该域名适用的 ACME 验证和续期方式。不要用自签证书或关闭客户端 TLS 校验
代替可信证书配置。

**电脑上：**生成业务 HTTPS 私钥和 CSR，主体留空，IP 写入 IP SAN，不要写入 CN。

```sh
set -eu
cd "$TARO_RELAY_DIR"
test ! -e hub.key
openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 -out hub.key
openssl req -new -key hub.key -out hub.csr -subj '/' \
  -addext "subjectAltName=IP:$TARO_VPS_IP"
ssh tarobot-relay 'umask 077; mkdir -p ~/tarobot-stage'
scp hub.csr tarobot-relay:tarobot-stage/hub.csr
```

**VPS 上：**让公网 **HTTP 80 端口**能提供 `/.well-known/acme-challenge/` 文件。
已有 Nginx HTTP 网站时，在处理该 IP 请求的 server 中追加以下 location，保留其他路由：

```nginx
location ^~ /.well-known/acme-challenge/ {
    root /var/lib/tarobot-acme;
    try_files $uri =404;
}
```

80 端口空闲时，可安装 Nginx 并建立监听 80 的 server，再放入该 location；重载前运行
`sudo nginx -t`。如果现有 80 端口提供的是 **TLS**，只加 HTTP location 不够，应按
[协议分流说明](relay-deployment.md#dedicated-public-ip-endpoints)保留原 TLS 服务，
或使用域名加 DNS-01 验证。不要为了申请证书停止无关网站。云厂商和系统防火墙均需
允许 80 端口上的验证请求。

建立验证目录和只存放公开 CSR／证书的目录：

```sh
sudo install -d -m 0755 /var/lib/tarobot-acme/.well-known/acme-challenge
sudo install -d -m 0755 /var/lib/tarobot-public-tls
sudo install -m 0644 ~/tarobot-stage/hub.csr /var/lib/tarobot-public-tls/hub.csr
```

先放一个无敏感内容的临时验证文件，从公网确认可读取，再删除。
用 `command -v certbot`、`certbot --version` 确认路径与版本，并用自己的邮箱注册
ACME 账号、确认服务条款。

把以下脚本保存为 VPS 上 root 所有、权限 0755 的
`/usr/local/sbin/tarobot-renew-public-tls`，替换 IP 和 Certbot 绝对路径。
没有证书时会首次申请，剩余有效期少于三天时重新申请：

```sh
#!/bin/sh
set -eu
umask 077
exec 9>/run/tarobot-public-tls.lock
flock -n 9 || exit 0
tls_root=/var/lib/tarobot-public-tls
if openssl x509 -in "$tls_root/fullchain.pem" -noout -checkend 259200 >/dev/null 2>&1; then exit 0; fi
tls_stage=$(mktemp -d "$tls_root/staging.XXXXXX")
trap 'rm -rf "$tls_stage"' EXIT
/absolute/path/to/certbot certonly --non-interactive --webroot \
  -w /var/lib/tarobot-acme --preferred-profile shortlived --ip-address 192.0.2.10 \
  --csr "$tls_root/hub.csr" --cert-path "$tls_stage/cert.pem" \
  --chain-path "$tls_stage/chain.pem" --fullchain-path "$tls_stage/fullchain.pem"
openssl x509 -in "$tls_stage/fullchain.pem" -noout -checkip 192.0.2.10
openssl x509 -in "$tls_stage/fullchain.pem" -noout -checkend 259200
for tls_name in cert.pem chain.pem fullchain.pem; do
  install -m 0644 "$tls_stage/$tls_name" "$tls_root/$tls_name.new"
  mv "$tls_root/$tls_name.new" "$tls_root/$tls_name"
done
```

在 VPS 执行 `sudo /usr/local/sbin/tarobot-renew-public-tls`。
业务私钥 `hub.key` 从未离开电脑，VPS 只使用 CSR。成功后，在**电脑**取回公开证书链：

```sh
# Computer
scp tarobot-relay:/var/lib/tarobot-public-tls/fullchain.pem "$TARO_RELAY_DIR/fullchain.pem"
openssl x509 -in "$TARO_RELAY_DIR/fullchain.pem" -noout -checkip "$TARO_VPS_IP" -dates
```

IP 证书使用短有效期方案。传入 CSR 的签发流程不由 `certbot renew` 自动管理，必须
继续完成第 6 步的续期和加载。依据：[Let’s Encrypt 的 IP 证书说明](https://letsencrypt.org/2026/03/11/shorter-certs-certbot)、
[Certbot 的 CSR 与续期说明](https://eff-certbot.readthedocs.io/en/stable/using.html)。

## 4. 安装独立中转服务（VPS）

先在**电脑的源码目录**构建并上传中转单文件及明确需要的服务端凭据；不要在 App
安装包目录运行 npm，也不要上传整个 Hub 目录：

```sh
# From the source checkout, not the app bundle
npm ci
npm run build
scp dist/relay-runtime.mjs tarobot-relay:tarobot-stage/relay.mjs
scp "$TARO_RELAY_DIR/tunnel-ca.pem" "$TARO_RELAY_DIR/tunnel-server.pem" \
  "$TARO_RELAY_DIR/tunnel-server.key" tarobot-relay:tarobot-stage/
```

以下首次安装命令在 **VPS** 执行。若账号或安装目录已经存在，先检查和备份原配置，
不要直接覆盖：

```sh
sudo useradd --system --user-group --no-create-home --shell /usr/sbin/nologin tarobot-relay
sudo install -d -o root -g tarobot-relay -m 0750 /opt/tarobot-relay
sudo install -o root -g tarobot-relay -m 0640 ~/tarobot-stage/relay.mjs \
  ~/tarobot-stage/tunnel-ca.pem ~/tarobot-stage/tunnel-server.pem \
  ~/tarobot-stage/tunnel-server.key /opt/tarobot-relay/
rm ~/tarobot-stage/tunnel-server.key
```

创建 `/opt/tarobot-relay/relay.json`，文件由 root 所有、组为 `tarobot-relay`、权限
0640。替换公网 IP 和客户端指纹；指纹只填冒号分隔的十六进制部分，去掉 OpenSSL 输出
中的 `sha256 Fingerprint=` 前缀：

```json
{
  "serverName": "192.0.2.10",
  "publicPort": 8443,
  "tunnelPort": 7443,
  "healthPort": 19878,
  "maxConnections": 128,
  "clientFingerprint256": "REPLACE_WITH_COLON_SEPARATED_SHA256_FINGERPRINT",
  "tls": {
    "ca": "/opt/tarobot-relay/tunnel-ca.pem",
    "cert": "/opt/tarobot-relay/tunnel-server.pem",
    "key": "/opt/tarobot-relay/tunnel-server.key"
  }
}
```

创建 `/etc/systemd/system/tarobot-relay.service`，root 所有、权限 0644。
将 Node 路径替换为系统级 Node 24 可执行文件；`ProtectHome` 会阻止读取其他用户
家目录内的 Node，因此不要直接指向那里的 nvm 路径。

```ini
[Unit]
Description=TaroBot TLS passthrough relay
After=network-online.target
Wants=network-online.target
[Service]
Type=simple
User=tarobot-relay
Group=tarobot-relay
ExecStart=/absolute/path/to/node /opt/tarobot-relay/relay.mjs --config /opt/tarobot-relay/relay.json
Restart=always
RestartSec=3
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
UMask=0077
[Install]
WantedBy=multi-user.target
```

在 VPS 启动并查看状态：

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now tarobot-relay
sudo systemctl status tarobot-relay --no-pager
curl --fail --max-time 5 http://127.0.0.1:19878/health
```

第 5 步之前 `connected: false` 表示尚未连接电脑，属于预期状态。
在**云厂商入站规则和系统防火墙**中放行 8443、7443，保留 SSH 和已有业务的规则。
不要公开 19878、电脑端 9443、Hub HTTP／instance 端口或控制套接字；电脑需能出站连接
VPS 的 7443。公网 IPv4 入口需要当前中转程序支持无 SNI 连接，不能因为手机是最新版
就部署旧中转程序。

## 5. 追加原 Hub 配置（电脑）

备份 `config.json`，保留原来的 `host`、`port`、`instancePort`、局域网／Tailscale
监听及其他字段。以下是需要**合并到** `origins`、`tlsListeners`、`relays` 的条目，
不是完整替换文件；所有 IP 和私有绝对路径均需替换：

```json
{
  "origins": ["https://192.0.2.10:8443"],
  "tlsListeners": [{
    "host": "127.0.0.1",
    "port": 9443,
    "tls": {
      "cert": "/absolute/path/to/existing-hub/vps-relay/fullchain.pem",
      "key": "/absolute/path/to/existing-hub/vps-relay/hub.key"
    }
  }],
  "relays": [{
    "id": "vps-primary",
    "label": "My VPS",
    "host": "192.0.2.10",
    "port": 7443,
    "servername": "tarobot-tunnel.internal",
    "targetHost": "127.0.0.1",
    "targetPort": 9443,
    "tls": {
      "ca": "/absolute/path/to/existing-hub/vps-relay/tunnel-ca.pem",
      "cert": "/absolute/path/to/existing-hub/vps-relay/tunnel-client.pem",
      "key": "/absolute/path/to/existing-hub/vps-relay/tunnel-client.key"
    }
  }]
}
```

原配置如有单数 `relay`，应将原条目加上唯一 `id` 后迁入 `relays`，不能同时保留两种字段。
每个隧道目标必须对应同一配置中已定义的 loopback TLS 监听。等正在执行的任务结束后，
桌面 App／后台独立 Hub 可用以下命令重启：

```sh
"$TARO_NODE" "$TARO_PACKAGE_DIR/dist/src/index.js" hub service restart --state-dir "$TARO_HUB_DIR"
"$TARO_NODE" "$TARO_PACKAGE_DIR/dist/src/index.js" hub relay status --state-dir "$TARO_HUB_DIR"
```

systemd 管理的 Hub 应通过它原来的 service 重启，不能再启动第二个独立 Hub。
检查 `online: true`，并对照部署前的公钥与公网 `/health` 返回的公钥；公钥相同仅是
初步核对，不能替代第 7 步的签名认证与同步验收。

## 6. 续期和加载证书（两端）

**VPS：**把以下两个文件分别保存到
`/etc/systemd/system/tarobot-public-tls.service` 和 `.timer`：

```ini
[Unit]
Description=Renew TaroBot public certificate from host CSR
After=network-online.target
[Service]
Type=oneshot
ExecStart=/usr/local/sbin/tarobot-renew-public-tls
UMask=0077
```

```ini
[Unit]
Description=Check TaroBot public certificate every six hours
[Timer]
OnBootSec=5min
OnUnitActiveSec=6h
RandomizedDelaySec=2min
Persistent=true
[Install]
WantedBy=timers.target
```

启用定时任务，并检查一次执行结果：

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now tarobot-public-tls.timer
sudo systemctl start tarobot-public-tls.service
sudo systemctl list-timers tarobot-public-tls.timer --no-pager
sudo journalctl -u tarobot-public-tls.service -n 20 --no-pager
```

**电脑：**使用拥有 Hub 的账号建立每小时运行的 launchd 任务（macOS）或用户
systemd timer（Linux），更新动作需包括：

1. 经核验的 SSH 或独立可信 HTTPS 取回 `/var/lib/tarobot-public-tls/fullchain.pem`，
   限制下载时长和大小，只拉取公开证书链。
2. 核对 IP／域名、有效期、与本机私钥匹配及到期时间向前推进，保留旧证书；
   不下载或替换 `hub.key`。
3. 内容未变时不重启；有活跃任务时延后。使用 Hub 的 `desktop-start` 文件锁原子替换，
   只通过原服务管理器重启正在运行的主机，验证身份不变，失败时回滚。
4. 用户已停止的主机保持停止。凭据不写进参数或日志，检查任务最后退出状态；
   SSH 私钥如果需要无人值守时无法取得的交互解锁，须先解决授权认证方式。

中转安装器**不会安装电脑上的证书拉取任务**，它需要匹配你的真实路径和服务管理器。
不熟悉本机计划任务时可使用[Agent 部署说明](remote-access.md#方式一让有终端和-ssh-能力的-agent-配置)
让 Agent 配置。在该任务就绪前，需自己定期维护，不能把一次成功当成无人值守完成。
手动拉取和校验命令如下：

```sh
# Computer: private staging only; validate before replacing the active chain.
scp tarobot-relay:/var/lib/tarobot-public-tls/fullchain.pem "$TARO_RELAY_DIR/fullchain.next.pem"
openssl x509 -in "$TARO_RELAY_DIR/fullchain.next.pem" -noout -checkip "$TARO_VPS_IP" -checkend 86400
"$TARO_NODE" --input-type=module <<'JS'
import { readFile } from 'node:fs/promises';
import { X509Certificate, createPrivateKey } from 'node:crypto';
const directory = process.env.TARO_RELAY_DIR;
const next = new X509Certificate(await readFile(directory + '/fullchain.next.pem'));
const old = new X509Certificate(await readFile(directory + '/fullchain.pem'));
const key = createPrivateKey(await readFile(directory + '/hub.key'));
if (!next.checkIP(process.env.TARO_VPS_IP) || !next.checkPrivateKey(key)
    || Date.parse(next.validFrom) > Date.now() || Date.parse(next.validTo) < Date.now() + 86400000
    || Date.parse(next.validTo) < Date.parse(old.validTo)) throw new Error('Invalid renewed certificate');
console.log('Certificate validated. Install only after the Hub is idle.');
JS
```

校验通过且 Hub 空闲后，将旧链另存为私有的 `fullchain.previous.pem`，用暂存文件
替换当前链，并按第 5 步重启原 Hub；验收失败则恢复旧链。CSR 证书需持续重新申请，
VPS 成功续期不会自动让电脑加载新证书；两个环节和到期时间都要检查。

## 7. 手机连接和验收

已有配对的手机进入 **我的 → 设置 → 连接 → 编辑线路**，选**本地电脑运行 Bot**，
保留直连地址，新增 `https://你的VPS公网IP:8443` 后保存。不要删除原主机或重置配对。
首次连接的设备需要原主机的可信身份／二维码及配对批准，见[手机设置](remote-access.md#手机怎么填)。

逐项核对：

- 公网 `curl --fail --max-time 15 https://你的VPS公网IP:8443/health` 正常，
  不使用 `-k` 或绕过证书校验。
- 原已配对的原生客户端通过实际 TLS 证书绑定验证、设备签名认证，并同步原 Bot 与历史。
- 未登录请求 `/api/conversations` 返回 401。
- 手机关闭 Wi-Fi 后，流量网络仍能通过 VPS 连接。
- 只重启中转服务，电脑隧道和手机连接可以恢复。
- VPS 原有网站／业务与原局域网线路仍可使用。
- VPS 续期任务和电脑加载任务均已安排且当前执行成功；如尚未发生真正换证，明确记录。

`connected: false` 只确认中转进程启动；`connected: true` 也不能证明手机已通过认证。
VPS 和原电脑都要保持在线，电脑不应休眠。部署文件与密钥留在私有目录，不进入 Git。
知道入口地址不代表获得使用权限，但陌生设备的配对请求不要批准。
