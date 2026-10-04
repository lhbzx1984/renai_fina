#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
把 deploy/nginx.conf.template 渲染成实际可用的 Nginx 配置。

用法：
  render_nginx.py <template> <domain> <输出路径> [--no-https]

--no-https 时会剔除整个 443 server 块——因为证书文件此时还不存在，
保留该块会导致 `nginx -t` 直接失败，部署无法完成。
"""
import sys
import os


def strip_tls_block(s):
    """移除包含 'listen 443' 的整个 server 块（含大括号配平）。"""
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


def main():
    if len(sys.argv) < 4:
        print('用法: render_nginx.py <template> <domain> <输出> [--no-https]', file=sys.stderr)
        return 2
    template, domain, out_path = sys.argv[1], sys.argv[2], sys.argv[3]
    no_https = '--no-https' in sys.argv[4:]

    if not os.path.exists(template):
        print(f'模板不存在: {template}', file=sys.stderr)
        return 1

    with open(template, encoding='utf-8') as f:
        s = f.read()

    s = s.replace('__DOMAIN__', domain)

    if no_https:
        s = strip_tls_block(s)
        out_lines = []
        for ln in s.splitlines():
            # HTTP 模式下不能下发 HSTS：浏览器会缓存并强制后续访问走 HTTPS，
            # 而此时根本没有 443，用户会被卡死。
            if 'Strict-Transport-Security' in ln:
                continue
            # HTTP 模式下不能 301 跳 HTTPS（443 未监听，会陷入重定向循环），
            # 改为直接放行到后端。
            if 'return 301 https://' in ln:
                out_lines.append('        # --no-https 模式：不跳转，直接反代到后端')
                out_lines.append('        proxy_pass         http://reimburse_backend;')
                out_lines.append('        proxy_http_version 1.1;')
                out_lines.append('        proxy_set_header Host              $host;')
                out_lines.append('        proxy_set_header X-Real-IP         $remote_addr;')
                out_lines.append('        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;')
                out_lines.append('        proxy_set_header X-Forwarded-Proto $scheme;')
                out_lines.append('        proxy_set_header Authorization     $http_authorization;')
                out_lines.append('        proxy_connect_timeout 10s;')
                out_lines.append('        proxy_read_timeout    120s;')
                out_lines.append('        client_max_body_size 20m;')
                continue
            out_lines.append(ln)
        s = '\n'.join(out_lines) + '\n'

        # 剔除 443 块时，其前面 80 块的收尾 '}' 可能一并被吃掉（取决于模板里
        # 两块的相邻关系），导致补 health 块时落在 server 外、花括号失衡。
        # 幂等地补回 80 块的收尾括号，再把 health location 塞进去。
        if not s.rstrip().endswith('}'):
            s = s.rstrip() + '\n}\n'

        # 443 块里的独立 health location 随块一并被删了，补回一个，
        # 保证 HTTP 模式下监控仍可探活（应用层该路径免鉴权）。
        if 'location = /api/health' not in s:
            s = s.rstrip()
            assert s.endswith('}')
            s = s[:-1] + '''
    # 健康检查（应用层该路径免鉴权，供监控探活）
    location = /api/health {
        proxy_pass       http://reimburse_backend;
        proxy_set_header Host $host;
        access_log off;
    }
}
'''

    with open(out_path, 'w', encoding='utf-8') as f:
        f.write(s)

    # 配平校验：渲染后花括号数量必须一致，否则 nginx -t 会失败。
    # 这类错误肉眼极难发现（配置几百行），必须程序化拦截。
    opens, closes = s.count('{'), s.count('}')
    if opens != closes:
        print(f'警告: 花括号不配平 (开={opens} 闭={closes})，nginx -t 会失败', file=sys.stderr)
        return 3

    print(f'nginx 配置已生成: {out_path} (domain={domain}, https={not no_https})')
    return 0


if __name__ == '__main__':
    sys.exit(main())
