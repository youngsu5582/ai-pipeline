#!/usr/bin/env python3
"""
AI Pipeline - Productivity Report
===================================
학습량, 커밋, PR, Claude 세션 등을 종합 분석하여 리포트 생성

Usage:
    python productivity_report.py                     # 주간 리포트 (기본)
    python productivity_report.py --period daily      # 일간 리포트
    python productivity_report.py --period weekly     # 주간 리포트
    python productivity_report.py --period monthly    # 월간 리포트
    python productivity_report.py --yes               # 자동 저장
    python productivity_report.py --slack             # Slack 알림

Options:
    --period TYPE     리포트 기간 (daily/weekly/monthly, 기본: weekly)
    --date DATE       기준 날짜 (YYYY-MM-DD, 기본: 오늘)
    --yes             확인 없이 저장
    --slack           Slack 알림 전송

Requirements:
    - git, gh CLI 설치
    - config/settings.yaml에 vault 설정
"""

import json
import os
import re
import subprocess
import sys
import urllib.request
from datetime import datetime, timedelta
from pathlib import Path
from typing import Optional

import yaml


CONFIG_PATH = Path(__file__).parent.parent / "config" / "settings.yaml"
CLAUDE_PROJECTS_PATH = Path.home() / ".claude" / "projects"


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


def get_date_range(period: str, base_date: datetime) -> tuple[datetime, datetime]:
    """기간에 따른 날짜 범위 계산"""
    if period == "daily":
        start = base_date.replace(hour=0, minute=0, second=0, microsecond=0)
        end = start + timedelta(days=1) - timedelta(seconds=1)
    elif period == "weekly":
        # 이번 주 월요일부터
        days_since_monday = base_date.weekday()
        start = (base_date - timedelta(days=days_since_monday)).replace(
            hour=0, minute=0, second=0, microsecond=0
        )
        end = start + timedelta(days=7) - timedelta(seconds=1)
    elif period == "monthly":
        start = base_date.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
        # 다음 달 1일 - 1초
        if base_date.month == 12:
            end = base_date.replace(year=base_date.year + 1, month=1, day=1) - timedelta(seconds=1)
        else:
            end = base_date.replace(month=base_date.month + 1, day=1) - timedelta(seconds=1)
    else:
        raise ValueError(f"Unknown period: {period}")

    return start, end


def count_daily_notes(start: datetime, end: datetime) -> dict:
    """Daily Note 통계 수집"""
    stats = {
        "total_notes": 0,
        "total_tils": 0,
        "total_tasks_done": 0,
        "learning_topics": [],
    }

    vault_path = Path(CONFIG.get("vault", {}).get("path", "")).expanduser()
    daily_folder = CONFIG.get("vault", {}).get("daily_folder", "DAILY")
    daily_path = vault_path / daily_folder

    if not daily_path.exists():
        return stats

    current = start
    while current <= end:
        date_str = current.strftime("%Y-%m-%d")
        note_path = daily_path / f"{date_str}.md"

        if note_path.exists():
            stats["total_notes"] += 1

            with open(note_path, "r", encoding="utf-8") as f:
                content = f.read()

            # TIL 카운트 (## 헤더 기준)
            til_matches = re.findall(r"##\s+(?:TIL|오늘 배운 것|학습)", content, re.IGNORECASE)
            stats["total_tils"] += len(til_matches)

            # 완료된 태스크 카운트
            done_tasks = re.findall(r"- \[x\]", content, re.IGNORECASE)
            stats["total_tasks_done"] += len(done_tasks)

            # 학습 토픽 추출 (태그)
            tags = re.findall(r"#([a-zA-Z가-힣]+)", content)
            stats["learning_topics"].extend(tags)

        current += timedelta(days=1)

    # 중복 토픽 제거 및 빈도 계산
    topic_counts = {}
    for topic in stats["learning_topics"]:
        topic_lower = topic.lower()
        topic_counts[topic_lower] = topic_counts.get(topic_lower, 0) + 1

    stats["learning_topics"] = sorted(
        topic_counts.items(), key=lambda x: x[1], reverse=True
    )[:10]

    return stats


