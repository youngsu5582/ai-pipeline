#!/usr/bin/env python3
"""
AI Pipeline - My PR Status
===========================
내가 올린 PR 상태를 조회하여 Daily Note에 기록

Usage:
    python my_pr_status.py                              # 모든 저장소
    python my_pr_status.py --repo owner/repo            # 특정 저장소 (단일)
    python my_pr_status.py --repos "owner/r1,owner/r2"  # 여러 저장소
    python my_pr_status.py --state open                 # 특정 상태만 (open/merged/closed/all)
    python my_pr_status.py --yes                        # Daily Note에 자동 추가

Options:
    --repo REPO          단일 저장소 (owner/repo)
    --repos REPO,...     쉼표로 구분된 저장소 목록
    --state STATE        PR 상태 필터 (open/merged/closed/all, 기본: all)
    --yes                확인 없이 Daily Note에 추가
    --slack              Slack 알림 전송

Requirements:
    - gh CLI 설치 및 인증 필요 (gh auth login)
    - config/settings.yaml에 vault 설정
"""

import json
import os
import re
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


def run_gh_command(args: list[str]) -> Optional[str]:
    """gh CLI 명령 실행"""
    try:
        result = subprocess.run(
            ["gh"] + args,
            capture_output=True,
            text=True,
            check=True,
        )
        return result.stdout.strip()
    except subprocess.CalledProcessError as e:
        if e.stderr:
            print(f"⚠️  gh 명령 실패: {e.stderr.strip()}")
        return None
    except FileNotFoundError:
        print("❌ gh CLI가 설치되어 있지 않습니다.")
        print("   brew install gh && gh auth login")
        sys.exit(1)


def get_my_prs(repo: Optional[str] = None, state: str = "all") -> list[dict]:
    """내가 올린 PR 목록 조회"""
    prs = []

    cmd = ["pr", "list", "--author", "@me", "--state", state, "--json",
           "number,title,state,createdAt,mergedAt,closedAt,url,repository,headRefName,reviewDecision,isDraft"]

    if repo:
        cmd.extend(["--repo", repo])

    result = run_gh_command(cmd)
    if not result:
        return []

    try:
        data = json.loads(result)
        for pr in data:
            state = pr.get("state", "OPEN")
            review_decision = pr.get("reviewDecision", "")

            # 상태 이모지
            if state == "MERGED":
                status_emoji = "🔀"
                status_text = "Merged"
            elif state == "CLOSED":
                status_emoji = "❌"
                status_text = "Closed"
            elif pr.get("isDraft"):
                status_emoji = "📝"
                status_text = "Draft"
            elif review_decision == "APPROVED":
                status_emoji = "✅"
                status_text = "Approved"
            elif review_decision == "CHANGES_REQUESTED":
                status_emoji = "🔄"
                status_text = "Changes Requested"
            elif review_decision == "REVIEW_REQUIRED":
                status_emoji = "👀"
                status_text = "Review Required"
            else:
                status_emoji = "🟡"
                status_text = "Open"

            prs.append({
                "number": pr.get("number"),
                "title": pr.get("title", ""),
                "state": state,
                "status_emoji": status_emoji,
                "status_text": status_text,
                "created_at": pr.get("createdAt", "")[:10],
                "merged_at": pr.get("mergedAt", "")[:10] if pr.get("mergedAt") else "",
                "url": pr.get("url", ""),
                "repo": pr.get("repository", {}).get("nameWithOwner", repo or ""),
                "branch": pr.get("headRefName", ""),
            })
    except json.JSONDecodeError:
        pass

    return prs


def build_pr_section(prs: list[dict]) -> str:
    """PR 상태 섹션 생성"""
    lines = ["\n## 📋 PR 현황"]

    if not prs:
        lines.append("\n_등록된 PR이 없습니다._")
        lines.append("")
        return "\n".join(lines)

    # 상태별 분류
    open_prs = [pr for pr in prs if pr["state"] == "OPEN"]
    merged_prs = [pr for pr in prs if pr["state"] == "MERGED"]
    closed_prs = [pr for pr in prs if pr["state"] == "CLOSED"]

    # Open PRs
    if open_prs:
        lines.append("\n### Open")
        for pr in open_prs:
            lines.append(
                f"- {pr['status_emoji']} [{pr['repo']}#{pr['number']}]({pr['url']}) {pr['title']}"
            )
            lines.append(f"  - 상태: `{pr['status_text']}` | 브랜치: `{pr['branch']}`")

    # Merged PRs (오늘 머지된 것만)
    today = datetime.now().strftime("%Y-%m-%d")
    today_merged = [pr for pr in merged_prs if pr.get("merged_at") == today]
    if today_merged:
        lines.append("\n### 오늘 Merged")
        for pr in today_merged:
            lines.append(
                f"- {pr['status_emoji']} [{pr['repo']}#{pr['number']}]({pr['url']}) {pr['title']}"
            )

    # 요약
    lines.append("\n### 요약")
    lines.append(f"- Open: {len(open_prs)}개")
    lines.append(f"- 오늘 Merged: {len(today_merged)}개")

    lines.append("")
    return "\n".join(lines)


def get_daily_note_path(target_date: str) -> Path:
    """Daily Note 경로"""
    vault_path = Path(CONFIG["vault"]["path"]).expanduser()
    daily_folder = CONFIG["vault"].get("daily_folder", "DAILY")
    return vault_path / daily_folder / f"{target_date}.md"


