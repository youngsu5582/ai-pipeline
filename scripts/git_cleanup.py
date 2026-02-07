#!/usr/bin/env python3
"""
AI Pipeline - Git Branch Cleanup
=================================
머지된 로컬 브랜치를 정리하는 스크립트

Usage:
    python git_cleanup.py                              # 설정 파일 저장소
    python git_cleanup.py --repo /path/to/repo         # 특정 저장소 (단일)
    python git_cleanup.py --repos "/path1,/path2"      # 여러 저장소
    python git_cleanup.py --dry-run                    # 미리보기만
    python git_cleanup.py --yes                        # 확인 없이 삭제

Options:
    --repo PATH         단일 저장소 경로
    --repos PATH,...    쉼표로 구분된 저장소 경로 목록
    --dry-run           실제 삭제 없이 미리보기
    --yes               확인 없이 삭제
    --slack             Slack 알림 전송

Requirements:
    - git 설치
    - config/settings.yaml에 sync.github.repos 설정 (--repo/--repos 미지정 시)
"""

import json
import os
import subprocess
import sys
import urllib.request
from datetime import datetime
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


def get_repos() -> list[str]:
    """저장소 목록 조회"""
    sync_config = CONFIG.get("sync", {})
    github_config = sync_config.get("github", {})
    return github_config.get("repos", [])


def run_git(repo_path: str, args: list[str]) -> Optional[str]:
    """git 명령 실행"""
    try:
        result = subprocess.run(
            ["git", "-C", repo_path] + args,
            capture_output=True,
            text=True,
            check=True,
        )
        return result.stdout.strip()
    except subprocess.CalledProcessError as e:
        return None
    except FileNotFoundError:
        print("❌ git이 설치되어 있지 않습니다.")
        sys.exit(1)


def get_current_branch(repo_path: str) -> str:
    """현재 브랜치 조회"""
    result = run_git(repo_path, ["branch", "--show-current"])
    return result or "main"


def get_default_branch(repo_path: str) -> str:
    """기본 브랜치 조회 (main 또는 master)"""
    # origin/HEAD 확인
    result = run_git(repo_path, ["symbolic-ref", "refs/remotes/origin/HEAD", "--short"])
    if result:
        return result.replace("origin/", "")

    # main, master 순으로 확인
    for branch in ["main", "master", "develop"]:
        result = run_git(repo_path, ["rev-parse", "--verify", f"refs/heads/{branch}"])
        if result:
            return branch

    return "main"


def get_merged_branches(repo_path: str, default_branch: str) -> list[str]:
    """머지된 브랜치 목록 조회"""
    # 먼저 fetch
    run_git(repo_path, ["fetch", "--prune"])

    # 머지된 브랜치 조회
    result = run_git(repo_path, ["branch", "--merged", default_branch])
    if not result:
        return []

    branches = []
    protected = {"main", "master", "develop", "staging", "production"}

    for line in result.split("\n"):
        branch = line.strip().lstrip("* ")
        if not branch:
            continue
        if branch in protected:
            continue
        if branch.startswith("remotes/"):
            continue
        branches.append(branch)

    return branches


def get_stale_branches(repo_path: str, days: int = 30) -> list[dict]:
    """오래된 브랜치 목록 (마지막 커밋 기준)"""
    result = run_git(repo_path, [
        "for-each-ref",
        "--sort=-committerdate",
        "--format=%(refname:short)|%(committerdate:iso)",
        "refs/heads/"
    ])

    if not result:
        return []

    stale = []
    cutoff = datetime.now().timestamp() - (days * 24 * 60 * 60)
    protected = {"main", "master", "develop", "staging", "production"}

    for line in result.split("\n"):
        if "|" not in line:
            continue
        branch, date_str = line.split("|", 1)

        if branch in protected:
            continue

        try:
            # ISO format 파싱
            commit_date = datetime.fromisoformat(date_str.strip().replace(" ", "T").split("+")[0])
            if commit_date.timestamp() < cutoff:
                days_old = int((datetime.now() - commit_date).days)
                stale.append({
                    "branch": branch,
                    "last_commit": commit_date.strftime("%Y-%m-%d"),
                    "days_old": days_old,
                })
        except (ValueError, TypeError):
            pass

    return stale


def delete_branch(repo_path: str, branch: str) -> bool:
    """브랜치 삭제"""
    result = run_git(repo_path, ["branch", "-d", branch])
    return result is not None


def force_delete_branch(repo_path: str, branch: str) -> bool:
    """브랜치 강제 삭제"""
    result = run_git(repo_path, ["branch", "-D", branch])
    return result is not None


def cleanup_repo(repo_path: str, dry_run: bool = False, force: bool = False) -> dict:
    """단일 저장소 정리"""
    repo = Path(repo_path).expanduser()

    if not (repo / ".git").exists():
        return {"repo": str(repo), "error": "git 저장소가 아닙니다"}

    repo_name = repo.name
    current = get_current_branch(str(repo))
    default = get_default_branch(str(repo))

    # 머지된 브랜치 조회
    merged = get_merged_branches(str(repo), default)

    # 현재 브랜치는 제외
    if current in merged:
        merged.remove(current)

    # 오래된 브랜치 조회
    stale = get_stale_branches(str(repo))

    result = {
        "repo": repo_name,
        "path": str(repo),
        "current_branch": current,
        "default_branch": default,
        "merged_branches": merged,
        "stale_branches": stale,
        "deleted": [],
        "failed": [],
    }

    if dry_run:
        return result

    # 머지된 브랜치 삭제
    for branch in merged:
        if delete_branch(str(repo), branch):
            result["deleted"].append(branch)
        else:
            result["failed"].append(branch)

    return result