def count_git_commits(start: datetime, end: datetime) -> dict:
    """Git 커밋 통계 수집"""
    stats = {
        "total_commits": 0,
        "repos": {},
        "files_changed": 0,
        "insertions": 0,
        "deletions": 0,
    }

    sync_config = CONFIG.get("sync", {})
    repos = sync_config.get("github", {}).get("repos", [])

    for repo_path in repos:
        repo = Path(repo_path).expanduser()
        if not (repo / ".git").exists():
            continue

        try:
            # 커밋 수
            result = subprocess.run(
                [
                    "git", "-C", str(repo), "log",
                    f"--since={start.isoformat()}",
                    f"--until={end.isoformat()}",
                    "--oneline"
                ],
                capture_output=True, text=True, check=True
            )
            commits = [l for l in result.stdout.strip().split("\n") if l]
            commit_count = len(commits)

            if commit_count > 0:
                stats["repos"][repo.name] = commit_count
                stats["total_commits"] += commit_count

                # 변경 통계
                stat_result = subprocess.run(
                    [
                        "git", "-C", str(repo), "diff",
                        f"--stat", "--shortstat",
                        f"HEAD~{min(commit_count, 100)}..HEAD"
                    ],
                    capture_output=True, text=True
                )

                # "10 files changed, 100 insertions(+), 50 deletions(-)" 파싱
                stat_line = stat_result.stdout.strip().split("\n")[-1]
                files_match = re.search(r"(\d+) files? changed", stat_line)
                ins_match = re.search(r"(\d+) insertions?", stat_line)
                del_match = re.search(r"(\d+) deletions?", stat_line)

                if files_match:
                    stats["files_changed"] += int(files_match.group(1))
                if ins_match:
                    stats["insertions"] += int(ins_match.group(1))
                if del_match:
                    stats["deletions"] += int(del_match.group(1))

        except subprocess.CalledProcessError:
            pass

    return stats


def count_prs(start: datetime, end: datetime) -> dict:
    """PR 통계 수집 (gh CLI 사용)"""
    stats = {
        "created": 0,
        "merged": 0,
        "reviewed": 0,
        "prs": [],
    }

    try:
        # 내가 만든 PR
        result = subprocess.run(
            [
                "gh", "pr", "list",
                "--author", "@me",
                "--state", "all",
                "--json", "number,title,state,createdAt,mergedAt,url"
            ],
            capture_output=True, text=True, check=True
        )

        prs = json.loads(result.stdout)
        for pr in prs:
            created_at = pr.get("createdAt", "")
            if created_at:
                created_date = datetime.fromisoformat(created_at.replace("Z", "+00:00"))
                if start <= created_date.replace(tzinfo=None) <= end:
                    stats["created"] += 1
                    stats["prs"].append({
                        "number": pr["number"],
                        "title": pr["title"],
                        "state": pr["state"],
                        "url": pr["url"]
                    })

            merged_at = pr.get("mergedAt", "")
            if merged_at:
                merged_date = datetime.fromisoformat(merged_at.replace("Z", "+00:00"))
                if start <= merged_date.replace(tzinfo=None) <= end:
                    stats["merged"] += 1

        # 내가 리뷰한 PR (최근 것만)
        review_result = subprocess.run(
            [
                "gh", "pr", "list",
                "--search", "reviewed-by:@me",
                "--state", "all",
                "--json", "number,createdAt",
                "--limit", "50"
            ],
            capture_output=True, text=True
        )

        if review_result.returncode == 0:
            reviews = json.loads(review_result.stdout)
            for review in reviews:
                created_at = review.get("createdAt", "")
                if created_at:
                    created_date = datetime.fromisoformat(created_at.replace("Z", "+00:00"))
                    if start <= created_date.replace(tzinfo=None) <= end:
                        stats["reviewed"] += 1

    except (subprocess.CalledProcessError, json.JSONDecodeError, FileNotFoundError):
        pass

    return stats


def count_claude_sessions(start: datetime, end: datetime) -> dict:
    """Claude 세션 통계 수집"""
    stats = {
        "total_sessions": 0,
        "projects": {},
        "tools_used": {},
    }

    if not CLAUDE_PROJECTS_PATH.exists():
        return stats

    for project_dir in CLAUDE_PROJECTS_PATH.iterdir():
        if not project_dir.is_dir():
            continue

        project_name = project_dir.name.split("-")[-1]

        for session_file in project_dir.glob("*.jsonl"):
            mtime = datetime.fromtimestamp(session_file.stat().st_mtime)
            if not (start <= mtime <= end):
                continue

            stats["total_sessions"] += 1
            stats["projects"][project_name] = stats["projects"].get(project_name, 0) + 1

            # 도구 사용 통계
            try:
                with open(session_file, "r", encoding="utf-8") as f:
                    for line in f:
                        if not line.strip():
                            continue
                        try:
                            entry = json.loads(line)
                            if entry.get("type") == "tool_use":
                                tool = entry.get("name", "unknown")
                                stats["tools_used"][tool] = stats["tools_used"].get(tool, 0) + 1
                        except json.JSONDecodeError:
                            pass
            except Exception:
                pass

    return stats


