#!/usr/bin/env python3
"""
AI Pipeline - JIRA Activity Sync
=================================
JIRA 활동(이슈, 코멘트, 상태 변경)을 수집하여 Daily Note에 추가

Usage:
    python sync_jira.py           # 어제 활동
    python sync_jira.py --today   # 오늘 활동
    python sync_jira.py 2026-01-15  # 특정 날짜

Requirements:
    - JIRA_API_TOKEN 환경변수 (API 토큰)
    - JIRA_EMAIL 환경변수 (Atlassian 이메일)
    - config/settings.yaml에 jira 설정
"""

import base64
import json
import os
import re
import sys
import urllib.request
import urllib.error
from datetime import datetime, timedelta
from pathlib import Path
from typing import Optional

import yaml

CONFIG_PATH = Path(__file__).parent.parent / "config" / "settings.yaml"


def load_config() -> dict:
    # 설정 파일 우선순위
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


def get_jira_config() -> dict:
    """JIRA 설정 조회"""
    sync_config = CONFIG.get("sync", {})
    jira_config = sync_config.get("jira", {})

    if not jira_config.get("enabled", False):
        print("⚠️  JIRA sync가 비활성화되어 있습니다.")
        print("   config/settings.local.yaml에서 sync.jira.enabled: true로 설정하세요.")
        sys.exit(0)

    return jira_config


def get_jira_credentials() -> tuple[str, str, str]:
    """JIRA 인증 정보 조회"""
    jira_config = get_jira_config()

    server = jira_config.get("server", "")
    email = os.environ.get("JIRA_EMAIL", "")
    api_token = os.environ.get("JIRA_API_TOKEN", "")

    if not server:
        print("❌ JIRA 서버 URL이 설정되지 않았습니다.")
        print("   config/settings.local.yaml의 sync.jira.server를 설정하세요.")
        sys.exit(1)

    if not email or not api_token:
        print("❌ JIRA 인증 정보가 없습니다.")
        print("   환경변수를 설정하세요:")
        print("   export JIRA_EMAIL='your-email@company.com'")
        print("   export JIRA_API_TOKEN='your-api-token'")
        print("")
        print("   API 토큰 발급: https://id.atlassian.com/manage-profile/security/api-tokens")
        sys.exit(1)

    return server, email, api_token


def jira_request(endpoint: str, server: str, email: str, token: str) -> Optional[dict]:
    """JIRA API 요청"""
    url = f"{server.rstrip('/')}/rest/api/3/{endpoint}"

    # Basic Auth 헤더
    credentials = base64.b64encode(f"{email}:{token}".encode()).decode()
    headers = {
        "Authorization": f"Basic {credentials}",
        "Content-Type": "application/json",
        "Accept": "application/json",
    }

    try:
        request = urllib.request.Request(url, headers=headers)
        with urllib.request.urlopen(request, timeout=30) as response:
            return json.loads(response.read().decode())
    except urllib.error.HTTPError as e:
        if e.code == 401:
            print("❌ JIRA 인증 실패. API 토큰을 확인하세요.")
        elif e.code == 403:
            print("❌ JIRA 접근 권한이 없습니다.")
        else:
            print(f"⚠️  JIRA API 오류: {e.code} {e.reason}")
        return None
    except urllib.error.URLError as e:
        print(f"⚠️  JIRA 서버 연결 실패: {e.reason}")
        return None


def get_my_issues(server: str, email: str, token: str, project: str, target_date: str) -> list[dict]:
    """내가 담당하거나 업데이트한 이슈 조회"""
    # JQL: 해당 날짜에 업데이트된 내 이슈들
    jql = (
        f"project = {project} AND "
        f"(assignee = currentUser() OR reporter = currentUser()) AND "
        f"updated >= '{target_date}' AND updated < '{target_date}' + 1d"
    )

    endpoint = f"search?jql={urllib.parse.quote(jql)}&fields=key,summary,status,assignee,priority,updated,comment"

    result = jira_request(endpoint, server, email, token)
    if not result:
        return []

    issues = []
    for issue in result.get("issues", []):
        fields = issue.get("fields", {})
        status = fields.get("status", {}).get("name", "")
        priority = fields.get("priority", {})

        issues.append({
            "key": issue.get("key", ""),
            "summary": fields.get("summary", ""),
            "status": status,
            "priority": priority.get("name", "") if priority else "",
            "url": f"{server}/browse/{issue.get('key', '')}",
        })

    return issues


