#!/usr/bin/env python3
"""
AI Pipeline - Temp File Cleanup
================================
Downloads, /tmp 등 임시 폴더의 오래된 파일 정리

Usage:
    python temp_cleanup.py                           # 설정 파일 폴더 정리
    python temp_cleanup.py --dry-run                 # 미리보기만
    python temp_cleanup.py --days 14                 # 14일 이상 된 파일
    python temp_cleanup.py --yes                     # 확인 없이 삭제
    python temp_cleanup.py --folders "~/Downloads,~/Desktop/temp"  # 특정 폴더

Options:
    --folders PATH,...    쉼표로 구분된 정리 대상 폴더 경로
    --days N              N일 이상 된 파일만 삭제 (기본: 30)
    --exclude PATTERN,... 제외할 파일 패턴 (기본: .DS_Store,*.app)
    --dry-run             실제 삭제 없이 미리보기
    --yes                 확인 없이 삭제
    --slack               Slack 알림 전송

Requirements:
    - config/settings.yaml에 cleanup 설정 (--folders 미지정 시)
"""

import json
import os
import shutil
import sys
import urllib.request
from datetime import datetime, timedelta
from pathlib import Path
from typing import Optional

import yaml


CONFIG_PATH = Path(__file__).parent.parent / "config" / "settings.yaml"


def load_config() -> dict:
    """설정 파일 로드 (우선순위 적용)"""
    config_files = [
        CONFIG_PATH.parent / "settings.local.yaml",
        CONFIG_PATH,
        CONFIG_PATH.parent / "settings.example.yaml",
    ]
    for config_file in config_files:
        if config_file.exists():
            with open(config_file, "r", encoding="utf-8") as f:
                return yaml.safe_load(f)
    return {}


CONFIG = load_config()


def get_cleanup_config() -> dict:
    """정리 설정 조회"""
    return CONFIG.get("cleanup", {})


def get_target_folders(
    override_paths: list[str] = None,
    default_days: int = 30,
    default_exclude: list[str] = None
) -> list[dict]:
    """정리 대상 폴더 목록

    Args:
        override_paths: 옵션으로 전달된 폴더 경로 목록 (설정 파일 대신 사용)
        default_days: 기본 보관 기간 (일)
        default_exclude: 기본 제외 패턴
    """
    if default_exclude is None:
        default_exclude = [".DS_Store", "*.app"]

    # 옵션으로 폴더가 전달된 경우
    if override_paths:
        folders = []
        for path in override_paths:
            path = path.strip()
            if not path:
                continue
            folders.append({
                "path": path,
                "days": default_days,
                "patterns": ["*"],
                "exclude": default_exclude,
            })
        return folders

    # 설정 파일에서 조회
    cleanup_config = get_cleanup_config()
    folders = cleanup_config.get("folders", [])

    # 기본 폴더 (설정 없으면)
    if not folders:
        home = Path.home()
        folders = [
            {
                "path": str(home / "Downloads"),
                "days": 30,
                "patterns": ["*"],
                "exclude": [".DS_Store", "*.app"],
            },
            {
                "path": "/tmp",
                "days": 7,
                "patterns": ["*"],
                "exclude": [],
                "user_only": True,  # 현재 사용자 소유 파일만
            },
        ]

    return folders


def human_readable_size(size: int) -> str:
    """파일 크기를 읽기 좋게 변환"""
    for unit in ['B', 'KB', 'MB', 'GB']:
        if size < 1024:
            return f"{size:.1f} {unit}"
        size /= 1024
    return f"{size:.1f} TB"


def get_file_age_days(path: Path) -> int:
    """파일 나이 (일 단위)"""
    try:
        mtime = path.stat().st_mtime
        age = datetime.now() - datetime.fromtimestamp(mtime)
        return age.days
    except (OSError, ValueError):
        return 0


def should_exclude(path: Path, exclude_patterns: list[str]) -> bool:
    """제외 패턴 확인"""
    name = path.name

    for pattern in exclude_patterns:
        if pattern.startswith("*."):
            # 확장자 패턴
            if name.endswith(pattern[1:]):
                return True
        elif pattern == name:
            return True

    return False