def update_daily_note(target_date: str, pr_section: str) -> str:
    """Daily Note에 PR 섹션 추가"""
    daily_path = get_daily_note_path(target_date)

    if not daily_path.exists():
        print(f"⚠️  {target_date} Daily Note가 없습니다.")
        print("   먼저 daily.py --init 을 실행하세요.")
        return ""

    with open(daily_path, "r", encoding="utf-8") as f:
        content = f.read()

    # 기존 PR 섹션이 있으면 교체
    if "## 📋 PR 현황" in content:
        pattern = r"## 📋 PR 현황.*?(?=\n## |\Z)"
        content = re.sub(pattern, pr_section.strip(), content, flags=re.DOTALL)
    else:
        # GitHub 활동 섹션 뒤에 추가
        if "## 🐙 GitHub 활동" in content:
            pattern = r"(## 🐙 GitHub 활동.*?)(\n## )"
            content = re.sub(
                pattern,
                rf"\1{pr_section}\2",
                content,
                flags=re.DOTALL,
                count=1
            )
        elif "## ✅ 오늘 한 일" in content:
            content = content.replace(
                "## ✅ 오늘 한 일", f"{pr_section}\n## ✅ 오늘 한 일"
            )
        else:
            content = content.rstrip() + "\n" + pr_section

    with open(daily_path, "w", encoding="utf-8") as f:
        f.write(content)

    return str(daily_path)


def send_slack_notification(prs: list[dict]) -> bool:
    """Slack으로 알림 전송"""
    webhook_url = os.environ.get("SLACK_WEBHOOK_URL")

    if not webhook_url:
        print("⚠️  SLACK_WEBHOOK_URL 환경변수가 설정되지 않았습니다.")
        return False

    open_prs = [pr for pr in prs if pr["state"] == "OPEN"]

    if not open_prs:
        return True

    blocks = [
        {
            "type": "header",
            "text": {
                "type": "plain_text",
                "text": f"📋 내 PR 현황 ({len(open_prs)}개 Open)",
                "emoji": True
            }
        },
        {"type": "divider"},
    ]

    for pr in open_prs[:5]:
        blocks.append({
            "type": "section",
            "text": {
                "type": "mrkdwn",
                "text": (
                    f"{pr['status_emoji']} <{pr['url']}|#{pr['number']} {pr['title']}>\n"
                    f"• 저장소: `{pr['repo']}`\n"
                    f"• 상태: `{pr['status_text']}`"
                )
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


def print_summary(prs: list[dict]):
    """콘솔에 요약 출력"""
    print("\n" + "━" * 50)
    print("📋 내 PR 현황")
    print("━" * 50)

    if not prs:
        print("등록된 PR이 없습니다.")
        return

    open_prs = [pr for pr in prs if pr["state"] == "OPEN"]
    merged_prs = [pr for pr in prs if pr["state"] == "MERGED"]

    print(f"Open: {len(open_prs)}개 | Merged: {len(merged_prs)}개")
    print("")

    for pr in open_prs:
        print(f"{pr['status_emoji']} #{pr['number']} {pr['title']}")
        print(f"   저장소: {pr['repo']}")
        print(f"   상태: {pr['status_text']}")
        print(f"   URL: {pr['url']}")
        print("")

    print("━" * 50)


def main():
    # 옵션 파싱
    args = sys.argv[1:]

    repos = []
    yes_mode = False
    slack_mode = False
    state = "all"  # PR 상태 필터

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
        elif arg == "--state" and i + 1 < len(args):
            state = args[i + 1].lower()
            i += 2
        elif arg in ("--yes", "-y"):
            yes_mode = True
            i += 1
        elif arg == "--slack":
            slack_mode = True
            i += 1
        else:
            i += 1

    today = datetime.now().strftime("%Y-%m-%d")

    print("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")
    print(f"📋 My PR Status: {today}")
    print("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")

    if repos:
        print(f"   대상 저장소: {', '.join(repos)}")
    else:
        print("   대상 저장소: 전체")
    print(f"   상태 필터: {state}")
    print("")

    # PR 조회
    print("📡 PR 조회 중...")
    all_prs = []

    if repos:
        for repo in repos:
            prs = get_my_prs(repo, state=state)
            all_prs.extend(prs)
    else:
        all_prs = get_my_prs(state=state)

    # 콘솔 출력
    print_summary(all_prs)

    # PR 섹션 생성
    pr_section = build_pr_section(all_prs)

    # 미리보기
    print("\n📋 Daily Note 미리보기")
    print("━" * 40)
    print(pr_section)
    print("━" * 40)

    # Daily Note 업데이트
    if yes_mode:
        choice = "y"
    else:
        try:
            choice = input("\nDaily Note에 추가할까요? [Y/n]: ").strip().lower()
        except EOFError:
            choice = "y"

    if choice in ["", "y", "yes"]:
        result_path = update_daily_note(today, pr_section)
        if result_path:
            print(f"\n✅ Daily Note 업데이트 완료!")
            print(f"   {result_path}")
    else:
        print("\n⏭️  건너뛰었습니다.")

    # Slack 알림
    if slack_mode:
        print("\n📤 Slack 알림 전송 중...")
        if send_slack_notification(all_prs):
            print("✅ Slack 알림 전송 완료!")
        else:
            print("❌ Slack 알림 전송 실패")


if __name__ == "__main__":
    main()
