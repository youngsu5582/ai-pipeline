#!/usr/bin/env python3
"""
AI Pipeline - Claude Session Summary
=====================================
오늘 Claude Code 세션의 학습 내용을 요약하여 Daily Note에 기록

Usage:
    python claude_session_summary.py                       # 오늘 세션
    python claude_session_summary.py --date 2026-01-30     # 특정 날짜 세션
    python claude_session_summary.py --projects "proj1,proj2"  # 특정 프로젝트만
    python claude_session_summary.py --yes                 # Daily Note에 자동 추가

Options:
    --date DATE          특정 날짜의 세션 조회 (YYYY-MM-DD)
    --projects PROJ,...  쉼표로 구분된 프로젝트 이름 필터
    --yes                확인 없이 Daily Note에 추가
    --slack              Slack 알림 전송

Requirements:
    - config/settings.yaml에 vault 설정
"""

import json
import os
import re
import sys
from datetime import datetime
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


def find_today_sessions(target_date: str, project_filter: list[str] = None) -> list[Path]:
    """특정 날짜의 세션 파일 찾기

    Args:
        target_date: 조회할 날짜 (YYYY-MM-DD)
        project_filter: 특정 프로젝트 이름 필터 (None이면 전체)
    """
    sessions = []

    if not CLAUDE_PROJECTS_PATH.exists():
        return sessions

    # projects 디렉토리 아래의 모든 .jsonl 파일 검색
    for project_dir in CLAUDE_PROJECTS_PATH.iterdir():
        if not project_dir.is_dir():
            continue

        # 프로젝트 필터링
        if project_filter:
            project_name = project_dir.name.split("-")[-1]  # 마지막 부분이 프로젝트명
            if not any(p.lower() in project_name.lower() for p in project_filter):
                continue

        for session_file in project_dir.glob("*.jsonl"):
            # 파일 수정일 확인
            mtime = datetime.fromtimestamp(session_file.stat().st_mtime)
            if mtime.strftime("%Y-%m-%d") == target_date:
                sessions.append(session_file)

    return sessions


def parse_session_file(session_path: Path) -> dict:
    """세션 파일 파싱하여 주요 정보 추출"""
    result = {
        "project": "",
        "files_changed": set(),
        "tools_used": set(),
        "topics": [],
        "summary_points": [],
    }

    # 프로젝트 이름 추출 (디렉토리명에서)
    project_dir = session_path.parent.name
    # -Users-xxx-Desktop-devk-aicreation 형태에서 프로젝트명 추출
    parts = project_dir.split("-")
    if len(parts) > 1:
        result["project"] = parts[-1]  # 마지막 부분이 프로젝트명

    try:
        with open(session_path, "r", encoding="utf-8") as f:
            for line in f:
                if not line.strip():
                    continue

                try:
                    entry = json.loads(line)
                except json.JSONDecodeError:
                    continue

                # 메시지 타입 확인
                msg_type = entry.get("type", "")

                # 도구 사용 추출
                if msg_type == "tool_use":
                    tool_name = entry.get("name", "")
                    if tool_name:
                        result["tools_used"].add(tool_name)

                    # 파일 변경 추출
                    tool_input = entry.get("input", {})
                    if isinstance(tool_input, dict):
                        file_path = tool_input.get("file_path", "")
                        if file_path:
                            # 파일명만 추출
                            result["files_changed"].add(Path(file_path).name)

                # 어시스턴트 응답에서 키워드 추출
                if msg_type == "assistant":
                    content = entry.get("content", "")
                    if isinstance(content, str):
                        # 학습 관련 키워드 추출
                        keywords = extract_learning_keywords(content)
                        result["topics"].extend(keywords)

    except Exception as e:
        print(f"⚠️  세션 파일 파싱 실패: {session_path.name} - {e}")

    # 중복 제거
    result["files_changed"] = list(result["files_changed"])
    result["tools_used"] = list(result["tools_used"])
    result["topics"] = list(set(result["topics"]))[:10]  # 최대 10개

    return result


def extract_learning_keywords(text: str) -> list[str]:
    """텍스트에서 학습 관련 키워드 추출"""
    keywords = []

    # 기술 키워드 패턴
    tech_patterns = [
        r'\b(Spring Boot|JPA|Hibernate|Kafka|Redis|PostgreSQL|MySQL)\b',
        r'\b(Docker|Kubernetes|AWS|Lambda|S3|EC2)\b',
        r'\b(React|Vue|TypeScript|JavaScript|Node\.js)\b',
        r'\b(REST|GraphQL|gRPC|WebSocket)\b',
        r'\b(Git|GitHub|CI/CD|Jenkins|GitHub Actions)\b',
        r'\b(테스트|단위 테스트|통합 테스트|E2E)\b',
        r'\b(리팩토링|클린 코드|디자인 패턴)\b',
    ]

    for pattern in tech_patterns:
        matches = re.findall(pattern, text, re.IGNORECASE)
        keywords.extend(matches)

    return keywords