def count_cron_jobs(start: datetime, end: datetime) -> dict:
    """Cron 작업 실행 통계"""
    stats = {
        "total_runs": 0,
        "success": 0,
        "failed": 0,
        "jobs": {},
    }

    history_file = Path(__file__).parent.parent / "dashboard" / "logs" / "history.json"

    if not history_file.exists():
        return stats

    try:
        with open(history_file, "r", encoding="utf-8") as f:
            history = json.load(f)

        for entry in history:
            start_time = entry.get("startTime", "")
            if not start_time:
                continue

            try:
                entry_date = datetime.fromisoformat(start_time.replace("Z", "+00:00"))
                entry_date = entry_date.replace(tzinfo=None)
            except ValueError:
                continue

            if not (start <= entry_date <= end):
                continue

            stats["total_runs"] += 1
            status = entry.get("status", "")
            if status == "success":
                stats["success"] += 1
            elif status == "failed":
                stats["failed"] += 1

            job_name = entry.get("jobName", "Unknown")
            if job_name not in stats["jobs"]:
                stats["jobs"][job_name] = {"success": 0, "failed": 0}
            if status == "success":
                stats["jobs"][job_name]["success"] += 1
            elif status == "failed":
                stats["jobs"][job_name]["failed"] += 1

    except (json.JSONDecodeError, IOError):
        pass

    return stats


def build_report(
    period: str,
    start: datetime,
    end: datetime,
    daily_stats: dict,
    git_stats: dict,
    pr_stats: dict,
    claude_stats: dict,
    cron_stats: dict
) -> str:
    """리포트 마크다운 생성"""
    period_name = {"daily": "일간", "weekly": "주간", "monthly": "월간"}[period]
    date_range = f"{start.strftime('%Y-%m-%d')} ~ {end.strftime('%Y-%m-%d')}"

    lines = [
        f"# {period_name} 생산성 리포트",
        "",
        f"> 기간: {date_range}",
        f"> 생성일: {datetime.now().strftime('%Y-%m-%d %H:%M')}",
        "",
        "---",
        "",
        "## 요약",
        "",
        "| 항목 | 수치 |",
        "|------|------|",
        f"| Daily Note | {daily_stats['total_notes']}개 |",
        f"| 완료 태스크 | {daily_stats['total_tasks_done']}개 |",
        f"| Git 커밋 | {git_stats['total_commits']}개 |",
        f"| PR 생성 | {pr_stats['created']}개 |",
        f"| PR 머지 | {pr_stats['merged']}개 |",
        f"| Claude 세션 | {claude_stats['total_sessions']}개 |",
        f"| Cron 작업 | {cron_stats['total_runs']}회 (성공률 {cron_stats['success']}/{cron_stats['total_runs'] or 1}회) |",
        "",
    ]

    # Git 상세
    if git_stats["total_commits"] > 0:
        lines.extend([
            "## Git 활동",
            "",
            f"- 총 커밋: {git_stats['total_commits']}개",
            f"- 변경 파일: {git_stats['files_changed']}개",
            f"- 추가: +{git_stats['insertions']} / 삭제: -{git_stats['deletions']}",
            "",
            "### 저장소별",
            "",
        ])
        for repo, count in sorted(git_stats["repos"].items(), key=lambda x: x[1], reverse=True):
            lines.append(f"- {repo}: {count}개")
        lines.append("")

    # PR 상세
    if pr_stats["created"] > 0 or pr_stats["merged"] > 0:
        lines.extend([
            "## PR 활동",
            "",
            f"- 생성: {pr_stats['created']}개",
            f"- 머지: {pr_stats['merged']}개",
            f"- 리뷰: {pr_stats['reviewed']}개",
            "",
        ])
        if pr_stats["prs"]:
            lines.append("### 생성한 PR")
            lines.append("")
            for pr in pr_stats["prs"][:5]:
                state_emoji = "🔀" if pr["state"] == "MERGED" else ("❌" if pr["state"] == "CLOSED" else "🟡")
                lines.append(f"- {state_emoji} [#{pr['number']}]({pr['url']}) {pr['title']}")
            lines.append("")

    # Claude 세션 상세
    if claude_stats["total_sessions"] > 0:
        lines.extend([
            "## Claude Code 활동",
            "",
            f"- 총 세션: {claude_stats['total_sessions']}개",
            "",
            "### 프로젝트별",
            "",
        ])
        for project, count in sorted(claude_stats["projects"].items(), key=lambda x: x[1], reverse=True):
            lines.append(f"- {project}: {count}개")
        lines.append("")

        if claude_stats["tools_used"]:
            lines.append("### 도구 사용 TOP 5")
            lines.append("")
            top_tools = sorted(claude_stats["tools_used"].items(), key=lambda x: x[1], reverse=True)[:5]
            for tool, count in top_tools:
                lines.append(f"- {tool}: {count}회")
            lines.append("")

    # 학습 토픽
    if daily_stats["learning_topics"]:
        lines.extend([
            "## 학습 토픽",
            "",
        ])
        for topic, count in daily_stats["learning_topics"][:10]:
            lines.append(f"- #{topic} ({count})")
        lines.append("")

    return "\n".join(lines)