def get_my_comments(server: str, email: str, token: str, project: str, target_date: str) -> list[dict]:
    """내가 작성한 코멘트 조회"""
    # JQL: 해당 프로젝트의 이슈들 (코멘트 필터링은 후처리)
    jql = f"project = {project} AND updated >= '{target_date}' AND updated < '{target_date}' + 1d"

    endpoint = f"search?jql={urllib.parse.quote(jql)}&fields=key,summary,comment&expand=changelog"

    result = jira_request(endpoint, server, email, token)
    if not result:
        return []

    comments = []
    my_email = os.environ.get("JIRA_EMAIL", "").lower()

    for issue in result.get("issues", []):
        issue_key = issue.get("key", "")
        issue_summary = issue.get("fields", {}).get("summary", "")

        # 코멘트 확인
        comment_data = issue.get("fields", {}).get("comment", {})
        for comment in comment_data.get("comments", []):
            author_email = comment.get("author", {}).get("emailAddress", "").lower()
            created = comment.get("created", "")

            # 해당 날짜에 내가 작성한 코멘트
            if author_email == my_email and created.startswith(target_date):
                body = comment.get("body", {})
                # Atlassian Document Format → plain text
                text = extract_text_from_adf(body) if isinstance(body, dict) else str(body)

                comments.append({
                    "issue_key": issue_key,
                    "issue_summary": issue_summary,
                    "body": text[:150],
                    "created": created,
                })

    return comments


def extract_text_from_adf(adf: dict) -> str:
    """Atlassian Document Format에서 텍스트 추출"""
    if not isinstance(adf, dict):
        return str(adf)

    texts = []

    def extract(node):
        if isinstance(node, dict):
            if node.get("type") == "text":
                texts.append(node.get("text", ""))
            for child in node.get("content", []):
                extract(child)
        elif isinstance(node, list):
            for item in node:
                extract(item)

    extract(adf)
    return " ".join(texts).strip()


def get_status_changes(server: str, email: str, token: str, project: str, target_date: str) -> list[dict]:
    """내가 변경한 이슈 상태 조회"""
    jql = f"project = {project} AND status changed BY currentUser() DURING ('{target_date}', '{target_date}' + 1d)"

    endpoint = f"search?jql={urllib.parse.quote(jql)}&fields=key,summary,status&expand=changelog"

    result = jira_request(endpoint, server, email, token)
    if not result:
        return []

    changes = []
    for issue in result.get("issues", []):
        issue_key = issue.get("key", "")
        issue_summary = issue.get("fields", {}).get("summary", "")
        current_status = issue.get("fields", {}).get("status", {}).get("name", "")

        # changelog에서 상태 변경 찾기
        changelog = issue.get("changelog", {})
        for history in changelog.get("histories", []):
            created = history.get("created", "")
            if not created.startswith(target_date):
                continue

            for item in history.get("items", []):
                if item.get("field") == "status":
                    changes.append({
                        "issue_key": issue_key,
                        "issue_summary": issue_summary,
                        "from_status": item.get("fromString", ""),
                        "to_status": item.get("toString", ""),
                    })

    return changes


def build_jira_section(issues: list, comments: list, changes: list, server: str) -> str:
    """JIRA 활동 섹션 생성"""
    lines = ["\n## 📋 JIRA 활동"]

    # 담당 이슈
    if issues:
        lines.append("\n### 담당 이슈")
        for issue in issues:
            status_emoji = {
                "Done": "✅",
                "In Progress": "🔄",
                "To Do": "📌",
                "In Review": "👀",
            }.get(issue["status"], "📝")
            priority_badge = f"`{issue['priority']}`" if issue.get("priority") else ""
            lines.append(
                f"- {status_emoji} [{issue['key']}]({issue['url']}) {issue['summary']} {priority_badge}"
            )

    # 상태 변경
    if changes:
        lines.append("\n### 상태 변경")
        for change in changes:
            lines.append(
                f"- [{change['issue_key']}]({server}/browse/{change['issue_key']}) "
                f"`{change['from_status']}` → `{change['to_status']}`"
            )

    # 코멘트
    if comments:
        lines.append("\n### 코멘트")
        for comment in comments[:5]:  # 최대 5개
            lines.append(
                f"- [{comment['issue_key']}]({server}/browse/{comment['issue_key']}) {comment['issue_summary']}"
            )
            if comment.get("body"):
                lines.append(f"  - {comment['body'][:100]}...")

    if len(lines) == 1:
        lines.append("\n_활동 내역이 없습니다._")

    lines.append("")
    return "\n".join(lines)


