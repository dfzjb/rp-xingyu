# -*- coding: utf-8 -*-
"""Step 0 · 服务器用户数据全量留底（一切删除操作的安全网）

对服务器 /opt/legacy/.rphub-data 整个目录打包下载到本地：
- 所有用户目录的全部 legacy_*.json 键
- .cards 角色卡共享池 / .imgcredits 生图账本 / .trash 软删除区 / 限流登记文件

用法:  python pull_all_data.py            # 正常执行
       python pull_all_data.py --keep    # 下载后保留本地 tar 包
只读操作：服务器端仅在 /tmp 打临时包，下载后即删。
"""
import os
import sys
import json
import shutil
import datetime
from pathlib import Path

import paramiko

# 凭据单一来源：tools/secrets_local.py（不入库；模板见 secrets_local.example.py）
try:
    from secrets_local import HOST, USER, PWD  # noqa: F401
except ImportError:
    raise SystemExit("缺少 tools/secrets_local.py（HOST/USER/PWD），请复制 secrets_local.example.py 填写")

REMOTE_DIR = "/opt/legacy/.rphub-data"
TOOLS_DIR = os.path.dirname(os.path.abspath(__file__))

STAMP = datetime.datetime.now().strftime("%Y%m%d_%H%M%S")
BACKUP_ROOT = os.path.join(TOOLS_DIR, f"server_backup_{STAMP}")
TAR_REMOTE = f"/tmp/rphub_full_{STAMP}.tar.gz"


def main():
    keep_tar = "--keep" in sys.argv
    os.makedirs(BACKUP_ROOT, exist_ok=True)
    cli = paramiko.SSHClient()
    cli.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    cli.connect(HOST, username=USER, password=PWD, timeout=15)

    def run(cmd, timeout=300):
        _, stdout, stderr = cli.exec_command(cmd, timeout=timeout)
        rc = stdout.channel.recv_exit_status()
        return rc, stdout.read().decode("utf-8", "replace").strip(), stderr.read().decode("utf-8", "replace").strip()

    # 1) 打包前统计（manifest 用）
    rc, out, err = run(
        f"cd {REMOTE_DIR} && "
        "echo USERS=$(find . -mindepth 1 -maxdepth 1 -type d ! -name '.*' | wc -l) && "
        "echo FILES=$(find . -type f | wc -l) && "
        "echo SIZE=$(du -sm . | cut -f1)"
    )
    print(f"[stat] rc={rc}\n{out}\n{err}")
    stats = dict(line.split("=", 1) for line in out.splitlines() if "=" in line)

    # 2) 服务器端整目录打包
    rc, out, err = run(f"cd {REMOTE_DIR} && tar czf {TAR_REMOTE} .", timeout=600)
    print(f"[pack] rc={rc} {err or 'OK'}")
    if rc != 0:
        sys.exit("打包失败，中止")

    rc, out, err = run(f"ls -lh {TAR_REMOTE} && tar tzf {TAR_REMOTE} | wc -l")
    print(f"[check] {out}")
    n_in_tar = int(out.strip().splitlines()[-1]) if out else 0

    # 3) 下载
    tar_local = os.path.join(BACKUP_ROOT, "rphub_full.tar.gz")
    sftp = cli.open_sftp()
    sftp.get(TAR_REMOTE, tar_local)
    sftp.close()
    size_mb = os.path.getsize(tar_local) / 1024 / 1024
    print(f"[download] {tar_local} ({size_mb:.1f} MB, tar 内 {n_in_tar} 条目)")

    # 4) 清理服务器临时包
    run(f"rm -f {TAR_REMOTE}")

    # 5) 本地解压
    data_dir = os.path.join(BACKUP_ROOT, "data")
    os.makedirs(data_dir, exist_ok=True)
    # 5) 本地解压（filter="data" 为官方 TarSlip 防护：拒绝绝对路径/.. 越界/链接等特殊成员）
    data_dir = os.path.join(BACKUP_ROOT, "data")
    os.makedirs(data_dir, exist_ok=True)
    shutil.unpack_archive(str(tar_local), data_dir, "gztar", filter="data")
    n_files = sum(len(files) for _, _, files in os.walk(data_dir))
    print(f"[extract] -> {data_dir} ({n_files} files)")
    print(f"[extract] -> {data_dir} ({n_files} files)")

    # 6) 写 manifest
    manifest = {
        "stamp": STAMP,
        "host": HOST,
        "remote_dir": REMOTE_DIR,
        "server_stat": stats,
        "tar_entries": n_in_tar,
        "tar_mb": round(size_mb, 1),
        "local_files": n_files,
    }
    manifest_path = os.path.join(BACKUP_ROOT, "manifest.json")
    Path(manifest_path).write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")

    if not keep_tar:
        os.remove(tar_local)
        print("[cleanup] 本地 tar 已删（--keep 可保留）")

    cli.close()
    print("DONE · 留底目录:", BACKUP_ROOT)


if __name__ == "__main__":
    main()