def get_report_path(period: str, base_date: datetime) -> Path:
    """리포트 저장 경로"""
    vault_path = Path(CONFIG.get("vault", {}).get("path", "")).expanduser()
    reports_folder = vault_path / "reports"
    reports_folder.mkdir(parents=True, exist_ok=True)

    if period == "daily":
        filename = f"{base_date.strftime('%Y-%m-%d')}_daily.md"
    elif period == "weekly":
        week_num = base_date.isocalendar()[1]
        filename = f"{base_date.strftime('%Y')}-W{week_num:02d}_weekly.md"
    else:
        filename = f"{base_date.strftime('%Y-%m')}_monthly.md"

    return reports_folder / filename


def save_report(content: str, path: Path) -> str:
    """리포트 저장"""
    with open(path, "w", encoding="utf-8") as f:
        f.write(content)
    return str(path)


def send_slack_notification(report: str, period: str) -> bool:
    """Slack으로 알림 전송"""
    webhook_url = os.environ.get("SLACK_WEBHOOK_URL")

    if not webhook_url:
        print("⚠️  SLACK_WEBHOOK_URL 환경변수가 설정되지 않았습니다.")
        return False

    period_name = {"daily": "일간", "weekly": "주간", "monthly": "월간"}[period]

    # 요약 부분만 추출
    summary_match = re.search(r"## 요약\n\n(.*?)\n\n##", report, re.DOTALL)
    summary = summary_match.group(1) if summary_match else "리포트 생성 완료"

    blocks = [
        {
            "type": "header",
            "text": {
                "type": "plain_text",
                "text": f"📊 {period_name} 생산성 리포트",
                "emoji": True
            }
        },
        {
            "type": "section",
            "text": {
                "type": "mrkdwn",
                "text": summary.replace("|", "\\|")
            }
        }
    ]

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


def print_summary(report: str):
    """콘솔에 요약 출력"""
    print("\n" + "━" * 50)
    print(report[:1500])
    if len(report) > 1500:
        print("\n... (이하 생략)")
    print("━" * 50)


def main():
    # 옵션 파싱
    args = sys.argv[1:]

    period = "weekly"
    base_date = datetime.now()
    yes_mode = False
    slack_mode = False

    i = 0
    while i < len(args):
        arg = args[i]
        if arg == "--period" and i + 1 < len(args):
            period = args[i + 1].lower()
            i += 2
        elif arg == "--date" and i + 1 < len(args):
            base_date = datetime.strptime(args[i + 1], "%Y-%m-%d")
            i += 2
        elif arg in ("--yes", "-y"):
            yes_mode = True
            i += 1
        elif arg == "--slack":
            slack_mode = True
            i += 1
        else:
            i += 1

    period_name = {"daily": "일간", "weekly": "주간", "monthly": "월간"}.get(period, period)

    print("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")
    print(f"📊 Productivity Report: {period_name}")
    print("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")

    # 날짜 범위 계산
    start, end = get_date_range(period, base_date)
    print(f"   기간: {start.strftime('%Y-%m-%d')} ~ {end.strftime('%Y-%m-%d')}")
    print("")

    # 데이터 수집
    print("📡 데이터 수집 중...")

    print("   Daily Notes 분석 중...")
    daily_stats = count_daily_notes(start, end)

    print("   Git 커밋 분석 중...")
    git_stats = count_git_commits(start, end)

    print("   PR 분석 중...")
    pr_stats = count_prs(start, end)

    print("   Claude 세션 분석 중...")
    claude_stats = count_claude_sessions(start, end)

    print("   Cron 작업 분석 중...")
    cron_stats = count_cron_jobs(start, end)

    # 리포트 생성
    report = build_report(period, start, end, daily_stats, git_stats, pr_stats, claude_stats, cron_stats)

    # 출력
    print_summary(report)

    # 저장
    report_path = get_report_path(period, base_date)

    if yes_mode:
        choice = "y"
    else:
        try:
            choice = input(f"\n리포트를 저장할까요? [{report_path.name}] [Y/n]: ").strip().lower()
        except EOFError:
            choice = "y"

    if choice in ["", "y", "yes"]:
        result_path = save_report(report, report_path)
        print(f"\n✅ 리포트 저장 완료!")
        print(f"   {result_path}")
    else:
        print("\n⏭️  건너뛰었습니다.")

    # Slack 알림
    if slack_mode:
        print("\n📤 Slack 알림 전송 중...")
        if send_slack_notification(report, period):
            print("✅ Slack 알림 전송 완료!")
        else:
            print("❌ Slack 알림 전송 실패")


if __name__ == "__main__":
    main()