def get_daily_note_path(target_date: str) -> Path:
    """Daily Note 경로"""
    vault_path = Path(CONFIG["vault"]["path"]).expanduser()
    daily_folder = CONFIG["vault"].get("daily_folder", "DAILY")
    return vault_path / daily_folder / f"{target_date}.md"


def update_daily_note(target_date: str, jira_section: str) -> str:
    """Daily Note에 JIRA 섹션 추가"""
    daily_path = get_daily_note_path(target_date)

    if not daily_path.exists():
        print(f"⚠️  {target_date} Daily Note가 없습니다.")
        print("   먼저 daily-init 을 실행하세요.")
        return ""

    with open(daily_path, "r", encoding="utf-8") as f:
        content = f.read()

    # 기존 JIRA 섹션이 있으면 교체
    if "## 📋 JIRA 활동" in content:
        pattern = r"## 📋 JIRA 활동.*?(?=\n## |\Z)"
        content = re.sub(pattern, jira_section.strip(), content, flags=re.DOTALL)
    else:
        # GitHub 섹션 뒤에 추가, 없으면 "오늘 한 일" 앞에
        if "## 🐙 GitHub 활동" in content:
            # GitHub 섹션 찾아서 그 뒤에 추가
            pattern = r"(## 🐙 GitHub 활동.*?)(\n## )"
            content = re.sub(
                pattern,
                rf"\1{jira_section}\2",
                content,
                flags=re.DOTALL,
                count=1
            )
        elif "## ✅ 오늘 한 일" in content:
            content = content.replace(
                "## ✅ 오늘 한 일", f"{jira_section}\n## ✅ 오늘 한 일"
            )
        else:
            content = content.rstrip() + "\n" + jira_section

    with open(daily_path, "w", encoding="utf-8") as f:
        f.write(content)

    return str(daily_path)


# urllib.parse import
import urllib.parse


def main():
    # 옵션 파싱
    yes_mode = "--yes" in sys.argv or "-y" in sys.argv
    args = [a for a in sys.argv[1:] if a not in ("--yes", "-y")]

    target_date = None
    override_project = None

    i = 0
    while i < len(args):
        arg = args[i]
        if arg == "--today":
            target_date = datetime.now().strftime("%Y-%m-%d")
            i += 1
        elif arg == "--project" and i + 1 < len(args):
            override_project = args[i + 1].strip()
            i += 2
        elif not arg.startswith("-"):
            target_date = arg
            i += 1
        else:
            i += 1

    # 기본값: 어제
    if not target_date:
        target_date = (datetime.now() - timedelta(days=1)).strftime("%Y-%m-%d")

    print("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")
    print(f"📋 JIRA Sync: {target_date}")
    print("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")

    # JIRA 설정 및 인증
    jira_config = get_jira_config()
    server, email, token = get_jira_credentials()
    project = override_project or jira_config.get("project", "")

    if not project:
        print("❌ JIRA 프로젝트가 설정되지 않았습니다.")
        print("   --project 옵션 또는 config/settings.local.yaml의 sync.jira.project를 설정하세요.")
        sys.exit(1)

    print(f"   Server: {server}")
    print(f"   Project: {project}")

    # 데이터 수집
    print("\n📡 활동 수집 중...")
    issues = get_my_issues(server, email, token, project, target_date)
    comments = get_my_comments(server, email, token, project, target_date)
    changes = get_status_changes(server, email, token, project, target_date)

    print(f"   📌 담당 이슈: {len(issues)}")
    print(f"   🔄 상태 변경: {len(changes)}")
    print(f"   💬 코멘트: {len(comments)}")

    if not any([issues, comments, changes]):
        print(f"\n📭 {target_date}에 JIRA 활동이 없습니다.")
        return

    # JIRA 섹션 생성
    jira_section = build_jira_section(issues, comments, changes, server)

    # 미리보기
    print("\n" + "━" * 40)
    print("📋 미리보기")
    print("━" * 40)
    print(jira_section)
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
        result_path = update_daily_note(target_date, jira_section)
        if result_path:
            print(f"\n✅ Daily Note 업데이트 완료!")
            print(f"   {result_path}")
    else:
        print("\n⏭️  건너뛰었습니다.")


if __name__ == "__main__":
    main()