def scan_folder(folder_config: dict) -> list[dict]:
    """폴더 스캔하여 삭제 대상 파일 목록"""
    folder_path = Path(folder_config["path"]).expanduser()
    days_threshold = folder_config.get("days", 30)
    patterns = folder_config.get("patterns", ["*"])
    exclude = folder_config.get("exclude", [])
    user_only = folder_config.get("user_only", False)

    if not folder_path.exists():
        return []

    files_to_delete = []
    current_uid = os.getuid() if user_only else None

    for pattern in patterns:
        for path in folder_path.glob(pattern):
            # 숨김 파일 기본 제외 (. 으로 시작)
            if path.name.startswith(".") and ".*" not in patterns:
                continue

            # 제외 패턴 확인
            if should_exclude(path, exclude):
                continue

            # 사용자 소유 확인
            if user_only and current_uid is not None:
                try:
                    if path.stat().st_uid != current_uid:
                        continue
                except OSError:
                    continue

            # 파일 나이 확인
            age_days = get_file_age_days(path)
            if age_days < days_threshold:
                continue

            # 파일/폴더 크기
            try:
                if path.is_file():
                    size = path.stat().st_size
                elif path.is_dir():
                    size = sum(f.stat().st_size for f in path.rglob("*") if f.is_file())
                else:
                    continue
            except OSError:
                continue

            files_to_delete.append({
                "path": path,
                "name": path.name,
                "is_dir": path.is_dir(),
                "size": size,
                "age_days": age_days,
            })

    # 크기 기준 정렬 (큰 것 먼저)
    files_to_delete.sort(key=lambda x: x["size"], reverse=True)

    return files_to_delete


def delete_item(path: Path) -> bool:
    """파일/폴더 삭제"""
    try:
        if path.is_dir():
            shutil.rmtree(path)
        else:
            path.unlink()
        return True
    except (OSError, PermissionError) as e:
        print(f"   ⚠️  삭제 실패: {path.name} - {e}")
        return False


def cleanup_folder(folder_config: dict, dry_run: bool = False) -> dict:
    """단일 폴더 정리"""
    folder_path = Path(folder_config["path"]).expanduser()
    days_threshold = folder_config.get("days", 30)

    result = {
        "folder": str(folder_path),
        "days": days_threshold,
        "files": [],
        "deleted": [],
        "failed": [],
        "total_size": 0,
        "freed_size": 0,
    }

    if not folder_path.exists():
        result["error"] = "폴더가 존재하지 않습니다"
        return result

    # 스캔
    files = scan_folder(folder_config)
    result["files"] = files
    result["total_size"] = sum(f["size"] for f in files)

    if dry_run:
        return result

    # 삭제
    for item in files:
        if delete_item(item["path"]):
            result["deleted"].append(item)
            result["freed_size"] += item["size"]
        else:
            result["failed"].append(item)

    return result


def send_slack_notification(results: list[dict]) -> bool:
    """Slack으로 알림 전송"""
    webhook_url = os.environ.get("SLACK_WEBHOOK_URL")

    if not webhook_url:
        print("⚠️  SLACK_WEBHOOK_URL 환경변수가 설정되지 않았습니다.")
        return False

    total_freed = sum(r.get("freed_size", 0) for r in results)
    total_deleted = sum(len(r.get("deleted", [])) for r in results)

    if total_deleted == 0:
        return True

    blocks = [
        {
            "type": "header",
            "text": {
                "type": "plain_text",
                "text": f"🧹 임시 파일 정리 ({human_readable_size(total_freed)} 확보)",
                "emoji": True
            }
        },
        {"type": "divider"},
    ]

    for result in results:
        deleted = result.get("deleted", [])
        if deleted:
            freed = human_readable_size(result.get("freed_size", 0))
            blocks.append({
                "type": "section",
                "text": {
                    "type": "mrkdwn",
                    "text": f"*{result['folder']}*\n{len(deleted)}개 삭제 ({freed})"
                }
            })

    payload = {"blocks": blocks}

    try:
        data = json.dumps(payload).encode("utf-8")
        request = urllib.request.Request(
            webhook_url,
            data=data,
            headers={"Content-Type": "application/json"}
        )
        with urllib.request.urlopen(request, timeout=10) as response:
            return response.status == 200
    except Exception as e:
        print(f"⚠️  Slack 알림 전송 실패: {e}")
        return False