def build_session_summary(sessions_data: list[dict]) -> str:
    """세션 요약 섹션 생성"""
    lines = ["\n## 🤖 Claude 세션 요약"]

    if not sessions_data:
        lines.append("\n_오늘 Claude Code 세션이 없습니다._")
        lines.append("")
        return "\n".join(lines)

    # 전체 통계
    all_files = set()
    all_tools = set()
    all_topics = set()
    projects = set()

    for data in sessions_data:
        all_files.update(data.get("files_changed", []))
        all_tools.update(data.get("tools_used", []))
        all_topics.update(data.get("topics", []))
        if data.get("project"):
            projects.add(data["project"])

    lines.append(f"\n세션 수: {len(sessions_data)}개")

    # 프로젝트
    if projects:
        lines.append(f"\n### 작업 프로젝트")
        for project in sorted(projects):
            lines.append(f"- {project}")

    # 변경된 파일
    if all_files:
        lines.append(f"\n### 변경된 파일 ({len(all_files)}개)")
        for file in sorted(all_files)[:15]:  # 최대 15개
            lines.append(f"- `{file}`")
        if len(all_files) > 15:
            lines.append(f"- _...외 {len(all_files) - 15}개_")

    # 사용된 도구
    if all_tools:
        lines.append(f"\n### 사용된 도구")
        # 주요 도구만 표시
        main_tools = ["Read", "Write", "Edit", "Bash", "Grep", "Glob", "Task"]
        used_main_tools = [t for t in all_tools if t in main_tools]
        if used_main_tools:
            lines.append(f"- {', '.join(sorted(used_main_tools))}")

    # 학습 토픽
    if all_topics:
        lines.append(f"\n### 오늘 다룬 주제")
        for topic in sorted(all_topics)[:10]:
            lines.append(f"- {topic}")

    lines.append("")
    return "\n".join(lines)


def get_daily_note_path(target_date: str) -> Path:
    """Daily Note 경로"""
    vault_path = Path(CONFIG["vault"]["path"]).expanduser()
    daily_folder = CONFIG["vault"].get("daily_folder", "DAILY")
    return vault_path / daily_folder / f"{target_date}.md"


def update_daily_note(target_date: str, session_section: str) -> str:
    """Daily Note에 세션 요약 섹션 추가"""
    daily_path = get_daily_note_path(target_date)

    if not daily_path.exists():
        print(f"⚠️  {target_date} Daily Note가 없습니다.")
        print("   먼저 daily.py --init 을 실행하세요.")
        return ""

    with open(daily_path, "r", encoding="utf-8") as f:
        content = f.read()

    # 기존 Claude 세션 섹션이 있으면 교체
    if "## 🤖 Claude 세션 요약" in content:
        pattern = r"## 🤖 Claude 세션 요약.*?(?=\n## |\Z)"
        content = re.sub(pattern, session_section.strip(), content, flags=re.DOTALL)
    else:
        # 오늘 한 일 섹션 앞에 추가
        if "## ✅ 오늘 한 일" in content:
            content = content.replace(
                "## ✅ 오늘 한 일", f"{session_section}\n## ✅ 오늘 한 일"
            )
        else:
            content = content.rstrip() + "\n" + session_section

    with open(daily_path, "w", encoding="utf-8") as f:
        f.write(content)

    return str(daily_path)


def print_summary(sessions_data: list[dict]):
    """콘솔에 요약 출력"""
    print("\n" + "━" * 50)
    print("🤖 Claude 세션 요약")
    print("━" * 50)

    if not sessions_data:
        print("오늘 Claude Code 세션이 없습니다.")
        return

    print(f"세션 수: {len(sessions_data)}개")

    all_files = set()
    all_topics = set()
    projects = set()

    for data in sessions_data:
        all_files.update(data.get("files_changed", []))
        all_topics.update(data.get("topics", []))
        if data.get("project"):
            projects.add(data["project"])

    if projects:
        print(f"\n프로젝트: {', '.join(projects)}")

    if all_files:
        print(f"\n변경된 파일: {len(all_files)}개")
        for file in sorted(all_files)[:10]:
            print(f"  - {file}")

    if all_topics:
        print(f"\n다룬 주제: {', '.join(sorted(all_topics)[:5])}")

    print("\n" + "━" * 50)


def main():
    # 옵션 파싱
    args = sys.argv[1:]

    yes_mode = False
    slack_mode = False
    target_date = datetime.now().strftime("%Y-%m-%d")  # 기본: 오늘
    project_filter = None

    i = 0
    while i < len(args):
        arg = args[i]
        if arg in ("--yes", "-y"):
            yes_mode = True
            i += 1
        elif arg == "--slack":
            slack_mode = True
            i += 1
        elif arg == "--date" and i + 1 < len(args):
            target_date = args[i + 1]
            i += 2
        elif arg == "--projects" and i + 1 < len(args):
            project_filter = [p.strip() for p in args[i + 1].split(",") if p.strip()]
            i += 2
        else:
            i += 1

    print("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")
    print(f"🤖 Claude Session Summary: {target_date}")
    print("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")
    if project_filter:
        print(f"   프로젝트 필터: {', '.join(project_filter)}")

    # 세션 찾기
    print("\n📡 세션 검색 중...")
    session_files = find_today_sessions(target_date, project_filter)
    print(f"   발견된 세션: {len(session_files)}개")

    # 세션 파싱
    sessions_data = []
    for session_file in session_files:
        print(f"   📄 파싱 중: {session_file.name[:30]}...")
        data = parse_session_file(session_file)
        if data.get("files_changed") or data.get("topics"):
            sessions_data.append(data)

    # 콘솔 출력
    print_summary(sessions_data)

    # 세션 요약 생성
    session_section = build_session_summary(sessions_data)

    # 미리보기
    print("\n📋 Daily Note 미리보기")
    print("━" * 40)
    print(session_section)
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
        result_path = update_daily_note(target_date, session_section)
        if result_path:
            print(f"\n✅ Daily Note 업데이트 완료!")
            print(f"   {result_path}")
    else:
        print("\n⏭️  건너뛰었습니다.")


if __name__ == "__main__":
    main()
