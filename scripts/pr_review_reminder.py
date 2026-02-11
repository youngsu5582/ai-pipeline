#!/usr/bin/env python3
"""
AI Pipeline - PR Review Reminder
=================================
GitHub에서 리뷰 대기 중인 PR 목록을 조회하여 Slack으로 알림

두 가지 카테고리:
  1. 리뷰 대기: 리뷰 요청받았으나 아직 리뷰 시작 안 한 PR
  2. 승인 대기: 코멘트/변경요청은 남겼지만 아직 Approve 하지 않은 PR

Usage:
    python pr_review_reminder.py                              # 모든 저장소
    python pr_review_reminder.py --repo owner/repo            # 특정 저장소 (단일)
    python pr_review_reminder.py --repos "owner/r1,owner/r2"  # 여러 저장소
    python pr_review_reminder.py --slack                      # Slack 알림

Options:
    --repo REPO           단일 저장소 (owner/repo)
    --repos REPO,...      쉼표로 구분된 저장소 목록
    --slack               Slack 알림 전송

Requirements:
    - gh CLI 설치 및 인증 필요 (gh auth login)
"""

import json
import os
import subprocess
import sys
import urllib.request
from datetime import datetime
from typing import Optional


def run_gh_command(args: list[str], silent: bool = False) -> Optional[str]:
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
        if e.stderr and not silent:
            print(f"⚠️  gh 명령 실패: {e.stderr.strip()}")
        return None
    except FileNotFoundError:
        print("❌ gh CLI가 설치되어 있지 않습니다.")
        print("   brew install gh && gh auth login")
        sys.exit(1)


def _extract_repo_from_url(url: str) -> str:
    """PR URL에서 owner/repo 추출 (예: https://github.com/owner/repo/pull/123)"""
    if "github.com/" in url:
        parts = url.split("github.com/")[1].split("/")
        if len(parts) >= 2:
            return f"{parts[0]}/{parts[1]}"
    return ""


def _parse_pr_data(data: list[dict], repo: str = "") -> list[dict]:
    """gh pr list JSON 결과를 공통 포맷으로 파싱"""
    prs = []
    for pr in data:
        if pr.get("isDraft"):
            continue

        created_at = pr.get("createdAt", "")
        days_old = 0
        if created_at:
            try:
                created = datetime.fromisoformat(created_at.replace("Z", "+00:00"))
                days_old = (datetime.now(created.tzinfo) - created).days
            except (ValueError, TypeError):
                pass

        prs.append({
            "number": pr.get("number"),
            "title": pr.get("title", ""),
            "author": pr.get("author", {}).get("login", "unknown"),
            "created_at": created_at[:10] if created_at else "",
            "days_old": days_old,
            "url": pr.get("url", ""),
            "repo": _extract_repo_from_url(pr.get("url", "")) or repo or "",
            "branch": pr.get("headRefName", ""),
        })
    return prs


def get_current_username() -> str:
    """현재 gh CLI 인증 사용자명 조회"""
    result = run_gh_command(["api", "user", "--jq", ".login"], silent=True)
    return result or ""


def get_review_requested_prs(repo: Optional[str] = None) -> list[dict]:
    """리뷰 요청받은 PR 목록 조회 (아직 리뷰 시작 안 한 것)"""
    cmd = ["pr", "list", "--search", "review-requested:@me", "--json",
           "number,title,author,createdAt,url,headRefName,isDraft"]

    if repo:
        cmd.extend(["--repo", repo])

    result = run_gh_command(cmd)
    if not result:
        return []

    try:
        return _parse_pr_data(json.loads(result), repo)
    except json.JSONDecodeError:
        return []


def get_commented_not_approved_prs(
    repo: Optional[str] = None,
    username: str = "",
    exclude_numbers: Optional[set] = None,
) -> list[dict]:
    """코멘트/변경요청은 남겼지만 아직 Approve 하지 않은 PR"""
    if not username:
        return []

    exclude = exclude_numbers or set()

    cmd = ["pr", "list",
           "--search", f"reviewed-by:{username} state:open -author:{username}",
           "--json", "number,title,author,createdAt,url,headRefName,isDraft"]

    if repo:
        cmd.extend(["--repo", repo])

    result = run_gh_command(cmd)
    if not result:
        return []

    try:
        candidates = _parse_pr_data(json.loads(result), repo)
    except json.JSONDecodeError:
        return []

    # 리뷰 대기 목록과 중복 제거
    candidates = [pr for pr in candidates if pr["number"] not in exclude]
    if not candidates:
        return []

    # 각 PR에서 내 최신 리뷰 상태 확인 → APPROVED가 아닌 것만
    result_prs = []
    for pr in candidates:
        owner_repo = pr["repo"]
        state = run_gh_command([
            "api", f"repos/{owner_repo}/pulls/{pr['number']}/reviews",
            "--jq", f'[.[] | select(.user.login == "{username}")] | last | .state'
        ], silent=True)
        if state and state != "APPROVED":
            result_prs.append(pr)

    return result_prs


def _format_pr_lines_slack(prs: list[dict], max_count: int = 15) -> list[str]:
    """Slack mrkdwn 형식의 PR 한 줄 목록 생성"""
    lines = []
    for pr in prs[:max_count]:
        urgency = ""
        if pr["days_old"] >= 7:
            urgency = ":red_circle: "
        elif pr["days_old"] >= 3:
            urgency = ":large_yellow_circle: "

        repo_short = pr["repo"].split("/")[-1] if "/" in pr["repo"] else pr["repo"]
        lines.append(
            f"{urgency}<{pr['url']}|{pr['title']}> - "
            f"{pr['days_old']}일 전, {pr['author']} (`{repo_short}`)"
        )

    if len(prs) > max_count:
        lines.append(f"_...외 {len(prs) - max_count}개_")

    return lines


