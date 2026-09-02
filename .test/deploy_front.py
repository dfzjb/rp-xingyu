# -*- coding: utf-8 -*-
"""前端产物部署（仅 dist → /www/wwwroot/rp.dfzjb.site/new/，server 未变更不动）

流程：服务器端备份旧 index.html → SFTP 上传 assets/ 等资源 → 最后覆盖 index.html
（Vite 文件名带哈希，先传资源后换入口，访客不会加载到半新半旧的组合）
→ 线上哈希/状态码校验。

用法: python .test/deploy_front.py
"""
import os
import sys
import hashlib
import datetime
import paramiko

TOOLS_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'tools')
sys.path.insert(0, os.path.abspath(TOOLS_DIR))
from pull_all_data import HOST, USER, PWD  # noqa: E402  (凭据单一来源，不在本文件重复)

RP_SITE = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..'))
DIST = os.path.join(RP_SITE, 'dist')
REMOTE_DIR = '/www/wwwroot/rp.dfzjb.site/new'
STAMP = datetime.datetime.now().strftime('%Y%m%d_%H%M%S')


def sha256_bytes(b: bytes) -> str:
    return hashlib.sha256(b).hexdigest()


def main():
    local_index = open(os.path.join(DIST, 'index.html'), 'rb').read()
    local_hash = sha256_bytes(local_index)

    cli = paramiko.SSHClient()
    cli.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    cli.connect(HOST, username=USER, password=PWD, timeout=15)

    def run(cmd, timeout=120):
        _, stdout, stderr = cli.exec_command(cmd, timeout=timeout)
        rc = stdout.channel.recv_exit_status()
        return rc, stdout.read().decode('utf-8', 'replace').strip(), stderr.read().decode('utf-8', 'replace').strip()

    # 0) 部署前快照：目录现状 + 备份入口文件
    rc, out, _ = run(f"ls -la {REMOTE_DIR} | head -8")
    print(f"[before] rc={rc}\n{out}\n")
    rc, out, err = run(f"cp -a {REMOTE_DIR}/index.html {REMOTE_DIR}/index.html.bak-rpsite-{STAMP} && echo BACKUP_OK")
    print(f"[backup] rc={rc} {out or err}")
    if 'BACKUP_OK' not in out:
        sys.exit('备份失败，中止')

    # 1) 上传（除 index.html 外先传）
    sftp = cli.open_sftp()
    uploaded = []

    def ensure_remote_dir(path):
        parts = path.strip('/').split('/')
        cur = ''
        for p in parts:
            cur += '/' + p
            try:
                sftp.stat(cur)
            except FileNotFoundError:
                sftp.mkdir(cur)

    def upload_tree(local_dir, remote_dir):
        ensure_remote_dir(remote_dir)
        for name in sorted(os.listdir(local_dir)):
            lp = os.path.join(local_dir, name)
            rp = f"{remote_dir}/{name}"
            if os.path.isdir(lp):
                upload_tree(lp, rp)
            elif name == 'index.html' and local_dir == DIST:
                continue  # 入口最后传
            else:
                sftp.put(lp, rp)
                uploaded.append(rp)

    upload_tree(DIST, REMOTE_DIR)
    sftp.put(os.path.join(DIST, 'index.html'), f"{REMOTE_DIR}/index.html")
    uploaded.append(f"{REMOTE_DIR}/index.html")
    sftp.close()
    print(f"[upload] {len(uploaded)} files OK（index.html 最后覆盖）")

    # 2) 线上校验
    rc, out, err = run(f"sha256sum {REMOTE_DIR}/index.html")
    remote_hash = out.split()[0] if out else ''
    print(f"[hash] local={local_hash[:16]}… remote={remote_hash[:16]}… match={remote_hash == local_hash}")

    rc, out, err = run("curl -so /dev/null -w '%{http_code}' https://rp.dfzjb.site/new/")
    print(f"[page] https://rp.dfzjb.site/new/ -> {out}")

    # 取入口里引用的首个 assets 文件验证 200（immutable 缓存路径）
    rc, out, _ = run("curl -s https://rp.dfzjb.site/new/ | grep -o 'assets/index-[^\"]*\\.js' | head -1")
    first_asset = out.strip()
    if first_asset:
        rc, code, _ = run(f"curl -so /dev/null -w '%{{http_code}}' https://rp.dfzjb.site/new/{first_asset}")
        print(f"[asset] /new/{first_asset} -> {code}")
    else:
        print('[asset] 未能从线上入口解析出资源名（检查 grep）')

    rc, out, _ = run(f"ls {REMOTE_DIR}/index.html.bak-rpsite-{STAMP} && echo CLEAN")
    print(f"[rollback可用] {REMOTE_DIR}/index.html.bak-rpsite-{STAMP}")

    cli.close()
    print('DONE · 部署完成' if remote_hash == local_hash else 'FAIL · 哈希不一致，需排查')
    sys.exit(0 if remote_hash == local_hash else 1)


if __name__ == '__main__':
    main()
