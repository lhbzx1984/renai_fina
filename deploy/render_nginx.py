#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
把 deploy/nginx.conf.template 渲染成实际可用的 Nginx 配置。

用法：
  render_nginx.py <template> <domain> <输出路径> [--port 18080] [--no-https]

两个关键行为：
  --no-https  无域名（裸 IP 签不了 Let's Encrypt）时的形态：剔除 certbot 的 443 块，
              但对外端口仍以自签证书终结 TLS（listen ... ssl + /etc/nginx/ssl 自签证书）。
              原因：纯 HTTP 形态会让浏览器自动升 https 的用户直接连不上；
              自签证书浏览器会提示「不安全」，继续访问即可。
              证书由 deploy.sh 在渲染前生成（openssl req -x509）。
  --port N    对外监听端口。独立端口部署（IP 直访）时传 18080 之类，
              域名部署时传 80（由 deploy.sh 自动决定）。
"""
import argparse
import os
import sys

# 自签证书路径（deploy.sh 负责在渲染前生成，render 只引用）
SELF_SIGNED_CERT = '/etc/nginx/ssl/reimburse.crt'
SELF_SIGNED_KEY = '/etc/nginx/ssl/reimburse.key'


# HTTP 模式下替代「301 跳 HTTPS」的反代指令块
PROXY_LINES = [
    '        # 独立端口 / HTTP 模式：不跳转，直接反代到后端',
    '        proxy_pass         http://reimburse_backend;',
    '        proxy_http_version 1.1;',
    '        proxy_set_header Host              $host;',
    '        proxy_set_header X-Real-IP         $remote_addr;',
    '        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;',
    '        proxy_set_header X-Forwarded-Proto $scheme;',
    '        proxy_set_header Authorization     $http_authorization;',
    '        proxy_connect_timeout 10s;',
    '        proxy_send_timeout    120s;',
    '        proxy_read_timeout    120s;',
]


def strip_tls_block(s):
    """移除包含 'listen 443' 的整个 server 块（按大括号配平）。"""
    idx = s.find('listen 443')
    if idx == -1:
        return s
    start = s.rfind('server {', 0, idx)
    if start == -1:
        return s
    depth = 0
    j = start
    opened = False
    while j < len(s):
        if s[j] == '{':
            depth += 1
            opened = True
        elif s[j] == '}':
            depth -= 1
            if opened and depth == 0:
                j += 1
                break
        j += 1
    return s[:start] + s[j:]


def enable_self_signed_tls(s, port):
    """HTTP 块原地升级为自签证书的 HTTPS：listen 加 ssl 并插入证书路径。"""
    s = s.replace(f'listen {port};', f'listen {port} ssl;')
    s = s.replace(f'listen [::]:{port};', f'listen [::]:{port} ssl;')
    cert_lines = [
        f'    ssl_certificate     {SELF_SIGNED_CERT};',
        f'    ssl_certificate_key {SELF_SIGNED_KEY};',
        '    ssl_protocols       TLSv1.2 TLSv1.3;',
    ]
    anchor = f'listen {port} ssl;'
    idx = s.find(anchor)
    if idx == -1:
        return s
    # 插到 listen 行行尾之后
    end = s.find('\n', idx)
    return s[:end + 1] + '\n'.join(cert_lines) + '\n' + s[end + 1:]


def drop_ipv6_listen(s):
    """主机没有 IPv6 栈时去掉 listen [::]:... 行，否则 nginx 启动即失败。"""
    if os.path.exists('/proc/net/if_inet6'):
        return s
    return '\n'.join(ln for ln in s.splitlines() if '[::]' not in ln) + '\n'


def main():
    ap = argparse.ArgumentParser(add_help=True)
    ap.add_argument('template')
    ap.add_argument('domain')
    ap.add_argument('out')
    ap.add_argument('--port', default='80')
    ap.add_argument('--no-https', action='store_true')
    args = ap.parse_args()

    if not os.path.exists(args.template):
        print(f'模板不存在: {args.template}', file=sys.stderr)
        return 1

    with open(args.template, encoding='utf-8') as f:
        s = f.read()

    s = s.replace('__DOMAIN__', args.domain)
    s = s.replace('__HTTP_PORT__', str(args.port))

    if args.no_https:
        s = strip_tls_block(s)

        out_lines = []
        for ln in s.splitlines():
            # 自签 HTTPS 形态也不下发 HSTS：一旦下发，浏览器会强制记住「仅 HTTPS」，
            # 以后想把这套系统换回 HTTP 或换端口时会被卡死。
            if 'Strict-Transport-Security' in ln:
                continue
            # HTTP 模式下不能 301 跳 HTTPS（同端口已是 TLS，不需要也不应该跳）
            if 'return 301 https://' in ln:
                out_lines.extend(PROXY_LINES)
                continue
            out_lines.append(ln)
        s = '\n'.join(out_lines) + '\n'
        s = enable_self_signed_tls(s, str(args.port))

    s = drop_ipv6_listen(s)

    # 配平校验：渲染后花括号数量必须一致，否则 nginx -t 会失败。
    # 这类错误肉眼极难发现（配置几百行），必须程序化拦截。
    opens, closes = s.count('{'), s.count('}')
    if opens != closes:
        print(f'错误: 花括号不配平 (开={opens} 闭={closes})，nginx -t 会失败', file=sys.stderr)
        return 3

    # 每个 server 块都必须有 listen，否则该站点不生效且难以察觉
    if s.count('listen ') == 0:
        print('错误: 渲染结果里没有任何 listen 指令', file=sys.stderr)
        return 4

    with open(args.out, 'w', encoding='utf-8') as f:
        f.write(s)

    mode = 'self-signed-https' if args.no_https else 'https'
    print(f'nginx 配置已生成: {args.out} (domain={args.domain}, port={args.port}, mode={mode})')
    return 0


if __name__ == '__main__':
    sys.exit(main())