def send_slack_notification(results: list[dict]) -> bool:
    """Slack으로 알림 전송"""
    webhook_url = os.environ.get("SLACK_WEBHOOK_URL")

    if not webhook_url:
        print("⚠️  SLACK_WEBHOOK_URL 환경변수가 설정되지 않았습니다.")
        return False

    total_deleted = sum(len(r.get("deleted", [])) for r in results)

    if total_deleted == 0:
        return True

    blocks = [
        {
            "type": "header",
            "text": {
                "type": "plain_text",
                "text": f"🧹 Git 브랜치 정리 ({total_deleted}개 삭제)",
                "emoji": True
            }
        },
        {"type": "divider"},
    ]

    for result in results:
        deleted = result.get("deleted", [])
        if deleted:
            blocks.append({
                "type": "section",
                "text": {
                    "type": "mrkdwn",
                    "text": f"*{result['repo']}*\n삭제: {', '.join(deleted)}"
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
    print("🧹 Git 브랜치 정리 결과" + (" (미리보기)" if dry_run else ""))
    print("━" * 50)

    for result in results:
        if "error" in result:
            print(f"\n❌ {result['repo']}: {result['error']}")
            continue

        print(f"\n📁 {result['repo']}")
        print(f"   현재: {result['current_branch']} | 기본: {result['default_branch']}")

        merged = result.get("merged_branches", [])
        stale = result.get("stale_branches", [])
        deleted = result.get("deleted", [])

        if merged:
            print(f"\n   머지된 브랜치 ({len(merged)}개):")
            for branch in merged:
                status = "✅ 삭제됨" if branch in deleted else ("🗑️ 삭제 예정" if dry_run else "")
                print(f"     - {branch} {status}")

        if stale:
            print(f"\n   오래된 브랜치 ({len(stale)}개):")
            for item in stale[:5]:
                print(f"     - {item['branch']} ({item['days_old']}일 전)")
            if len(stale) > 5:
                print(f"     ...외 {len(stale) - 5}개")

        if not merged and not stale:
            print("   ✨ 정리할 브랜치가 없습니다.")

    print("\n" + "━" * 50)


def main():
    # 옵션 파싱
    args = sys.argv[1:]

    repos = []
    dry_run = False
    yes_mode = False
    slack_mode = False

    i = 0
    while i < len(args):
        arg = args[i]
        if arg == "--repo" and i + 1 < len(args):
            # 단일 저장소
            repos.append(args[i + 1])
            i += 2
        elif arg == "--repos" and i + 1 < len(args):
            # 쉼표로 구분된 여러 저장소
            repo_list = [r.strip() for r in args[i + 1].split(",") if r.strip()]
            repos.extend(repo_list)
            i += 2
        elif arg == "--dry-run":
            dry_run = True
            i += 1
        elif arg in ("--yes", "-y"):
            yes_mode = True
            i += 1
        elif arg == "--slack":
            slack_mode = True
            i += 1
        else:
            i += 1

    # 저장소 목록
    if not repos:
        repos = get_repos()

    if not repos:
        print("⚠️  정리할 저장소가 없습니다.")
        print("   --repo /path/to/repo 옵션을 사용하거나")
        print("   config/settings.yaml의 sync.github.repos를 설정하세요.")
        return

    print("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")
    print("🧹 Git Branch Cleanup")
    print("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")
    print(f"   대상 저장소: {len(repos)}개")
    if dry_run:
        print("   모드: 미리보기 (삭제 안 함)")
    print("")

    # 먼저 미리보기
    print("📡 브랜치 분석 중...")
    results = []
    for repo in repos:
        result = cleanup_repo(repo, dry_run=True)
        results.append(result)

    print_summary(results, dry_run=True)

    # dry-run이면 여기서 종료
    if dry_run:
        return

    # 삭제할 브랜치가 있는지 확인
    total_to_delete = sum(len(r.get("merged_branches", [])) for r in results)
    if total_to_delete == 0:
        print("\n✅ 정리할 브랜치가 없습니다.")
        return

    # 확인
    if yes_mode:
        choice = "y"
    else:
        try:
            choice = input(f"\n{total_to_delete}개 브랜치를 삭제할까요? [y/N]: ").strip().lower()
        except EOFError:
            choice = "n"

    if choice not in ["y", "yes"]:
        print("\n⏭️  건너뛰었습니다.")
        return

    # 실제 삭제
    print("\n🗑️ 브랜치 삭제 중...")
    results = []
    for repo in repos:
        result = cleanup_repo(repo, dry_run=False)
        results.append(result)

    print_summary(results, dry_run=False)

    total_deleted = sum(len(r.get("deleted", [])) for r in results)
    print(f"\n✅ 총 {total_deleted}개 브랜치 삭제 완료!")

    # Slack 알림
    if slack_mode and total_deleted > 0:
        print("\n📤 Slack 알림 전송 중...")
        if send_slack_notification(results):
            print("✅ Slack 알림 전송 완료!")
        else:
            print("❌ Slack 알림 전송 실패")


if __name__ == "__main__":
    main()
