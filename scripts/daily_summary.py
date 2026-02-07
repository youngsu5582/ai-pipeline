#!/usr/bin/env python3
"""
AI Pipeline - Daily Summary Notification
==========================================
하루 동안의 Cron 작업 실행 결과를 요약하여 Slack으로 전송

Usage:
    python daily_summary.py                 # 오늘 요약
    python daily_summary.py --date 2026-01-30   # 특정 날짜
    python daily_summary.py --slack         # Slack 전송

Options:
    --date DATE    요약할 날짜 (YYYY-MM-DD, 기본: 오늘)
    --slack        Slack 알림 전송 (필수)

Requirements:
    - SLACK_WEBHOOK_URL 환경변수
"""

import json
import os
import sys
import urllib.request
from datetime import datetime
from pathlib import Path


HISTORY_FILE = Path(__file__).parent.parent / "dashboard" / "logs" / "history.json"


def load_history() -> list[dict]:
    """실행 이력 로드"""
    if not HISTORY_FILE.exists():
        return []

    try:
        with open(HISTORY_FILE, "r", encoding="utf-8") as f:
            return json.load(f)
    except (json.JSONDecodeError, IOError):
        return []


def filter_by_date(history: list[dict], target_date: str) -> list[dict]:
    """특정 날짜의 이력만 필터링"""
    filtered = []
    for entry in history:
        start_time = entry.get("startTime", "")
        if start_time and start_time.startswith(target_date):
            filtered.append(entry)
    return filtered


def build_summary(entries: list[dict], target_date: str) -> dict:
    """일간 요약 생성"""
    total = len(entries)
    success = sum(1 for e in entries if e.get("status") == "success")
    failed = sum(1 for e in entries if e.get("status") == "failed")

    # 작업별 통계
    job_stats = {}
    for entry in entries:
        job_name = entry.get("jobName", "Unknown")
        if job_name not in job_stats:
            job_stats[job_name] = {"success": 0, "failed": 0, "total": 0}
        job_stats[job_name]["total"] += 1
        if entry.get("status") == "success":
            job_stats[job_name]["success"] += 1
        elif entry.get("status") == "failed":
            job_stats[job_name]["failed"] += 1

    # 실패한 작업 목록
    failed_jobs = [
        {
            "jobName": e.get("jobName"),
            "error": e.get("error", ""),
            "time": e.get("startTime", "")[:19]
        }
        for e in entries if e.get("status") == "failed"
    ]

    # 총 실행 시간
    total_duration = sum(e.get("duration", 0) for e in entries)

    return {
        "date": target_date,
        "total": total,
        "success": success,
        "failed": failed,
        "success_rate": round((success / total * 100) if total > 0 else 0),
        "job_stats": job_stats,
        "failed_jobs": failed_jobs,
        "total_duration": total_duration,
        "total_duration_formatted": f"{total_duration / 1000 / 60:.1f}분"
    }