def send_slack_notification(
    requested_prs: list[dict],
    pending_approval_prs: list[dict],
) -> bool:
    """Slack으로 알림 전송"""
    webhook_url = os.environ.get("SLACK_WEBHOOK_URL")

    if not webhook_url:
        print("⚠️  SLACK_WEBHOOK_URL 환경변수가 설정되지 않았습니다.")
        return False

    total = len(requested_prs) + len(pending_approval_prs)
    if total == 0:
        return True

    blocks = [
        {
            "type": "header",
            "text": {
                "type": "plain_text",
                "text": f"👀 PR Review Reminder ({total}개)",
                "emoji": True
            }
        },
    ]

    # 카테고리 1: 리뷰 대기
    if requested_prs:
        lines = _format_pr_lines_slack(requested_prs)
        blocks.append({
            "type": "section",
            "text": {
                "type": "mrkdwn",
                "text": f"*📬 리뷰 대기* ({len(requested_prs)}개)\n" + "\n".join(lines)
            }
        })

    # 카테고리 2: 승인 대기
    if pending_approval_prs:
        lines = _format_pr_lines_slack(pending_approval_prs)
        blocks.append({
            "type": "section",
            "text": {
                "type": "mrkdwn",
                "text": f"*✏️ 승인 대기* ({len(pending_approval_prs)}개)\n" + "\n".join(lines)
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


def _print_pr_list(prs: list[dict]):
    """PR 목록 콘솔 출력"""
    for pr in prs:
        urgency = ""
        if pr["days_old"] >= 7:
            urgency = "🔴 "
        elif pr["days_old"] >= 3:
            urgency = "🟡 "

        print(f"  {urgency}#{pr['number']} {pr['title']}")
        print(f"     {pr['repo']} | {pr['author']} | {pr['created_at']} ({pr['days_old']}일 전)")
        print(f"     {pr['url']}")
        print("")


def print_summary(requested_prs: list[dict], pending_approval_prs: list[dict]):
    """콘솔에 요약 출력"""
    total = len(requested_prs) + len(pending_approval_prs)

    print("\n" + "━" * 50)
    print(f"👀 PR Review Summary ({total}개)")
    print("━" * 50)

    if total == 0:
        print("✅ 리뷰할 PR이 없습니다.")
        return

    if requested_prs:
        print(f"\n📬 리뷰 대기 ({len(requested_prs)}개)")
        print("   아직 리뷰를 시작하지 않은 PR\n")
        _print_pr_list(requested_prs)

    if pending_approval_prs:
        print(f"✏️  승인 대기 ({len(pending_approval_prs)}개)")
        print("   코멘트는 남겼지만 Approve 하지 않은 PR\n")
        _print_pr_list(pending_approval_prs)

    print("━" * 50)


def main():
    # 옵션 파싱
    args = sys.argv[1:]

    repos = []
    slack_mode = False

    i = 0
    while i < len(args):
        arg = args[i]
        if arg == "--repo" and i + 1 < len(args):
            repos.append(args[i + 1])
            i += 2
        elif arg == "--repos" and i + 1 < len(args):
            repo_list = [r.strip() for r in args[i + 1].split(",") if r.strip()]
            repos.extend(repo_list)
            i += 2
        elif arg == "--slack":
            slack_mode = True
            i += 1
        else:
            i += 1

    print("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")
    print("👀 PR Review Reminder")
    print("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")

    if repos:
        print(f"   대상 저장소: {', '.join(repos)}")
    else:
        print("   대상 저장소: 전체")
    print("")

    # 현재 사용자 조회
    username = get_current_username()
    if username:
        print(f"👤 사용자: {username}")

    # 1) 리뷰 대기 PR 조회
    print("📡 리뷰 대기 PR 조회 중...")
    all_requested = []
    if repos:
        for repo in repos:
            all_requested.extend(get_review_requested_prs(repo))
    else:
        all_requested = get_review_requested_prs()
    all_requested.sort(key=lambda x: x.get("created_at", ""))

    # 2) 승인 대기 PR 조회
    requested_numbers = {pr["number"] for pr in all_requested}
    all_pending_approval = []

    if username:
        print("📡 승인 대기 PR 조회 중...")
        if repos:
            for repo in repos:
                all_pending_approval.extend(
                    get_commented_not_approved_prs(repo, username, requested_numbers)
                )
        else:
            all_pending_approval = get_commented_not_approved_prs(
                username=username, exclude_numbers=requested_numbers
            )
        all_pending_approval.sort(key=lambda x: x.get("created_at", ""))

    # 콘솔 출력
    print_summary(all_requested, all_pending_approval)

    # Slack 알림
    total = len(all_requested) + len(all_pending_approval)
    if slack_mode:
        if total > 0:
            print("\n📤 Slack 알림 전송 중...")
            if send_slack_notification(all_requested, all_pending_approval):
                print("✅ Slack 알림 전송 완료!")
            else:
                print("❌ Slack 알림 전송 실패")
        else:
            print("\n✅ 리뷰할 PR 없음 - Slack 알림 생략")


if __name__ == "__main__":
    main()
