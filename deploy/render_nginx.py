#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
把 deploy/nginx.conf.template 渲染成实际可用的 Nginx 配置。

用法：
  render_nginx.py <template> <domain> <输出路径> [--port 18080] [--no-https]

两个关键行为：
  --no-https  剔除整个 443 server 块，并把 HTTP 块里的 301 跳转换成反代。
              原因：证书文件此时还不存在，保留该块会让 nginx -t 直接失败；
              而没有 443 时下发 HSTS 或 301 会把用户永久卡死。
  --port N    对外监听端口。独立端口部署（IP 直访）时传 18080 之类，
              域名部署时传 80（由 deploy.sh 自动决定）。
"""
import argparse
import os
import sys


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
            # HTTP 模式下不能下发 HSTS：浏览器会缓存并强制后续访问走 HTTPS，
            # 而此时根本没有 443，用户会被彻底卡死。
            if 'Strict-Transport-Security' in ln:
                continue
            # HTTP 模式下不能 301 跳 HTTPS（443 未监听，会陷入重定向循环）
            if 'return 301 https://' in ln:
                out_lines.extend(PROXY_LINES)
                continue
            out_lines.append(ln)
        s = '\n'.join(out_lines) + '\n'

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

    mode = 'http' if args.no_https else 'https'
    print(f'nginx 配置已生成: {args.out} (domain={args.domain}, port={args.port}, mode={mode})')
    return 0


if __name__ == '__main__':
    sys.exit(main())
