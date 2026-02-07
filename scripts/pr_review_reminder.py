#!/usr/bin/env python3
"""
AI Pipeline - PR Review Reminder
=================================
GitHub에서 리뷰 대기 중인 PR 목록을 조회하여 Slack으로 알림

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
        # stderr에 에러 메시지 있으면 출력
        if e.stderr:
            print(f"⚠️  gh 명령 실패: {e.stderr.strip()}")
        return None
    except FileNotFoundError:
        print("❌ gh CLI가 설치되어 있지 않습니다.")
        print("   brew install gh && gh auth login")
        sys.exit(1)


def get_review_requested_prs(repo: Optional[str] = None) -> list[dict]:
    """리뷰 요청받은 PR 목록 조회"""
    prs = []

    # gh CLI로 리뷰 요청받은 PR 조회
    cmd = ["pr", "list", "--search", "review-requested:@me", "--json",
           "number,title,author,createdAt,url,repository,headRefName,isDraft"]

    if repo:
        cmd.extend(["--repo", repo])

    result = run_gh_command(cmd)
    if not result:
        return []

    try:
        data = json.loads(result)
        for pr in data:
            if pr.get("isDraft"):
                continue  # 드래프트 PR 제외

            created_at = pr.get("createdAt", "")
            # 생성일로부터 경과 시간 계산
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
                "repo": pr.get("repository", {}).get("nameWithOwner", repo or ""),
                "branch": pr.get("headRefName", ""),
            })
    except json.JSONDecodeError:
        pass

    return prs


def send_slack_notification(prs: list[dict]) -> bool:
    """Slack으로 알림 전송"""
    webhook_url = os.environ.get("SLACK_WEBHOOK_URL")

    if not webhook_url:
        print("⚠️  SLACK_WEBHOOK_URL 환경변수가 설정되지 않았습니다.")
        return False

    if not prs:
        # 리뷰 대기 PR이 없으면 알림 안 보냄
        return True

    # 블록 구성
    blocks = [
        {
            "type": "header",
            "text": {
                "type": "plain_text",
                "text": f"👀 리뷰 대기 PR ({len(prs)}개)",
                "emoji": True
            }
        },
        {
            "type": "section",
            "text": {
                "type": "mrkdwn",
                "text": "아래 PR들이 리뷰를 기다리고 있습니다."
            }
        },
        {"type": "divider"},
    ]

    # PR 목록 (최대 10개)
    for pr in prs[:10]:
        # 오래된 PR 강조
        urgency = ""
        if pr["days_old"] >= 7:
            urgency = "🔴 "
        elif pr["days_old"] >= 3:
            urgency = "🟡 "

        blocks.append({
            "type": "section",
            "text": {
                "type": "mrkdwn",
                "text": (
                    f"{urgency}<{pr['url']}|#{pr['number']} {pr['title']}>\n"
                    f"• 저장소: `{pr['repo']}`\n"
                    f"• 작성자: {pr['author']}\n"
                    f"• 생성일: {pr['created_at']} ({pr['days_old']}일 전)"
                )
            }
        })

    if len(prs) > 10:
        blocks.append({
            "type": "context",
            "elements": [
                {
                    "type": "mrkdwn",
                    "text": f"_그 외 {len(prs) - 10}개 PR..._"
                }
            ]
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
    print("👀 리뷰 대기 PR 목록")
    print("━" * 50)

    if not prs:
        print("✅ 리뷰 대기 중인 PR이 없습니다.")
        return

    print(f"총 {len(prs)}개의 PR이 리뷰를 기다리고 있습니다.\n")

    for pr in prs:
        # 오래된 PR 강조
        urgency = ""
        if pr["days_old"] >= 7:
            urgency = "🔴 "
        elif pr["days_old"] >= 3:
            urgency = "🟡 "

        print(f"{urgency}#{pr['number']} {pr['title']}")
        print(f"   저장소: {pr['repo']}")
        print(f"   작성자: {pr['author']}")
        print(f"   생성일: {pr['created_at']} ({pr['days_old']}일 전)")
        print(f"   URL: {pr['url']}")
        print("")

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
            # 단일 저장소
            repos.append(args[i + 1])
            i += 2
        elif arg == "--repos" and i + 1 < len(args):
            # 쉼표로 구분된 여러 저장소
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

    # PR 조회
    print("📡 리뷰 대기 PR 조회 중...")
    all_prs = []

    if repos:
        for repo in repos:
            prs = get_review_requested_prs(repo)
            all_prs.extend(prs)
    else:
        all_prs = get_review_requested_prs()

    # 생성일 기준 정렬 (오래된 것 먼저)
    all_prs.sort(key=lambda x: x.get("created_at", ""), reverse=False)

    # 콘솔 출력
    print_summary(all_prs)

    # Slack 알림
    if slack_mode:
        if all_prs:
            print("\n📤 Slack 알림 전송 중...")
            if send_slack_notification(all_prs):
                print("✅ Slack 알림 전송 완료!")
            else:
                print("❌ Slack 알림 전송 실패")
        else:
            print("\n✅ 리뷰 대기 PR 없음 - Slack 알림 생략")


if __name__ == "__main__":
    main()