def print_summary(results: list[dict], dry_run: bool):
    """콘솔에 요약 출력"""
    print("\n" + "━" * 50)
    print("🧹 임시 파일 정리 결과" + (" (미리보기)" if dry_run else ""))
    print("━" * 50)

    total_files = 0
    total_size = 0
    total_freed = 0

    for result in results:
        if "error" in result:
            print(f"\n❌ {result['folder']}: {result['error']}")
            continue

        files = result.get("files", [])
        deleted = result.get("deleted", [])
        size = result.get("total_size", 0)
        freed = result.get("freed_size", 0)

        total_files += len(files)
        total_size += size
        total_freed += freed

        print(f"\n📁 {result['folder']}")
        print(f"   기준: {result['days']}일 이상")

        if not files:
            print("   ✨ 정리할 파일이 없습니다.")
            continue

        print(f"   파일: {len(files)}개 ({human_readable_size(size)})")

        # 상위 5개 표시
        for item in files[:5]:
            name = item["name"]
            age = item["age_days"]
            size_str = human_readable_size(item["size"])
            is_dir = "📂" if item["is_dir"] else "📄"

            if dry_run:
                status = "🗑️ 삭제 예정"
            elif item in deleted:
                status = "✅ 삭제됨"
            else:
                status = "❌ 실패"

            print(f"     {is_dir} {name} ({size_str}, {age}일 전) {status}")

        if len(files) > 5:
            print(f"     ...외 {len(files) - 5}개")

    print("\n" + "━" * 50)
    if dry_run:
        print(f"총 {total_files}개 파일, {human_readable_size(total_size)} 정리 예정")
    else:
        print(f"총 {human_readable_size(total_freed)} 확보")
    print("━" * 50)


def main():
    # 옵션 파싱
    args = sys.argv[1:]

    dry_run = False
    yes_mode = False
    slack_mode = False
    days_override = None
    folder_paths = None  # --folders 옵션으로 전달된 경로들
    exclude_patterns = None  # --exclude 옵션으로 전달된 패턴들

    i = 0
    while i < len(args):
        arg = args[i]
        if arg == "--dry-run":
            dry_run = True
            i += 1
        elif arg in ("--yes", "-y"):
            yes_mode = True
            i += 1
        elif arg == "--slack":
            slack_mode = True
            i += 1
        elif arg == "--days" and i + 1 < len(args):
            days_override = int(args[i + 1])
            i += 2
        elif arg == "--folders" and i + 1 < len(args):
            # 쉼표로 구분된 폴더 경로 파싱
            folder_paths = [p.strip() for p in args[i + 1].split(",") if p.strip()]
            i += 2
        elif arg == "--exclude" and i + 1 < len(args):
            # 쉼표로 구분된 제외 패턴 파싱
            exclude_patterns = [p.strip() for p in args[i + 1].split(",") if p.strip()]
            i += 2
        else:
            i += 1

    print("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")
    print("🧹 Temp File Cleanup")
    print("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")
    if dry_run:
        print("   모드: 미리보기 (삭제 안 함)")
    if folder_paths:
        print(f"   소스: 옵션 지정 ({len(folder_paths)}개 폴더)")
    print("")

    # 대상 폴더 조회
    folders = get_target_folders(
        override_paths=folder_paths,
        default_days=days_override or 30,
        default_exclude=exclude_patterns
    )

    # days 옵션 적용 (설정 파일 사용 시)
    if days_override and not folder_paths:
        for folder in folders:
            folder["days"] = days_override

    print(f"   대상 폴더: {len(folders)}개")
    for folder in folders:
        print(f"     - {folder['path']} ({folder.get('days', 30)}일 이상)")
    print("")

    # 스캔
    print("📡 파일 스캔 중...")
    results = []
    for folder in folders:
        result = cleanup_folder(folder, dry_run=True)
        results.append(result)

    print_summary(results, dry_run=True)

    # dry-run이면 여기서 종료
    if dry_run:
        return

    # 삭제할 파일이 있는지 확인
    total_files = sum(len(r.get("files", [])) for r in results)
    total_size = sum(r.get("total_size", 0) for r in results)

    if total_files == 0:
        print("\n✅ 정리할 파일이 없습니다.")
        return

    # 확인
    if yes_mode:
        choice = "y"
    else:
        try:
            choice = input(f"\n{total_files}개 파일 ({human_readable_size(total_size)})을 삭제할까요? [y/N]: ").strip().lower()
        except EOFError:
            choice = "n"

    if choice not in ["y", "yes"]:
        print("\n⏭️  건너뛰었습니다.")
        return

    # 실제 삭제
    print("\n🗑️ 파일 삭제 중...")
    results = []
    for folder in folders:
        result = cleanup_folder(folder, dry_run=False)
        results.append(result)

    print_summary(results, dry_run=False)

    total_freed = sum(r.get("freed_size", 0) for r in results)
    print(f"\n✅ {human_readable_size(total_freed)} 확보 완료!")

    # Slack 알림
    if slack_mode and total_freed > 0:
        print("\n📤 Slack 알림 전송 중...")
        if send_slack_notification(results):
            print("✅ Slack 알림 전송 완료!")
        else:
            print("❌ Slack 알림 전송 실패")


if __name__ == "__main__":
    main()