def send_slack_notification(summary: dict) -> bool:
    """Slack으로 일간 요약 전송"""
    webhook_url = os.environ.get("SLACK_WEBHOOK_URL")

    if not webhook_url:
        print("⚠️  SLACK_WEBHOOK_URL 환경변수가 설정되지 않았습니다.")
        return False

    # 성공률에 따른 이모지
    rate = summary["success_rate"]
    if rate >= 90:
        emoji = "✅"
        color = "#22c55e"
    elif rate >= 70:
        emoji = "⚠️"
        color = "#eab308"
    else:
        emoji = "❌"
        color = "#ef4444"

    blocks = [
        {
            "type": "header",
            "text": {
                "type": "plain_text",
                "text": f"📊 일간 작업 요약 - {summary['date']}",
                "emoji": True
            }
        },
        {
            "type": "section",
            "fields": [
                {
                    "type": "mrkdwn",
                    "text": f"*총 실행*\n{summary['total']}회"
                },
                {
                    "type": "mrkdwn",
                    "text": f"*성공률*\n{emoji} {summary['success_rate']}%"
                },
                {
                    "type": "mrkdwn",
                    "text": f"*성공*\n{summary['success']}회"
                },
                {
                    "type": "mrkdwn",
                    "text": f"*실패*\n{summary['failed']}회"
                }
            ]
        }
    ]

    # 실패한 작업이 있으면 표시
    if summary["failed_jobs"]:
        blocks.append({"type": "divider"})
        failed_list = "\n".join([
            f"• {f['jobName']} ({f['time'][-8:]})"
            for f in summary["failed_jobs"][:5]
        ])
        if len(summary["failed_jobs"]) > 5:
            failed_list += f"\n_...외 {len(summary['failed_jobs']) - 5}개_"

        blocks.append({
            "type": "section",
            "text": {
                "type": "mrkdwn",
                "text": f"*실패한 작업*\n{failed_list}"
            }
        })

    # 작업별 요약 (상위 5개)
    if summary["job_stats"]:
        blocks.append({"type": "divider"})
        sorted_jobs = sorted(
            summary["job_stats"].items(),
            key=lambda x: x[1]["total"],
            reverse=True
        )[:5]

        job_summary = "\n".join([
            f"• {name}: {stats['success']}/{stats['total']}"
            for name, stats in sorted_jobs
        ])

        blocks.append({
            "type": "section",
            "text": {
                "type": "mrkdwn",
                "text": f"*작업별 실행 (성공/전체)*\n{job_summary}"
            }
        })

    # 총 실행 시간
    blocks.append({
        "type": "context",
        "elements": [{
            "type": "mrkdwn",
            "text": f"총 실행 시간: {summary['total_duration_formatted']}"
        }]
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


def print_summary(summary: dict):
    """콘솔에 요약 출력"""
    print("\n" + "━" * 50)
    print(f"📊 일간 작업 요약: {summary['date']}")
    print("━" * 50)

    if summary["total"] == 0:
        print("실행된 작업이 없습니다.")
        return

    print(f"총 실행: {summary['total']}회")
    print(f"성공: {summary['success']}회 ({summary['success_rate']}%)")
    print(f"실패: {summary['failed']}회")
    print(f"총 실행 시간: {summary['total_duration_formatted']}")

    if summary["failed_jobs"]:
        print("\n실패한 작업:")
        for job in summary["failed_jobs"][:5]:
            print(f"  - {job['jobName']} ({job['time'][-8:]})")

    print("\n작업별 실행:")
    for name, stats in sorted(summary["job_stats"].items(), key=lambda x: x[1]["total"], reverse=True)[:10]:
        rate = round(stats["success"] / stats["total"] * 100) if stats["total"] > 0 else 0
        print(f"  - {name}: {stats['success']}/{stats['total']} ({rate}%)")

    print("━" * 50)


def main():
    # 옵션 파싱
    args = sys.argv[1:]

    target_date = datetime.now().strftime("%Y-%m-%d")
    slack_mode = False

    i = 0
    while i < len(args):
        arg = args[i]
        if arg == "--date" and i + 1 < len(args):
            target_date = args[i + 1]
            i += 2
        elif arg == "--slack":
            slack_mode = True
            i += 1
        else:
            i += 1

    print("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")
    print(f"📊 Daily Summary: {target_date}")
    print("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")

    # 이력 로드
    history = load_history()
    print(f"   전체 이력: {len(history)}건")

    # 날짜 필터링
    entries = filter_by_date(history, target_date)
    print(f"   {target_date} 이력: {len(entries)}건")

    # 요약 생성
    summary = build_summary(entries, target_date)

    # 콘솔 출력
    print_summary(summary)

    # Slack 전송
    if slack_mode:
        if summary["total"] == 0:
            print("\n✅ 실행된 작업이 없어 Slack 알림을 생략합니다.")
        else:
            print("\n📤 Slack 알림 전송 중...")
            if send_slack_notification(summary):
                print("✅ Slack 알림 전송 완료!")
            else:
                print("❌ Slack 알림 전송 실패")


if __name__ == "__main__":
    main()
